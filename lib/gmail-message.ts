// Candidate search is performed by Gmail before any message bodies are downloaded.
// It intentionally favors purchase/shipping phrases over generic words like "sale".
export const shippingQuery =
  '{subject:order subject:shipment subject:shipped subject:delivery subject:delivered subject:tracking subject:package subject:dispatch subject:receipt "tracking number" "track your package" "track your order"} -in:spam -in:trash -in:sent -in:drafts';
export type GmailPart = {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
};
export type GmailMessage = {
  id: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: GmailPart;
};
export function header(part: GmailPart | undefined, name: string) {
  return (
    part?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())
      ?.value || ""
  );
}
export function bodyParts(part?: GmailPart, depth = 0): GmailPart[] {
  if (!part || depth > 15) return [];
  if (part.mimeType?.startsWith("multipart/"))
    return (part.parts || [])
      .slice(0, 50)
      .flatMap((p) => bodyParts(p, depth + 1));
  // Never import attached emails, documents, or calendar invitations.
  return !part.filename &&
    ["text/plain", "text/html"].includes(part.mimeType || "")
    ? [part]
    : [];
}
export function decodePart(part: GmailPart) {
  const bytes = Buffer.from(
    (part.body?.data || "").slice(0, 1_400_000),
    "base64url",
  );
  const charset =
    header(part, "content-type").match(/charset=["']?([^\s;"']+)/i)?.[1] ||
    "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}
export function decodeMessage(message: GmailMessage) {
  const parts = bodyParts(message.payload);
  const text = parts
    .filter((p) => p.mimeType === "text/plain")
    .map(decodePart)
    .join("\n")
    .slice(0, 100_000);
  const html = parts
    .filter((p) => p.mimeType === "text/html")
    .map(decodePart)
    .join("\n")
    .slice(0, 1_000_000);
  const date = header(message.payload, "date");
  return {
    from: header(message.payload, "from").slice(0, 500),
    subject:
      header(message.payload, "subject").slice(0, 1000) || "Shipping email",
    text,
    html,
    sentAt:
      date && Number.isFinite(Date.parse(date))
        ? date
        : new Date(Number(message.internalDate)).toISOString(),
  };
}
