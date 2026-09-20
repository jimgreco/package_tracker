"use client";
import { useEffect, useState } from "react";
import { api } from "./components";
type Preferences = {
  configured: boolean;
  enabled: boolean;
  outForDelivery: boolean;
  delivered: boolean;
  pickup: boolean;
  problems: boolean;
};
export function NotificationSettings({
  householdId,
  demo,
}: {
  householdId: string;
  demo: boolean;
}) {
  const [prefs, setPrefs] = useState<Preferences>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    api<Preferences>("notifications/preferences")
      .then((p) => {
        if (active) setPrefs(p);
      })
      .catch(() => {
        if (active) setError("Could not load notification preferences.");
      });
    return () => {
      active = false;
    };
  }, [householdId]);
  async function change(
    key: keyof Omit<Preferences, "configured">,
    value: boolean,
  ) {
    if (!prefs) return;
    setBusy(true);
    setError("");
    try {
      setPrefs(
        await api<Preferences>("notifications/preferences", {
          ...prefs,
          [key]: value,
        }),
      );
    } catch {
      setError("Could not save notification preferences. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-card">
      <h2>iPhone notifications</h2>
      <p>
        Your preferences for this household. Enable notifications in the
        PorchPong iPhone app to register your phone.
      </p>
      {prefs && (
        <>
          {!prefs.configured && (
            <p className="info-box">
              Push delivery is not configured yet. Your preferences can still be
              saved.
            </p>
          )}
          {(
            [
              ["enabled", "Send me notifications"],
              ["outForDelivery", "Out for delivery"],
              ["delivered", "Delivered"],
              ["pickup", "Ready for pickup"],
              ["problems", "Delays and packages needing attention"],
            ] as const
          ).map(([key, label]) => (
            <label
              key={key}
              style={{
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                marginTop: 16,
              }}
            >
              <input
                type="checkbox"
                checked={prefs[key]}
                disabled={demo || busy || (key !== "enabled" && !prefs.enabled)}
                onChange={(e) => void change(key, e.target.checked)}
                style={{ width: 20, height: 20, flexShrink: 0, margin: 0 }}
              />
              {label}
            </label>
          ))}
          <p>
            Alerts show a general delivery message. Package details stay inside
            the app.
          </p>
        </>
      )}
      {!prefs && !error && <p>Loading preferences…</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
