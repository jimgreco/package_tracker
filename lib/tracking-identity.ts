export const fedexCarrierPattern =
  /^fedex(?:\s+(?:ground|express|home delivery))?$/i;

export function trackingCarrier(carrier: string | null) {
  const value = carrier?.trim() || null;
  return value && fedexCarrierPattern.test(value) ? "FedEx" : value;
}

// CDL embeds the package's tracking code in this link, even when the email
// never prints it separately. Only use the selected, source-backed package URL.
export function trackingCodeFromLink(
  links: string[],
  trackingUrl: string | null,
) {
  if (!trackingUrl || !links.includes(trackingUrl)) return null;
  try {
    const url = new URL(trackingUrl);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "apps.cdldelivers.com" ||
      url.pathname !== "/Tracking-Page/track" ||
      url.username ||
      url.password ||
      url.searchParams.getAll("id").length !== 1
    )
      return null;
    const code = url.searchParams.get("id");
    return code && /^CDL[A-Z0-9]{1,197}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

// Amazon's order-page shipmentId identifies a retailer package, not a carrier tracker.
// Keep it for matching later emails; never send it to a tracking provider.
export function retailerReference(
  links: string[],
  trackingUrl?: string | null,
) {
  const candidates =
    trackingUrl && links.includes(trackingUrl) ? [trackingUrl] : links;
  const refs = new Set<string>();
  for (const link of candidates) {
    try {
      const u = new URL(link);
      if (u.hostname !== "amazon.com" && !u.hostname.endsWith(".amazon.com"))
        continue;
      const id = u.searchParams.get("shipmentId");
      if (id && /^[a-z0-9_-]{1,200}$/i.test(id)) refs.add(`amazon:${id}`);
    } catch {
      /* Invalid source links provide no identity evidence. */
    }
  }
  return refs.size === 1 ? [...refs][0] : null;
}
