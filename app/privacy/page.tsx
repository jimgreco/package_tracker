import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy policy · PorchPong",
  description:
    "How PorchPong uses your account, package, email, and calendar data.",
};

export default function PrivacyPage() {
  return (
    <main className="privacy-page">
      <a href="/">← Back to PorchPong</a>
      <h1>Privacy policy</h1>
      <p className="privacy-updated">Last updated September 20, 2026</p>
      <p>
        PorchPong is a household package tracker operated by Jim Greco. It turns
        emails you forward or choose to import from Gmail into a shared delivery
        timeline and optional calendar updates.
      </p>

      <h2>Information PorchPong receives</h2>
      <p>
        Google sign-in provides your Google account identifier, verified email
        address, and name. PorchPong uses these to create your account, sign you
        in, and identify household memberships. PorchPong does not receive your
        Google password. Signing in does not grant Gmail access; importing from
        Gmail requires a separate, optional connection.
      </p>
      <p>
        Forwarded emails may include sender and recipient addresses, message
        bodies, order details, delivery addresses, tracking numbers, links, and
        images. PorchPong stores the forwarded source messages, supported
        images, extracted package details, tracking history, and changes you
        make.
      </p>

      <h2>How the information is used and shared</h2>
      <p>
        Postmark receives and delivers forwarded emails to PorchPong. OpenAI
        receives email text, links, and image references to extract order and
        shipping information. For eligible accounts, EasyPost receives tracking
        numbers and carrier information to retrieve delivery updates. AWS hosts
        PorchPong and its database, and Cloudflare handles website traffic and
        domain services. Google Fonts serves the website fonts. These services
        receive the data needed to provide their part of PorchPong.
      </p>
      <p>
        Package information, forwarded or Gmail-imported messages, and images
        are shared with other members of your PorchPong household. Household
        owners manage membership. A private calendar feed link gives anyone
        holding that link access to its delivery events, so share it only with
        people or calendar services you want to have access.
      </p>

      <h2>Optional Gmail import</h2>
      <p>
        When you connect Gmail, Google grants read-only access to your mailbox.
        This permission covers the entire mailbox; Google does not offer a
        shipping-email-only permission. PorchPong searches for likely order and
        shipping messages and downloads matching email bodies, headers, links,
        and image references. These matching source messages are saved in your
        household and sent to OpenAI for package extraction. Filtering can
        occasionally match an unrelated message or miss a shipment.
      </p>
      <p>
        Each household member connects their own Google account and chooses
        whether to start with new mail or include the previous 30 days. The
        connection remains tied to that household when you switch households.
        PorchPong checks approximately every five minutes, using an encrypted
        refresh token, and does not send, modify, delete, or mark Gmail messages
        as read. Removing a member also removes their Gmail connection to that
        household.
      </p>
      <p>
        Pause stops new imports; resuming catches up from the previous check.
        Disconnect removes PorchPong&apos;s stored Gmail credentials and stops
        future imports. Previously imported messages and packages remain in the
        household. You can revoke Google permissions in your Google account;
        revoking PorchPong&apos;s Google access may also disconnect its Calendar
        integration. Contact us to request deletion of imported data.
      </p>

      <h2>Optional iPhone notifications</h2>
      <p>
        If you enable notifications, PorchPong stores your Apple push device
        token with your sign-in session and your preferences for each household.
        Apple receives the device token, a general delivery message, and package
        and household identifiers used to open the app. Alerts do not include
        merchant names, item names, tracking numbers, or email contents.
        Notification delivery records are retained for up to 30 days. You can
        disable alerts in PorchPong Settings or iPhone Settings. Signing out
        removes the server device registration when session revocation succeeds.
      </p>
      <p>
        Marking a package collected records the household member’s name and the
        collection time for other household members. Undoing collection clears
        the current record; the action remains in the package’s household
        history.
      </p>
      <h2>Google Calendar</h2>
      <p>
        Connecting Google Calendar is optional and separate from signing in.
        PorchPong requests permission to create calendars and manage the
        calendars and events it creates. It creates a Package Deliveries
        calendar and sends package details, tracking links, delivery dates, and
        delivery times to Google to keep those events up to date. It does not
        request access to your unrelated calendars.
      </p>
      <p>
        PorchPong stores an encrypted Google refresh token for background
        calendar updates. Disconnecting Google Calendar in PorchPong removes the
        stored connection credentials; the calendar already created in Google
        remains in your account. You can also revoke access through your Google
        account settings.
      </p>
      <p>
        PorchPong uses Google user data only to provide its account, package
        import, and calendar features. It does not sell that data, use it for
        advertising, or use it to train general-purpose AI models.
        PorchPong&apos;s use and transfer of information received from Google
        APIs follows the{" "}
        <a href="https://developers.google.com/terms/api-services-user-data-policy">
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements.
      </p>

      <h2>Storage and your choices</h2>
      <p>
        PorchPong uses session cookies to keep you signed in and protect sign-in
        requests. Hosting services may keep technical request and error logs.
        Forwarded and imported messages and package history are retained to
        support your timeline and are not automatically removed when a package
        is delivered. Stop forwarding emails at any time, pause or disconnect
        Gmail, disconnect optional calendar access, or contact Jim Greco to
        request account or household data deletion.
      </p>
      <p>
        For privacy questions or deletion requests, email{" "}
        <a href="mailto:jgreco@gmail.com">jgreco@gmail.com</a>. Changes to this
        policy will be posted here with an updated date.
      </p>
    </main>
  );
}
