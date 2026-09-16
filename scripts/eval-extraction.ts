// Explicit opt-in live evaluation. Uses synthetic emails, calls OpenAI, and writes no app data.
// Run with production credentials only in the private server environment:
// node --import tsx scripts/eval-extraction.ts
import assert from "node:assert/strict";
import { extractPackageDetails } from "../lib/email";

const cases: [string, string, boolean][] = [
  [
    "Cloud subscription",
    "Receipt from Apple. iCloud+ with 2 TB (Monthly), renewed today. Order CLOUD123.",
    false,
  ],
  [
    "Google plans",
    "Your order receipt: Google Health Premium, Google Home Premium and 100 GB Google One. Your subscriptions renew monthly. Order PLAN123.",
    false,
  ],
  [
    "Digital movies",
    "Your receipt from Apple. Home Alone, movie purchase. Star Trek collection, iTunes digital download. Watch now in the Apple TV app. Order MOVIE123.",
    false,
  ],
  [
    "Cinema tickets",
    "Order CINEMA123 confirmed. Two adult movie tickets, reserved seats M21 and M22. Show this QR code at the theatre entrance.",
    false,
  ],
  [
    "Theatre tickets",
    "Order THEATRE123 confirmed. Your digital theatre tickets are attached. Stalls row C seats 9 and 10. Download to your phone.",
    false,
  ],
  [
    "Online tax package",
    "Your Schedule K-1 package is ready. Log in to the investor portal to view and download your Form 1065 and state tax documents.",
    false,
  ],
  [
    "Flight receipt",
    "Your flight booking AIR123 is confirmed. Electronic ticket for London to New York. Check in online before departure.",
    false,
  ],
  [
    "Hardware without tracking",
    "Thanks for your order DEVICE123 from Apple. Your iPad will ship to your home once ready. We will email a tracking number later.",
    true,
  ],
  [
    "Physical subscription",
    "Your recurring coffee order COFFEE123 from Roaster is confirmed. Three bags of coffee will be shipped to your home next week.",
    true,
  ],
  [
    "Carrier only",
    "UPS: Your package TRACK123 is out for delivery today. No signature is required.",
    true,
  ],
  [
    "Physical movie",
    "Your Home Alone Blu-ray disc order DISC123 from Movie Shop will ship to your home tomorrow.",
    true,
  ],
  [
    "Mixed purchase",
    "Your order MIX123 from Apple: iPad, shipping to your home next week; iCloud+ monthly subscription, activated immediately. No tracking number yet.",
    true,
  ],
];
let failed = 0;
for (let i = 0; i < cases.length; i += 3) {
  await Promise.all(
    cases.slice(i, i + 3).map(async ([name, text, expected]) => {
      try {
        const result = await extractPackageDetails(
          {
            subject: name,
            sender: "receipt@example.invalid",
            receivedAt: "2026-09-16T12:00:00Z",
            messageDate: "2026-09-01T12:00:00Z",
            text,
            links: [],
            images: [],
          },
          "America/New_York",
        );
        const shipments = result.orders
          .flatMap((o) => o.shipments)
          .filter((s) => s.physicalDelivery);
        assert.equal(result.relevant && shipments.length > 0, expected);
        if (name === "Mixed purchase") {
          assert.ok(
            !JSON.stringify(
              result.orders.flatMap((o) => [
                ...o.items,
                ...o.shipments.flatMap((s) => s.items),
              ]),
            )
              .toLowerCase()
              .includes("icloud"),
          );
        }
        console.log(`PASS ${name}`);
      } catch (e) {
        failed++;
        console.log(
          `FAIL ${name}: ${e instanceof Error ? e.message : "extraction failed"}`,
        );
      }
    }),
  );
}
console.log(
  `${cases.length - failed}/${cases.length} live extraction cases passed.`,
);
if (failed) process.exitCode = 1;
