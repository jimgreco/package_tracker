"use client";
import { useEffect, useState } from "react";
import {
  DEFAULT_PACKAGE_LIST,
  readPackageList,
  writePackageList,
  type PackageListPreferences,
} from "@/lib/package-list-preferences";

function localStorageOrNull() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function usePackageListPreferences(key: string | null) {
  const [loaded, setLoaded] = useState<{
    key: string | null;
    value: PackageListPreferences;
  }>({ key: null, value: { ...DEFAULT_PACKAGE_LIST } });
  useEffect(() => {
    setLoaded({ key, value: readPackageList(localStorageOrNull(), key) });
  }, [key]);
  // Never render another account's query while its new preferences are loading.
  const value = loaded.key === key ? loaded.value : DEFAULT_PACKAGE_LIST;
  function update(patch: Partial<PackageListPreferences>) {
    setLoaded((current) => {
      const previous =
        current.key === key
          ? current.value
          : readPackageList(localStorageOrNull(), key);
      const next = { ...previous, ...patch };
      writePackageList(localStorageOrNull(), key, next);
      return { key, value: next };
    });
  }
  return { ...value, update };
}
