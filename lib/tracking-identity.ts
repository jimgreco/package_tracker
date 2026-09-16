export const fedexCarrierPattern =
  /^fedex(?:\s+(?:ground|express|home delivery))?$/i;

export function trackingCarrier(carrier: string | null) {
  const value = carrier?.trim() || null;
  return value && fedexCarrierPattern.test(value) ? "FedEx" : value;
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
