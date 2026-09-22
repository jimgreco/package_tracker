// Formatting tolerance only: never use edit distance on order identifiers.
// Adjacent numbers often represent different purchases. Preserve every letter
// and digit (including leading zeroes), and retain unfamiliar punctuation.
export function orderNumberKey(value: string | null): string | null {
  if (!value) return null;
  const key = value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/^order\s*(?:(?:number|no\.?|id)\s*[:#]?\s*|[:#]\s*|\s+)/, "")
    .replace(/^[#\s]+/, "")
    .replace(/[\s\p{Dash_Punctuation}._/]+/gu, "");
  return /[\p{L}\p{N}]/u.test(key) ? key : null;
}

// A retailer may add a one-letter prefix in its fulfillment system. Require
// independent corroboration: same purchase date and at least one exact item.
export function corroboratedOrderPrefix(
  incoming: {
    number: string | null;
    date: string | null;
    items: { name: string }[];
  },
  candidate: {
    number: string | null;
    date: string | null;
    items: { name: string }[];
  },
): boolean {
  const a = orderNumberKey(incoming.number);
  const b = orderNumberKey(candidate.number);
  if (!a || !b || !incoming.date || incoming.date !== candidate.date)
    return false;
  const prefixVariant = (x: string, y: string) =>
    /^\d{5,}$/.test(x) && /^[a-z]\d{5,}$/.test(y) && y.slice(1) === x;
  if (!prefixVariant(a, b) && !prefixVariant(b, a)) return false;
  const itemKey = (name: string) =>
    name
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, "");
  const names = new Set(
    incoming.items
      .map((item) => itemKey(item.name))
      .filter((name) => name.length >= 5),
  );
  return candidate.items.some((item) => names.has(itemKey(item.name)));
}
