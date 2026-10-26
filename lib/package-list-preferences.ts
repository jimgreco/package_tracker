export const PACKAGE_FILTERS = [
  "On the way",
  "Delivered",
  "To collect",
  "No estimate",
  "Dismissed",
  "All packages",
] as const;
export type PackageListPreferences = {
  filter: (typeof PACKAGE_FILTERS)[number];
  search: string;
};
export const DEFAULT_PACKAGE_LIST: PackageListPreferences = {
  filter: "On the way",
  search: "",
};
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// Local to this browser, partitioned by the authenticated account and household.
// JSON tuple encoding avoids collisions between identifiers containing separators.
export function packageListKey(
  userId: string | undefined,
  household: string,
): string | null {
  if (!userId || !household) return null;
  return `porchpong.package-list.v1:${JSON.stringify([userId, household])}`;
}

export function readPackageList(
  storage: StorageLike | null,
  key: string | null,
): PackageListPreferences {
  try {
    const value =
      key && storage ? JSON.parse(storage.getItem(key) || "null") : null;
    if (value?.version !== 1) return { ...DEFAULT_PACKAGE_LIST };
    return {
      filter: PACKAGE_FILTERS.includes(value.filter)
        ? value.filter
        : DEFAULT_PACKAGE_LIST.filter,
      search:
        typeof value.search === "string" ? value.search.slice(0, 256) : "",
    };
  } catch {
    return { ...DEFAULT_PACKAGE_LIST };
  }
}

export function writePackageList(
  storage: StorageLike | null,
  key: string | null,
  value: PackageListPreferences,
) {
  if (!storage || !key) return;
  try {
    if (value.filter === DEFAULT_PACKAGE_LIST.filter && !value.search)
      storage.removeItem(key);
    else
      storage.setItem(
        key,
        JSON.stringify({
          version: 1,
          filter: value.filter,
          search: value.search.slice(0, 256),
        }),
      );
  } catch {
    // Private browsing, full storage, or device policies must not disable the list.
  }
}
