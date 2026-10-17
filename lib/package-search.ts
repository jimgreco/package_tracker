import type { Shipment } from "./types";

type SearchablePackage = Pick<
  Shipment,
  "merchant" | "carrier" | "note" | "orderNumber" | "trackingNumber" | "items"
>;

export function matchesPackageSearch(
  shipment: SearchablePackage,
  search: string,
) {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  const fields = [
    shipment.merchant,
    shipment.carrier ?? "",
    shipment.note ?? "",
    shipment.orderNumber ?? "",
    shipment.trackingNumber ?? "",
    ...shipment.items.map((item) => item.name),
  ].map((value) => value.toLowerCase());

  // Each word can match a different detail, without depending on field order.
  return terms.every((term) => fields.some((value) => value.includes(term)));
}
