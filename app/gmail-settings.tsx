"use client";
import { useState } from "react";
import { Mail, Pause, Play, RefreshCw, Unplug } from "lucide-react";
import type { Settings } from "@/lib/types";
import { since } from "@/lib/display";
import { api, GoogleMark, Spinner } from "./components";

export function GmailSettings({
  settings: s,
  reload,
  notify,
}: {
  settings: Settings;
  reload: () => Promise<void>;
  notify: (message: string, error?: boolean) => void;
}) {
  const [busy, setBusy] = useState("");
  const [importRecent, setImportRecent] = useState(false);
  const g = s.gmail;
  async function connect() {
    setBusy("connect");
    try {
      const result = await api<{ url: string }>("gmail/connect", {
        importRecent,
      });
      window.location.assign(result.url);
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not connect Gmail.", true);
      setBusy("");
    }
  }
  async function action(value: "pause" | "resume" | "disconnect" | "sync") {
    if (
      value === "disconnect" &&
      !window.confirm(
        "Disconnect your Gmail from this household? New imports stop. Already imported emails and packages stay in Doorstep.",
      )
    )
      return;
    setBusy(value);
    try {
      await api(`gmail/${value}`, {});
      await reload();
      notify(
        {
          pause: "Gmail imports paused.",
          resume: "Gmail imports resumed. Catching up on new mail.",
          disconnect: "Gmail disconnected. Saved packages remain.",
          sync: "Gmail check queued.",
        }[value],
      );
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not update Gmail.", true);
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="settings-card gmail-settings">
      <div className="settings-title">
        <Mail size={21} />
        <h2>Automatic package import</h2>
        <span
          className={
            "status " +
            (g.connected && g.enabled && !g.needsReconnect
              ? "status-delivered"
              : "")
          }
        >
          {g.connected
            ? g.needsReconnect
              ? "Reconnect needed"
              : g.enabled
                ? "Connected"
                : "Paused"
            : "Not connected"}
        </span>
      </div>
      <p>
        Connect your Gmail once. Doorstep checks for order confirmations and
        shipping updates every five minutes, even when the app is closed.
      </p>
      {g.connected ? (
        <>
          <div className="setting-row">
            <span>Your connected inbox</span>
            <strong>{g.email}</strong>
          </div>
          <div className="setting-row">
            <span>Last completed check</span>
            <strong>
              {g.lastSyncedAt
                ? since(g.lastSyncedAt)
                : "Waiting for first check"}
            </strong>
          </div>
          <div className="setting-row">
            <span>Emails imported</span>
            <strong>{g.importedCount}</strong>
          </div>
          {g.importing && g.enabled && !g.error && (
            <p className="info-box">
              Checking your selected emails. Packages appear as processing
              finishes.
            </p>
          )}
          {g.error && (
            <div className="form-error" role="alert">
              {g.error}
            </div>
          )}
          <div className="button-row">
            {g.needsReconnect ? (
              <button className="primary" onClick={connect} disabled={!!busy}>
                <GoogleMark />
                Reconnect Gmail
              </button>
            ) : (
              <>
                <button
                  className="secondary"
                  onClick={() => action(g.enabled ? "pause" : "resume")}
                  disabled={!!busy}
                >
                  {g.enabled ? <Pause size={16} /> : <Play size={16} />}
                  {g.enabled ? "Pause imports" : "Resume imports"}
                </button>
                {g.enabled && (
                  <button
                    className="secondary"
                    onClick={() => action("sync")}
                    disabled={!!busy}
                  >
                    <RefreshCw size={16} />
                    Check now
                  </button>
                )}
              </>
            )}
            <button
              className="subtle-button"
              onClick={() => action("disconnect")}
              disabled={!!busy}
            >
              <Unplug size={16} />
              Disconnect Gmail
            </button>
          </div>
          <small>
            Pausing stops new imports; resuming catches up. Disconnecting
            removes the saved Gmail credentials. Already imported emails and
            packages remain in this household.
          </small>
        </>
      ) : (
        <>
          <div className="permission-note">
            <GoogleMark />
            <span>
              Optional read-only access for <strong>{s.account.email}</strong>.
              Google grants mailbox-wide read access; Doorstep filters for
              likely order and shipping emails. It cannot send, change, or
              delete your mail.
            </span>
          </div>
          <p>
            Matching email contents are sent to OpenAI to extract packages.
            Those emails and package details are shared with{" "}
            <strong>{s.householdName}</strong>. Filters can occasionally include
            unrelated messages or miss a package. Each household member connects
            their own inbox.
          </p>
          {g.otherHouseholdName ? (
            <div className="info-box">
              Your Gmail is connected to {g.otherHouseholdName}. Switch to that
              household and disconnect Gmail there before connecting here.
            </div>
          ) : (
            <>
              <label>
                Start importing from
                <select
                  value={importRecent ? "30" : "0"}
                  onChange={(e) => setImportRecent(e.target.value === "30")}
                  disabled={!!busy}
                >
                  <option value="0">New emails only</option>
                  <option value="30">Last 30 days and new emails</option>
                </select>
              </label>
              <button
                className="primary"
                onClick={connect}
                disabled={!!busy || s.demo || !s.services.gmail}
              >
                {busy === "connect" ? <Spinner /> : <GoogleMark />}Connect Gmail
              </button>
              {!s.services.gmail && (
                <small>
                  Gmail import is not enabled for this household yet.
                </small>
              )}
              {s.demo && (
                <small>
                  Sign in to your household to connect your own inbox.
                </small>
              )}
            </>
          )}
          <small>
            You can pause or disconnect at any time.{" "}
            <a href="/privacy">How your email is used</a>
          </small>
        </>
      )}
    </section>
  );
}
