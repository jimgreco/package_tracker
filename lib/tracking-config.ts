import { trackingCarrier } from "./tracking-identity";

export const isFedex = (carrier: string | null) =>
  trackingCarrier(carrier) === "FedEx";
export const fedexConfigured = () =>
  !!process.env.FEDEX_CLIENT_ID && !!process.env.FEDEX_CLIENT_SECRET;
export const trackingConfigured = (carrier: string | null) =>
  (isFedex(carrier) && fedexConfigured()) || !!process.env.EASYPOST_API_KEY;
