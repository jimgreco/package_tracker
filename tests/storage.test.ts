import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import dns from "node:dns/promises";
import https from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { safeImageDownload } from "../lib/storage";

test("image downloads stop at a total deadline even when bytes keep arriving", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dnsMock = t.mock.method(dns, "lookup", async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  syncBuiltinESMExports();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const response = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headers: { "content-type": "image/png" },
    resume() {},
  });
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let resetIdle = () => {};
  let destroyed = false;
  const requestEvents = new EventEmitter();
  const request = Object.assign(requestEvents, {
    setTimeout(ms: number, callback: () => void) {
      resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(callback, ms);
      };
      resetIdle();
      return this;
    },
    destroy(error?: Error) {
      destroyed = true;
      clearTimeout(idleTimer);
      if (error) requestEvents.emit("error", error);
      requestEvents.emit("close");
      return this;
    },
  });
  t.mock.method(https, "get", ((
    _url: URL,
    _options: unknown,
    callback: (response: IncomingMessage) => void,
  ) => {
    callback(response as unknown as IncomingMessage);
    started();
    return request as unknown as ClientRequest;
  }) as typeof https.get);
  const downloading = safeImageDownload(
    "https://image.example.invalid/parcel.png",
  );
  // Observe the rejection immediately to avoid an unhandled promise during timer ticks.
  const outcome = downloading.then(
    () => undefined,
    (error: Error) => error,
  );
  try {
    await ready;
    for (let i = 0; i < 3; i++) {
      t.mock.timers.tick(3_999);
      response.emit("data", Buffer.from([1]));
      resetIdle(); // Data activity keeps the socket inactivity timer from firing.
    }
    t.mock.timers.tick(4);
    assert.equal(
      destroyed,
      true,
      "Slow continuous responses must not hold the worker indefinitely",
    );
    assert.match((await outcome)?.message || "", /timed out/);
  } finally {
    response.emit("end");
    request.destroy();
    await outcome;
    dnsMock.mock.restore();
    syncBuiltinESMExports();
  }
});
