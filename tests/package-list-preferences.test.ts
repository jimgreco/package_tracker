import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PACKAGE_LIST,
  PACKAGE_FILTERS,
  packageListKey,
  readPackageList,
  writePackageList,
} from "../lib/package-list-preferences";

function memoryStorage() {
  const records = new Map<string, string>();
  return {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => {
      records.set(key, value);
    },
    removeItem: (key: string) => {
      records.delete(key);
    },
  };
}
test("list preferences survive reload for every filter and preserve literal search", () => {
  const storage = memoryStorage(),
    key = packageListKey("stable-user-id", "home");
  for (const filter of PACKAGE_FILTERS) {
    const expected = { filter, search: "  FedEx SH-12.*  " };
    writePackageList(storage, key, expected);
    assert.deepEqual(readPackageList(storage, key), expected);
  }
});
test("account and household scopes never share search or filter", () => {
  const storage = memoryStorage(),
    key = packageListKey("stable-user-id", "home");
  writePackageList(storage, key, {
    filter: "Dismissed",
    search: "private query",
  });
  assert.deepEqual(
    readPackageList(storage, packageListKey("other-user-id", "home")),
    DEFAULT_PACKAGE_LIST,
  );
  assert.deepEqual(
    readPackageList(storage, packageListKey("stable-user-id", "other")),
    DEFAULT_PACKAGE_LIST,
  );
  assert.notEqual(packageListKey("another-stable-id", "home"), key);
  assert.notEqual(packageListKey("a:b", "c"), packageListKey("a", "b:c"));
  assert.equal(packageListKey("", "home"), null);
  assert.equal(packageListKey(undefined, "home"), null);
  assert.equal(packageListKey("stable-user-id", ""), null);
});
test("reset removes only the active scope and is safe to repeat", () => {
  const storage = memoryStorage(),
    key = packageListKey("stable-user-id", "home");
  const other = packageListKey("stable-user-id", "other");
  const value = { filter: "To collect", search: "coffee" } as const;
  writePackageList(storage, key, value);
  writePackageList(storage, other, value);
  writePackageList(storage, key, DEFAULT_PACKAGE_LIST);
  writePackageList(storage, key, DEFAULT_PACKAGE_LIST);
  assert.equal(storage.getItem(key!), null);
  assert.deepEqual(readPackageList(storage, key), DEFAULT_PACKAGE_LIST);
  assert.deepEqual(readPackageList(storage, other), value);
});
test("invalid, old-version and missing storage fail to safe defaults", () => {
  const storage = memoryStorage(),
    key = "test";
  for (const raw of [
    "{",
    "null",
    "[]",
    "4",
    '{"version":2,"filter":"Dismissed","search":"stale"}',
  ]) {
    storage.setItem(key, raw);
    assert.deepEqual(readPackageList(storage, key), DEFAULT_PACKAGE_LIST);
  }
  storage.setItem(
    key,
    JSON.stringify({ version: 1, filter: "Deleted", search: 8 }),
  );
  assert.deepEqual(readPackageList(storage, key), DEFAULT_PACKAGE_LIST);
  assert.deepEqual(readPackageList(null, key), DEFAULT_PACKAGE_LIST);
  writePackageList(null, key, DEFAULT_PACKAGE_LIST);
});
test("storage exceptions leave searching usable and never leak a fallback scope", () => {
  const denied = {
    getItem: () => {
      throw Error("denied");
    },
    setItem: () => {
      throw Error("full");
    },
    removeItem: () => {
      throw Error("denied");
    },
  };
  assert.deepEqual(readPackageList(denied, "scope"), DEFAULT_PACKAGE_LIST);
  writePackageList(denied, "scope", { filter: "Delivered", search: "coffee" });
  writePackageList(denied, "scope", DEFAULT_PACKAGE_LIST);
  assert.deepEqual(readPackageList(denied, null), DEFAULT_PACKAGE_LIST);
});
test("stored query length is bounded and unrelated record fields are not returned", () => {
  const storage = memoryStorage();
  storage.setItem(
    "scope",
    JSON.stringify({
      version: 1,
      filter: "Delivered",
      search: "x".repeat(500),
      extra: "not preferences",
    }),
  );
  assert.deepEqual(readPackageList(storage, "scope"), {
    filter: "Delivered",
    search: "x".repeat(256),
  });
});
