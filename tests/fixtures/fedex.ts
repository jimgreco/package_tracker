// Synthetic response shaped from FedEx's Basic Integrated Visibility schema.
export function fedexFixture(trackingNumber = "123456789012", code = "OD") {
  return {
    output: {
      completeTrackResults: [
        {
          trackingNumber,
          trackResults: [
            {
              trackingNumberInfo: { trackingNumber },
              latestStatusDetail: {
                code,
                derivedCode: code,
                description: "Delivery update",
              },
              scanEvents: [
                {
                  date: "2026-09-16T08:00:00-04:00",
                  eventType: code,
                  eventDescription: "Delivery update",
                  scanLocation: {
                    city: "New York",
                    stateOrProvinceCode: "NY",
                    countryCode: "US",
                  },
                },
              ],
              dateAndTimes: [
                { type: "ESTIMATED_DELIVERY", dateTime: "2026-09-16T00:00:00" },
              ],
              estimatedDeliveryTimeWindow: {
                window: {
                  begins: "2026-09-16T10:00:00-04:00",
                  ends: "2026-09-16T14:00:00-04:00",
                },
              },
            },
          ],
        },
      ],
    },
  };
}
