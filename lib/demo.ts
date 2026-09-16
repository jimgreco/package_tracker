import type { Shipment } from "./types";
export const DEMO_HOUSEHOLD = "00000000-0000-4000-8000-000000000001";
export const DEMO_USER = "00000000-0000-4000-8000-000000000002";
export function demoShipments(): Shipment[] {
  const date = (offset: number) => {
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
    }).format(new Date());
    const d = new Date(day + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  const iso = (offset: number) => `${date(offset)}T14:30:00.000Z`;
  const rows = [
    {
      merchant: "Patagonia",
      name: "Black Hole® Duffel 40L",
      carrier: "UPS",
      status: "out_for_delivery",
      eta: 0,
      ordered: -5,
      shipped: -2,
      number: "PTG-10482",
      track: "1Z-DEMO-10482",
      kind: "window",
    },
    {
      merchant: "Aesop",
      name: "Resurrection Aromatique Hand Wash",
      carrier: "FedEx",
      status: "in_transit",
      eta: 1,
      ordered: -6,
      shipped: -3,
      number: "AES-82931",
      track: "DEMO-782943100",
      kind: "date",
    },
    {
      merchant: "HAY",
      name: "Colour Crate · Medium",
      carrier: "UPS",
      status: "in_transit",
      eta: 3,
      ordered: -8,
      shipped: -4,
      number: "HAY-63017",
      track: "1Z-DEMO-63017",
      kind: "date_range",
    },
    {
      merchant: "Bookshop.org",
      name: "The Creative Act: A Way of Being",
      carrier: null,
      status: "ordered",
      eta: null,
      ordered: -4,
      shipped: -5,
      number: "BKS-38192",
      track: null,
      kind: "date",
    },
    {
      merchant: "Fellow",
      name: "Stagg EKG Electric Kettle",
      carrier: "FedEx",
      status: "delivered",
      eta: -1,
      ordered: -9,
      shipped: -6,
      number: "FLW-21904",
      track: "DEMO-782943200",
      kind: "date",
    },
    {
      merchant: "Nike",
      name: "Pegasus 41 · Sail / Black",
      carrier: "USPS",
      status: "delivered",
      eta: -3,
      ordered: -11,
      shipped: -8,
      number: "NK-592048",
      track: "DEMO-9400111200",
      kind: "date",
    },
  ];
  return rows.map((r, i) => ({
    id: `00000000-0000-4000-8001-${String(i + 1).padStart(12, "0")}`,
    orderId: `00000000-0000-4000-8002-${String(i + 1).padStart(12, "0")}`,
    merchant: r.merchant,
    orderNumber: r.number,
    orderedAt: date(r.ordered),
    items: [{ name: r.name, quantity: 1, imageUrl: null }],
    carrier: r.carrier,
    trackingNumber: r.track,
    trackingUrl: null,
    status: r.status as Shipment["status"],
    shippedAt: r.status === "ordered" ? null : iso(r.shipped),
    estimate:
      r.eta === null
        ? null
        : {
            kind: r.kind as "date",
            start:
              r.kind === "window" ? `${date(r.eta)}T14:00:00` : date(r.eta),
            end:
              r.kind === "window"
                ? `${date(r.eta)}T18:00:00`
                : r.kind === "date_range"
                  ? date(r.eta + 2)
                  : null,
            timeZone: "America/New_York",
            label: null,
          },
    deliveredAt: r.status === "delivered" ? iso(r.eta!) : null,
    createdAt: iso(r.shipped),
    timelineAt: iso(r.shipped),
    firstEmailAt: null,
    dismissedAt: null,
    archivedAt: null,
    updatedAt: iso(0),
    statusAt: iso(r.status === "delivered" ? r.eta! : 0),
    lastCheckedAt: r.carrier ? new Date().toISOString() : null,
    trackingState: r.carrier ? "active" : "none",
    needsReview: false,
    reviewReason: null,
    manualOverride: false,
    isDemo: true,
  }));
}
