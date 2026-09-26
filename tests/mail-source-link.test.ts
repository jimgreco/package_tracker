import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appleMailSourceUrl,
  gmailAccountByKey,
  gmailSourceUrl,
} from "../lib/mail-source-link";
import { hash } from "../lib/security";

test("Gmail source links stay on Gmail and use the original account", () => {
  const subject = "google-subject";
  const messageKey = `gmail:${hash(subject)}:19abc123`;
  const accounts = gmailAccountByKey([
    { google_subject: subject, email: "owner@example.com" },
  ]);
  const old = gmailSourceUrl(
    { source: "Gmail", message_key: messageKey },
    accounts,
  );
  assert.equal(
    old,
    "https://mail.google.com/mail/?authuser=owner%40example.com#all/19abc123",
  );
  const current = gmailSourceUrl({
    source: "Gmail",
    message_key: messageKey,
    gmail_account_email: "connected@example.com",
    rfc822_message_id: "<purchase+1@example.org>",
  });
  assert.equal(
    current,
    "https://mail.google.com/mail/?authuser=connected%40example.com#search/rfc822msgid%3Apurchase%2B1%40example.org",
  );
  assert.equal(
    gmailSourceUrl({ source: "Forwarded email", message_key: messageKey }),
    null,
  );
  assert.equal(
    gmailSourceUrl({ source: "Gmail", message_key: "gmail:bad" }),
    null,
  );
});

test("Apple Mail links use RFC Message-ID only, for Gmail and forwarded mail", () => {
  const source = {
    source: "Gmail",
    rfc822_message_id: "<purchase+1@example.org>",
  };
  assert.equal(
    appleMailSourceUrl(source),
    "message://%3Cpurchase%2B1%40example.org%3E",
  );
  assert.equal(
    appleMailSourceUrl({ ...source, source: "Forwarded email" }),
    "message://%3Cpurchase%2B1%40example.org%3E",
  );
  assert.equal(
    appleMailSourceUrl({ ...source, rfc822_message_id: null }),
    null,
  );
  assert.equal(
    appleMailSourceUrl({
      ...source,
      rfc822_message_id: "bad\r\nHeader: value",
    }),
    null,
  );
  assert.equal(appleMailSourceUrl({ ...source, source: "Pasted text" }), null);
});
