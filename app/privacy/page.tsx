import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy policy · Doorstep",
  description:
    "How Doorstep uses your account, package, email, and calendar data.",
};

export default function PrivacyPage() {
  return (
    <main className="privacy-page">
      <a href="/">← Back to Doorstep</a>
      <h1>Privacy policy</h1>
      <p className="privacy-updated">Last updated September 15, 2026</p>
      <p>
        Doorstep is a household package tracker operated by Jim Greco. It turns
        emails you choose to forward into a shared delivery timeline and
        optional calendar updates.
      </p>

      <h2>Information Doorstep receives</h2>
      <p>
        Google sign-in provides your Google account identifier, verified email
        address, and name. Doorstep uses these to create your account, sign you
        in, and identify household memberships. Doorstep does not receive your
        Google password or request access to your Gmail inbox.
      </p>
      <p>
        Forwarded emails may include sender and recipient addresses, message
        bodies, order details, delivery addresses, tracking numbers, links, and
        images. Doorstep stores the forwarded source messages, supported images,
        extracted package details, tracking history, and changes you make.
      </p>

      <h2>How the information is used and shared</h2>
      <p>
        Postmark receives and delivers forwarded emails to Doorstep. OpenAI
        receives email text, links, and image references to extract order and
        shipping information. EasyPost receives tracking numbers and carrier
        information to retrieve delivery updates. AWS hosts Doorstep and its
        database, and Cloudflare handles website traffic and domain services.
        Google Fonts serves the website fonts. These services receive the data
        needed to provide their part of Doorstep.
      </p>
      <p>
        Package information, forwarded messages, and images are shared with
        other members of your Doorstep household. Household owners manage
        membership. A private calendar feed link gives anyone holding that link
        access to its delivery events, so share it only with people or calendar
        services you want to have access.
      </p>

      <h2>Google Calendar</h2>
      <p>
        Connecting Google Calendar is optional and separate from signing in.
        Doorstep requests permission to create calendars and manage the
        calendars and events it creates. It creates a Package Deliveries
        calendar and sends package details, tracking links, delivery dates, and
        delivery times to Google to keep those events up to date. It does not
        request access to your unrelated calendars.
      </p>
      <p>
        Doorstep stores an encrypted Google refresh token for background
        calendar updates. Disconnecting Google Calendar in Doorstep removes the
        stored connection credentials; the calendar already created in Google
        remains in your account. You can also revoke access through your Google
        account settings.
      </p>
      <p>
        Doorstep uses Google user data only to provide its account and calendar
        features. It does not sell that data, use it for advertising, or use it
        to train general-purpose AI models. Doorstep&apos;s use and transfer of
        information received from Google APIs follows the{" "}
        <a href="https://developers.google.com/terms/api-services-user-data-policy">
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements.
      </p>

      <h2>Storage and your choices</h2>
      <p>
        Doorstep uses session cookies to keep you signed in and protect sign-in
        requests. Hosting services may keep technical request and error logs.
        Forwarded messages and package history are retained to support your
        timeline and are not automatically removed when a package is delivered.
        Stop forwarding emails at any time, disconnect optional calendar access,
        or contact Jim Greco to request account or household data deletion.
      </p>
      <p>
        For privacy questions or deletion requests, email{" "}
        <a href="mailto:doorstep@jim-greco.com">doorstep@jim-greco.com</a>.
        Changes to this policy will be posted here with an updated date.
      </p>
    </main>
  );
}
