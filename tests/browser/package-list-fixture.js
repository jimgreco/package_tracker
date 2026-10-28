async page => {
  const today = new Date().toISOString().slice(0, 10);
  const stamp = `${today}T12:00:00Z`;
  const shipment = (id, merchant, fields = {}) => ({
    id, orderId: `order-${id}`, merchant, orderNumber: `ORDER-${id}`, orderedAt: today,
    items: [{ name: "Cotton woven throw", quantity: 2, imageUrl: null }], note: null,
    carrier: "FedEx", trackingNumber: `TEST-${id}`, trackingUrl: null, status: "in_transit",
    shippedAt: stamp, estimate: { kind: "date", start: today, end: null, timeZone: "UTC", label: null },
    deliveredAt: null, collectedAt: null, collectedByName: null, attentionReasons: [],
    createdAt: stamp, timelineAt: stamp, firstEmailAt: null, dismissedAt: null,
    snoozedAt: null, archivedAt: null, updatedAt: stamp, statusAt: stamp,
    lastCheckedAt: stamp, trackingState: "none", needsReview: false, reviewReason: null,
    manualOverride: false, isDemo: true, ...fields,
  });
  const fixture = {
    shipments: [
      shipment("moving", "Schoolhouse", { note: "For the guest room", orderNumber: "SH-20916" }),
      shipment("delivered", "Cometeer", {
        carrier: "CDL", status: "delivered", deliveredAt: stamp,
        items: [{ name: "House blend coffee capsules", quantity: 1, imageUrl: null }],
      }),
      shipment("delayed", "Muji", {
        carrier: "UPS", status: "delayed", estimate: null, attentionReasons: ["Synthetic carrier delay"],
        items: [{ name: "Notebook", quantity: 3, imageUrl: null }],
      }),
      shipment("snoozed", "Snoozed shop", { carrier: "DHL", snoozedAt: stamp }),
      shipment("dismissed", "Dismissed shop", { dismissedAt: stamp }),
    ],
    emails: [],
    settings: {
      plan: "free", isAdmin: false, householdName: "Synthetic search household", timeZone: "UTC",
      forwardingAddress: null, calendarFeedUrl: "https://example.test/synthetic.ics", demo: false,
      services: { openai: false, easypost: false, postmark: false, google: false, storage: false, gmail: false },
      google: { connected: false, calendarId: null, lastSyncedAt: null, error: null },
      gmail: { connected: false, email: null, enabled: false, needsReconnect: false, lastSyncedAt: null,
        importedCount: 0, importing: false, error: null, otherHouseholdName: null },
      worker: { lastSeenAt: stamp, failedJobs: 0 }, userName: "Sample member",
      account: { id: "synthetic-user", email: "sample@example.test" }, householdId: "synthetic-household", role: "owner",
      households: [{id: "synthetic-household", name: "Home", role: "owner"}, {id: "other-household", name: "Other home", role: "owner"}], members: [],
    },
  };
  let household = "synthetic-household";
  const writes = [];
  const households = new Map();
  const packagesFor = id => {
    if (!households.has(id)) households.set(id, structuredClone(fixture.shipments));
    return households.get(id);
  };
  page.__collectionQueue = [];
  page.__packageFixtures = households;
  const auth = { expired: false };
  page.__preferenceAuth = auth;
  page.__dashboardQueue = [];
  // Keep the app's actual poll callback, but trigger it explicitly in tests.
  // Pausing the entire browser clock also freezes click actionability checks.
  await page.addInitScript(() => {
    const original = window.setInterval.bind(window);
    window.__porchTestPolls = new Map();
    window.setInterval = (callback, delay, ...args) => {
      if (delay !== 30000 || typeof callback !== 'function') return original(callback, delay, ...args);
      const id = original(() => {}, delay);
      window.__porchTestPolls.set(id, () => callback(...args));
      return id;
    };
    const clear = window.clearInterval.bind(window);
    window.clearInterval = id => { window.__porchTestPolls.delete(id); clear(id); };
  });
  page.__preferenceWrites = writes;
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://127.0.0.1:4328") return route.abort();
    if (url.pathname === "/api/dashboard") {
      if (auth.expired) return route.fulfill({ status: 401, json: {error: "Your session expired."} });
      const params = new URL(page.url()).searchParams;
      const account = params.get("fixture-account") || "sample@example.test";
      const email = params.get("fixture-email") || account;
      const payload = { ...fixture, shipments: structuredClone(packagesFor(household)), settings: { ...fixture.settings,
        householdId: household, householdName: household === "synthetic-household" ? "Home" : "Other home", account: {id: account === "sample@example.test" ? "synthetic-user" : "other-user", email} } };
      const delayed = page.__dashboardQueue.shift();
      if (delayed) {
        delayed.started = true;
        return new Promise((resolve, reject) => {
          delayed.release = (status = 200) => route.fulfill({status,
            json: status === 200 ? payload : {error: `Synthetic dashboard failure ${status}`}
          }).then(resolve, reject);
        });
      }
      return route.fulfill({ json: payload });
    }
    if (url.pathname === "/api/auth/config") return route.fulfill({json: {google: false}});
    if (url.pathname === "/api/auth/logout") {
      writes.push(url.pathname);
      auth.expired = true;
      return route.fulfill({json: {ok: true}});
    }
    if (url.pathname === "/api/settings/household-switch") {
      writes.push(url.pathname);
      household = route.request().postDataJSON().householdId;
      return route.fulfill({json: {ok: true}});
    }
    const packagePath = url.pathname.match(/^\/api\/shipments\/([^/]+)(?:\/(collect|uncollect))?$/);
    if (packagePath) {
      const target = packagesFor(household).find(s => s.id === packagePath[1]);
      if (!target) return route.fulfill({status:404, json:{error:"Package not found."}});
      if (!packagePath[2] && route.request().method() === "GET") {
        return route.fulfill({json:{shipment:target, events:[], emails:[]}});
      }
      if (packagePath[2] && route.request().method() === "POST") {
        writes.push(url.pathname);
        const respond = status => {
          if (status !== 200) return route.fulfill({status, json:{error:"Synthetic collection failure. Please try again."}});
          if (target.status !== "delivered" || target.dismissedAt) {
            return route.fulfill({status:400, json:{error:"Only delivered, visible packages can be marked collected."}});
          }
          target.collectedAt = packagePath[2] === "collect" ? stamp : null;
          target.collectedByName = target.collectedAt ? "Sample member" : null;
          target.updatedAt = new Date().toISOString();
          return route.fulfill({json:{ok:true}});
        };
        const delayed = page.__collectionQueue.shift();
        if (delayed) {
          delayed.started = true;
          return new Promise((resolve, reject) => {
            delayed.release = (status = 200) => respond(status).then(resolve, reject);
          });
        }
        return respond(200);
      }
    }
    if (url.pathname.startsWith("/api/")) {
      return route.fulfill({ status: 404, json: { error: "No live API in synthetic preview" } });
    }
    return route.continue();
  });
  await page.goto("http://127.0.0.1:4328");
}
