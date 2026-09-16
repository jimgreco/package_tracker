import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bodyParts,
  decodeMessage,
  shippingQuery,
  type GmailMessage,
} from "../lib/gmail-message";
const data = (value: string) => Buffer.from(value).toString("base64url");
test("Gmail extracts nested alternatives, preserves shipping HTML, and ignores attached documents/emails", () => {
  const message: GmailMessage = {
    id: "m1",
    internalDate: "1789502400000",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Shipping <store@example.invalid>" },
        { name: "sUbJeCt", value: "Order shipped" },
      ],
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: data("Tracking ABC123") } },
            {
              mimeType: "text/html",
              body: {
                data: data(
                  '<img src="https://store.example/item.jpg"><a href="https://carrier.example/ABC123">Track</a>',
                ),
              },
            },
          ],
        },
        {
          mimeType: "text/plain",
          filename: "private.txt",
          body: { data: data("private attachment") },
        },
        {
          mimeType: "message/rfc822",
          parts: [
            { mimeType: "text/plain", body: { data: data("attached email") } },
          ],
        },
      ],
    },
  };
  assert.equal(bodyParts(message.payload).length, 2);
  const decoded = decodeMessage(message);
  assert.equal(decoded.subject, "Order shipped");
  assert.equal(decoded.text, "Tracking ABC123");
  assert.match(decoded.html, /item.jpg/);
  assert.equal(
    decoded.sentAt,
    new Date(Number(message.internalDate)).toISOString(),
  );
  assert.doesNotMatch(
    JSON.stringify(decoded),
    /private attachment|attached email/,
  );
});
test("Gmail handles body charset and bounds candidate search away from sent mail and spam", () => {
  const value = decodeMessage({
    id: "m2",
    internalDate: "1789502400000",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "Content-Type", value: "text/plain; charset=iso-8859-1" },
      ],
      body: { data: Buffer.from([99, 97, 102, 233]).toString("base64url") },
    },
  });
  assert.equal(value.text, "café");
  assert.match(shippingQuery, /-in:spam -in:trash -in:sent -in:drafts/);
  assert.match(shippingQuery, /subject:shipped/);
});
