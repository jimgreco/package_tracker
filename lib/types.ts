export const STATUSES = [
  "ordered",
  "pre_transit",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "available_for_pickup",
  "delayed",
  "failure",
  "return_to_sender",
  "cancelled",
  "unknown",
] as const;
export type Status = (typeof STATUSES)[number];
export const STATUS_LABEL: Record<Status, string> = {
  ordered: "Order placed",
  pre_transit: "Label created",
  in_transit: "On the way",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  available_for_pickup: "Ready for pickup",
  delayed: "Delayed",
  failure: "Delivery exception",
  return_to_sender: "Returning to sender",
  cancelled: "Cancelled",
  unknown: "Awaiting an update",
};
export type Estimate = {
  kind: "date" | "date_range" | "window" | "point" | "deadline";
  start: string;
  end: string | null;
  timeZone: string;
  label: string | null;
};
export type Item = { name: string; quantity: number; imageUrl: string | null };
export type Shipment = {
  id: string;
  orderId: string;
  merchant: string;
  orderNumber: string | null;
  orderedAt: string | null;
  items: Item[];
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  status: Status;
  shippedAt: string | null;
  estimate: Estimate | null;
  deliveredAt: string | null;
  collectedAt?: string | null;
  collectedByName?: string | null;
  attentionReasons?: string[];
  createdAt: string;
  timelineAt: string;
  firstEmailAt: string | null;
  dismissedAt: string | null;
  archivedAt: string | null;
  updatedAt: string;
  statusAt: string;
  lastCheckedAt: string | null;
  trackingState:
    "pending" | "active" | "unsupported" | "unconfigured" | "error" | "none";
  needsReview: boolean;
  reviewReason: string | null;
  manualOverride: boolean;
  isDemo: boolean;
};
export type TrackingEvent = {
  id: string;
  status: Status;
  message: string;
  location: string | null;
  occurredAt: string;
  source: string;
};
export type Email = {
  id: string;
  subject: string;
  from: string;
  receivedAt: string;
  sentAt: string | null;
  status: string;
  error: string | null;
  text?: string;
  extraction?: unknown;
};
export type Settings = {
  householdName: string;
  timeZone: string;
  forwardingAddress: string | null;
  calendarFeedUrl: string;
  demo: boolean;
  services: {
    openai: boolean;
    easypost: boolean;
    postmark: boolean;
    google: boolean;
    storage: boolean;
    gmail: boolean;
  };
  google: {
    connected: boolean;
    calendarId: string | null;
    lastSyncedAt: string | null;
    error: string | null;
  };
  gmail: {
    connected: boolean;
    email: string | null;
    enabled: boolean;
    needsReconnect: boolean;
    lastSyncedAt: string | null;
    importedCount: number;
    importing: boolean;
    error: string | null;
    otherHouseholdName: string | null;
  };
  worker: { lastSeenAt: string | null; failedJobs: number };
  userName: string;
  account: { email: string };
  householdId: string;
  role: "owner" | "member";
  households: { id: string; name: string; role: "owner" | "member" }[];
  members: {
    userId: string | null;
    name: string | null;
    email: string;
    role: "owner" | "member";
    pending: boolean;
  }[];
};
export type DashboardData = {
  shipments: Shipment[];
  emails: Email[];
  settings: Settings;
};
