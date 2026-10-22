async page => {
  const search = page.getByRole("searchbox", {name: "Search packages"});
  const button = name => page.getByRole("button", {name, exact: true});
  const check = (ok, message) => { if (!ok) throw Error(message); };
  const selected = async name => check(await button(name).getAttribute("aria-pressed") === "true", `${name} selected`);
  const expectQuery = async value => {
    await search.waitFor();
    for (let attempt=0; attempt<20 && await search.inputValue() !== value; attempt++) await page.waitForTimeout(100);
    check(await search.inputValue() === value, `Expected query ${value}`);
  };
  await button("To collect").click();
  await search.fill("CDL coffee");
  await page.reload();
  await expectQuery("CDL coffee");
  await selected("To collect");
  check(await page.locator(".shipment-list h3").allTextContents().then(x => x.join() === "Cometeer"), "Restored filtered results");
  await page.screenshot({path:"output/playwright/preferences-desktop.png",fullPage:true});

  await page.goto("http://127.0.0.1:4328/?fixture-email=updated@example.test");
  await expectQuery("CDL coffee");
  await selected("To collect");

  // A new authenticated account on the same browser must not inherit this query.
  await page.goto("http://127.0.0.1:4328/?fixture-account=other@example.test");
  await expectQuery("");
  await selected("On the way");
  await button("Dismissed").click();
  await search.fill("Dismissed");
  await page.goto("http://127.0.0.1:4328/");
  await expectQuery("CDL coffee");
  await selected("To collect");
  check(page.__preferenceWrites.length === 0, "Preferences never write to package APIs");

  // Exercise the actual household switch and reload path without a page remount.
  await page.getByRole("button", {name: "Household settings"}).click();
  await page.getByLabel("Current household").selectOption("other-household");
  await page.getByRole("button", {name: "Packages", exact:true}).click();
  await expectQuery("");
  await selected("On the way");
  await button("All packages").click();
  await search.fill("Schoolhouse");
  await page.getByRole("button", {name: "Household settings"}).click();
  await page.getByLabel("Current household").selectOption("synthetic-household");
  await page.getByRole("button", {name: "Packages", exact:true}).click();
  await expectQuery("CDL coffee");
  await selected("To collect");

  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:"output/playwright/preferences-mobile.png",fullPage:true});
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No mobile overflow");
  await search.fill("No matches");
  await page.getByRole("heading", {name:"No matching packages",exact:true}).waitFor();
  await page.screenshot({path:"output/playwright/preferences-empty-mobile.png",fullPage:true});
  await button("Clear search").click();
  await selected("To collect");
  await page.reload();
  await expectQuery("");
  await selected("To collect");
  await button("Reset list").click();
  await selected("On the way");
  check(await button("Reset list").isDisabled(), "Reset is safe to repeat");
  await page.reload();
  await expectQuery("");
  await selected("On the way");
  check(await button("Reset list").isDisabled(), "Reset survives reload");
  await page.screenshot({path:"output/playwright/preferences-reset-mobile.png",fullPage:true});

  // An expired session removes the old scope and cannot be dismissed back to the list.
  await button("To collect").click();
  await search.fill("CDL coffee");
  page.__preferenceAuth.expired = true;
  await page.evaluate(() => { for (const poll of window.__porchTestPolls.values()) poll(); });
  await page.getByRole("heading", {name:"Welcome home."}).waitFor();
  check(await search.count() === 0, "Auth expiry removes old-account search");
  check(await button("Close dialog").count() === 0, "Auth expiry cannot dismiss back to old data");
  await page.screenshot({path:"output/playwright/preferences-expired-mobile.png",fullPage:true});
  page.__preferenceAuth.expired = false;
  await page.reload();
  await expectQuery("CDL coffee");
  await selected("To collect");
  await page.getByRole("button", {name:"Household settings"}).click();
  await button("Sign out").click();
  await page.getByRole("heading", {name:"Welcome home."}).waitFor();
  check(await search.count() === 0, "Sign-out removes old-account search");
  check(await button("Close dialog").count() === 0, "Sign-out cannot dismiss back to old data");
  page.__preferenceAuth.expired = false;
  await page.goto("http://127.0.0.1:4328/?fixture-account=other@example.test");
  await expectQuery("Dismissed");
  await selected("Dismissed");
  await page.goto("http://127.0.0.1:4328/");
  await expectQuery("CDL coffee");
  await selected("To collect");
  await button("Reset list").click();

  // Bad records and browser privacy restrictions are nonfatal.
  await page.evaluate(() => localStorage.setItem('porchpong.package-list.v1:["synthetic-user","synthetic-household"]', "{"));
  await page.reload();
  await expectQuery("");
  await selected("On the way");
  await page.addInitScript(() => Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Blocked", "SecurityError"); } }));
  await page.reload();
  await expectQuery("");
  await button("To collect").click();
  await search.fill("coffee");
  check(await page.locator(".shipment-list h3").allTextContents().then(x => x.join() === "Cometeer"), "Storage denial leaves filtering usable");
  await button("Reset list").click();
  await selected("On the way");
  check(page.__preferenceWrites.length === 3, "Only explicit synthetic household switches and sign-out wrote APIs");
  return {passed:true, scenarios:["reload", "stable ID survives email change", "auth expiry and reauthentication", "logout and account switch", "account isolation", "mounted household switch", "clear search preserves filter", "empty recovery", "reset and reload", "invalid storage", "blocked storage", "mobile layout"], syntheticWrites:page.__preferenceWrites};
}
