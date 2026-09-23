import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Support · PorchPong",
  description: "Help with PorchPong accounts, forwarded emails, and packages.",
};

export default function SupportPage() {
  return (
    <main className="privacy-page">
      <a href="/">← Back to PorchPong</a>
      <h1>PorchPong support</h1>
      <p>
        Need help with an account, a missing package, or email forwarding? Email{" "}
        <a href="mailto:jgreco@gmail.com">jgreco@gmail.com</a> and describe what
        happened. Please do not include a password or full email contents.
      </p>
      <h2>Getting package updates</h2>
      <p>
        Sign in with Google, then copy your household forwarding address from
        PorchPong Settings. Forward order confirmations and shipping updates to
        that address. Updates can take a few minutes to appear. If one is
        missing, check that you forwarded it to the address for the household
        you are viewing.
      </p>
      <h2>Gmail and carrier tracking</h2>
      <p>
        Some accounts have administrator-enabled access to Gmail import and
        carrier API tracking. Gmail setup is available on the PorchPong website
        for eligible accounts. Other accounts continue to receive package
        updates through forwarded emails.
      </p>
      <h2>Account and data requests</h2>
      <p>
        Email us to request account or household data deletion. See the{" "}
        <a href="/privacy">privacy policy</a> for details about stored data and
        optional connections.
      </p>
    </main>
  );
}
