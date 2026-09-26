import { hash } from "./security";
import { query } from "./db";

type MailSource = {
  source?: unknown;
  message_key?: unknown;
  gmail_account_email?: string | null;
  rfc822_message_id?: string | null;
};

function messageId(source: MailSource) {
  const value = source.rfc822_message_id?.trim().replace(/^<|>$/g, "");
  return value && /^[^\s<>]{1,500}$/.test(value) ? value : null;
}

export function appleMailSourceUrl(source: MailSource) {
  if (source.source !== "Gmail" && source.source !== "Forwarded email")
    return null;
  const id = messageId(source);
  return id ? `message://${encodeURIComponent(`<${id}>`)}` : null;
}

export function gmailAccountByKey(
  connections: { google_subject: string; email: string }[],
) {
  return new Map(
    connections.map((connection) => [
      `gmail:${hash(connection.google_subject)}:`,
      connection.email,
    ]),
  );
}

export async function gmailAccountsFor(householdId: string) {
  const connections = await query(
    "SELECT google_subject,email FROM gmail_connections WHERE household_id=$1",
    [householdId],
  );
  return gmailAccountByKey(
    connections.map((connection) => ({
      google_subject: String(connection.google_subject),
      email: String(connection.email),
    })),
  );
}

export function gmailSourceUrl(
  source: MailSource,
  accounts = new Map<string, string>(),
) {
  if (source.source !== "Gmail" || typeof source.message_key !== "string")
    return null;
  const match = /^gmail:([a-f0-9]{64}):([A-Za-z0-9_-]{1,128})$/.exec(
    source.message_key,
  );
  if (!match) return null;

  const account =
    source.gmail_account_email || accounts.get(`gmail:${match[1]}:`);
  const url = new URL("https://mail.google.com/mail/");
  if (account) url.searchParams.set("authuser", account);

  const id = messageId(source);
  if (id) {
    url.hash = `search/${encodeURIComponent(`rfc822msgid:${id}`)}`;
  } else {
    // Older imports retain the Gmail API message ID but not the Message-ID header.
    url.hash = `all/${encodeURIComponent(match[2])}`;
  }
  return url.toString();
}
