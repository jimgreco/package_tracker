"use client";
import { useState } from "react";
import { GmailSettings } from "./gmail-settings";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Mail,
  Copy,
  Check,
  ArrowRight,
  ExternalLink,
  RefreshCw,
  Download,
  Users,
  Link2,
  ShieldCheck,
  Unplug,
  Info,
  Inbox,
} from "lucide-react";
import type { DashboardData, Shipment, Email, Settings } from "@/lib/types";
import { STATUS_LABEL } from "@/lib/types";
import {
  dateLabel,
  includesDay,
  todayInZone,
  estimateTime,
  since,
} from "@/lib/display";
import { api, Empty, Spinner, GoogleMark } from "./components";
export function CalendarView({
  data,
  select,
  connect,
  busy,
}: {
  data: DashboardData;
  select: (id: string) => void;
  connect: () => void;
  busy: boolean;
}) {
  const today = todayInZone(data.settings.timeZone);
  const [month, setMonth] = useState(today.slice(0, 7) + "-01");
  const start = new Date(month + "T12:00:00Z");
  const offset = (start.getUTCDay() + 6) % 7;
  const first = new Date(start.getTime() - offset * 86400000);
  const cells = Array.from({ length: 42 }, (_, i) =>
    new Date(first.getTime() + i * 86400000).toISOString().slice(0, 10),
  );
  const entries = data.shipments
    .filter((s) => s.status !== "cancelled")
    .map((s) => ({ s }));
  function move(n: number) {
    const d = new Date(start);
    d.setUTCMonth(d.getUTCMonth() + n);
    setMonth(d.toISOString().slice(0, 10));
  }
  return (
    <section className="calendar-view">
      <div className="calendar-view-heading">
        <div>
          <h2>{dateLabel(month, { month: "long", year: "numeric" })}</h2>
          <p>
            Delivery estimates · {data.settings.timeZone.replaceAll("_", " ")}
          </p>
        </div>
        <div className="calendar-nav">
          <button
            className="secondary"
            onClick={() => setMonth(today.slice(0, 7) + "-01")}
          >
            Today
          </button>
          <button
            className="icon-button"
            aria-label="Previous month"
            onClick={() => move(-1)}
          >
            <ChevronLeft size={20} />
          </button>
          <button
            className="icon-button"
            aria-label="Next month"
            onClick={() => move(1)}
          >
            <ChevronRight size={20} />
          </button>
        </div>
      </div>
      <div className="calendar-grid" role="grid" aria-label="Delivery calendar">
        {[
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ].map((d) => (
          <div key={d} className="calendar-weekday">
            <span className="long-day">{d}</span>
            <span className="short-day">{d.slice(0, 1)}</span>
          </div>
        ))}
        {cells.map((date) => (
          <div
            key={date}
            className={
              "calendar-cell " +
              (date.slice(0, 7) !== month.slice(0, 7) ? "outside " : "") +
              (date === today ? "is-today" : "")
            }
            role="gridcell"
            aria-label={dateLabel(date, { month: "long", day: "numeric" })}
          >
            <span className="calendar-date">{Number(date.slice(-2))}</span>
            {entries
              .filter((e) => includesDay(e.s, date, data.settings.timeZone))
              .map(({ s }) => (
                <button
                  key={s.id}
                  onClick={() => select(s.id)}
                  className={
                    "calendar-package " +
                    (s.status === "delivered" ? "done" : "")
                  }
                  title={s.merchant + " · " + STATUS_LABEL[s.status]}
                >
                  <strong>{s.merchant}</strong>
                  <span>{estimateTime(s.estimate) || "All day"}</span>
                </button>
              ))}
          </div>
        ))}
      </div>
      <div className="calendar-note">
        <Info size={17} />
        <span>
          Dates and ranges are all-day estimates. Time windows appear at the
          time provided by the carrier. Packages without an estimate stay in
          your package list.
        </span>
      </div>
      <div className="connection-banner">
        <div>
          <CalendarDays size={26} />
          <div>
            <h3>
              {data.settings.google.connected
                ? "Your delivery calendar is connected"
                : "Take your deliveries with you"}
            </h3>
            <p>
              {data.settings.google.connected
                ? "Changes are sent to Google Calendar, then sync to Apple Calendar."
                : "Connect Google Calendar to see deliveries in Google and Apple Calendar."}
            </p>
          </div>
        </div>
        <button className="primary" onClick={connect} disabled={busy}>
          {busy ? <Spinner /> : null}
          {data.settings.google.connected
            ? "Calendar settings"
            : "Connect Google Calendar"}
          <ArrowRight size={17} />
        </button>
      </div>
    </section>
  );
}
export function InboxView({
  emails,
  timeZone,
  open,
  paste,
}: {
  emails: Email[];
  timeZone: string;
  open: (id: string) => void;
  paste: () => void;
}) {
  return (
    <section>
      <div className="section-heading">
        <div>
          <h2>Your shipping inbox</h2>
          <p>
            Package emails, newest sent date first. Non-package emails are
            skipped.
          </p>
        </div>
        <button className="secondary" onClick={paste}>
          <Mail size={17} />
          Paste an email
        </button>
      </div>
      {!emails.length ? (
        <Empty
          title="Your next delivery starts here"
          action={
            <button className="primary" onClick={paste}>
              Paste a shipping email
              <ArrowRight size={17} />
            </button>
          }
        >
          Forward a shipping notice to your household address. Each email and
          its extracted details will appear here.
        </Empty>
      ) : (
        <div className="inbox-list">
          {emails.map((e) => (
            <button key={e.id} className="inbox-row" onClick={() => open(e.id)}>
              <span className="inbox-icon">
                <Mail size={21} />
              </span>
              <div>
                <h3>{e.subject}</h3>
                <p>{e.from}</p>
                {e.error && <small>{e.error}</small>}
              </div>
              <span
                className={
                  "status " +
                  (["failed", "needs_review"].includes(e.status)
                    ? "status-delayed"
                    : e.status === "processed"
                      ? "status-delivered"
                      : "")
                }
              >
                {e.status.replaceAll("_", " ")}
              </span>
              <time dateTime={e.sentAt || e.receivedAt}>
                {e.sentAt ? "Sent" : "Imported"}{" "}
                {new Date(e.sentAt || e.receivedAt).toLocaleDateString(
                  "en-US",
                  { timeZone, month: "short", day: "numeric", year: "numeric" },
                )}
              </time>
              <ChevronRight size={18} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
export function SettingsView({
  settings: s,
  reload,
  notify,
  connect,
  auth,
  logout,
}: {
  settings: Settings;
  reload: () => Promise<void>;
  notify: (message: string, error?: boolean) => void;
  connect: () => Promise<void>;
  auth: () => void;
  logout: () => Promise<void>;
}) {
  const [busy, setBusy] = useState("");
  const [memberEmail, setMemberEmail] = useState("");
  const [copied, setCopied] = useState("");
  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      notify(
        e instanceof Error ? e.message : "Could not complete that request.",
        true,
      );
    } finally {
      setBusy("");
    }
  }
  async function copy(text: string, key: string) {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(""), 2500);
  }
  const stale =
    !s.worker.lastSeenAt ||
    Date.now() - new Date(s.worker.lastSeenAt).getTime() > 180000;
  return (
    <div className="settings-grid">
      {!s.demo && (
        <section className="settings-card">
          <div className="settings-title">
            <ShieldCheck size={21} />
            <h2>Your account</h2>
          </div>
          <h3>{s.userName}</h3>
          <p>{s.account.email}</p>
          <div className="permission-note">
            <GoogleMark />
            <span>Signed in with Google</span>
          </div>
          {s.households.length > 1 && (
            <label>
              Current household
              <select
                value={s.householdId}
                disabled={!!busy}
                onChange={(e) =>
                  run("switch-household", async () => {
                    await api("settings/household-switch", {
                      householdId: e.target.value,
                    });
                    await reload();
                  })
                }
              >
                {s.households.map((home) => (
                  <option key={home.id} value={home.id}>
                    {home.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <small>
            Your Google account signs you in. Gmail and Calendar access are
            connected separately below.
          </small>
        </section>
      )}
      <section className="settings-card">
        <div className="settings-title">
          <Users size={21} />
          <h2>Your household</h2>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            run("household", async () => {
              await api(
                "settings",
                { name: f.get("name"), timeZone: f.get("timeZone") },
                "PATCH",
              );
              await reload();
              notify("Household settings saved.");
            });
          }}
        >
          <label>
            Household name
            <input name="name" defaultValue={s.householdName} required />
          </label>
          <label>
            Home time zone
            <input name="timeZone" defaultValue={s.timeZone} required />
            <small>
              Delivery dates use your home time zone, even when you travel.
            </small>
          </label>
          <button className="primary" disabled={busy === "household"}>
            {busy === "household" ? <Spinner /> : null}Save settings
          </button>
        </form>
        <div className="settings-divider" />
        {s.demo ? (
          <div className="setting-row">
            <div>
              <h3>Ready for your own packages?</h3>
              <p>Create an account to start your household.</p>
            </div>
            <button className="secondary" onClick={auth}>
              Create account
            </button>
          </div>
        ) : (
          <>
            <h3>Household members</h3>
            <p>
              Everyone signs in with their own Google account to share the same
              packages.
            </p>
            <div className="member-list">
              {s.members.map((member) => (
                <div className="member-row" key={member.userId || member.email}>
                  <div>
                    <strong>{member.name || member.email}</strong>
                    {member.name && <small>{member.email}</small>}
                    <small>
                      {member.pending
                        ? "Waiting for Google sign-in"
                        : member.role === "owner"
                          ? "Household owner"
                          : "Household member"}
                    </small>
                  </div>
                  {s.role === "owner" && member.role !== "owner" && (
                    <button
                      className="subtle-button"
                      disabled={!!busy}
                      onClick={() =>
                        run("remove-member", async () => {
                          await api(
                            "settings/members/remove",
                            member.pending
                              ? { email: member.email }
                              : { userId: member.userId },
                          );
                          await reload();
                          notify(
                            member.pending
                              ? "Pending member removed."
                              : "Household access removed.",
                          );
                        })
                      }
                    >
                      {member.pending ? "Cancel" : "Remove"}
                    </button>
                  )}
                </div>
              ))}
            </div>
            {s.role === "owner" ? (
              <form
                className="member-add"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run("add-member", async () => {
                    await api("settings/members", {
                      email: memberEmail.trim(),
                    });
                    setMemberEmail("");
                    await reload();
                    notify(
                      "Member added. They can join by signing in with Google.",
                    );
                  });
                }}
              >
                <label>
                  Member’s Google email
                  <input
                    type="email"
                    value={memberEmail}
                    onChange={(e) => setMemberEmail(e.target.value)}
                    placeholder="name@gmail.com"
                    required
                    maxLength={250}
                  />
                  <small>
                    Use their Gmail or Google Workspace email. They’ll join when
                    they next sign in. No invitation email is sent.
                  </small>
                </label>
                <button className="secondary" disabled={!!busy}>
                  {busy === "add-member" ? <Spinner /> : <Users size={17} />}Add
                  member
                </button>
              </form>
            ) : (
              <small>The household owner can add and remove members.</small>
            )}
          </>
        )}
      </section>
      <section className="settings-card">
        <div className="settings-title">
          <CalendarDays size={21} />
          <h2>Google Calendar</h2>
          <span
            className={
              "status " + (s.google.connected ? "status-delivered" : "")
            }
          >
            {s.google.connected ? "Connected" : "Not connected"}
          </span>
        </div>
        <p>
          Doorstep maintains a separate <strong>Package Deliveries</strong>{" "}
          calendar. Add your Google account to Apple Calendar to see it there,
          too.
        </p>
        <div className="permission-note">
          <ShieldCheck size={20} />
          <span>Access is limited to calendars created by Doorstep.</span>
        </div>
        {s.google.error && <div className="form-error">{s.google.error}</div>}
        {s.google.connected ? (
          <>
            <div className="setting-row">
              <span>Last calendar sync</span>
              <strong>{since(s.google.lastSyncedAt)}</strong>
            </div>
            <div className="button-row">
              <button
                className="secondary"
                onClick={() =>
                  run("sync", async () => {
                    await api("google/sync", {});
                    notify("Calendar update queued.");
                  })
                }
                disabled={busy === "sync"}
              >
                <RefreshCw size={16} />
                Sync now
              </button>
              <button
                className="secondary"
                onClick={() => run("connect", connect)}
              >
                Reconnect
              </button>
              <button
                className="subtle-button"
                onClick={() =>
                  run("disconnect", async () => {
                    await api("google/disconnect", {});
                    await reload();
                    notify(
                      "Disconnected. Your existing Google calendar is still yours.",
                    );
                  })
                }
              >
                <Unplug size={16} />
                Disconnect
              </button>
            </div>
            <small>
              Disconnecting stops updates and keeps your calendar in Google.
            </small>
          </>
        ) : (
          <button
            className="primary"
            onClick={() => run("connect", connect)}
            disabled={busy === "connect"}
          >
            {busy === "connect" ? <Spinner /> : <CalendarDays size={17} />}
            Connect Google Calendar
          </button>
        )}
        <div className="settings-divider" />
        <h3>Calendar subscription</h3>
        <p>
          You can also add this private feed in Google Calendar under Other
          calendars → From URL. Feed refreshes may take longer than a direct
          connection.
        </p>
        <div className="copy-field">
          <code>{s.calendarFeedUrl}</code>
          <button
            className="icon-button"
            aria-label="Copy calendar feed"
            onClick={() => run("copy", () => copy(s.calendarFeedUrl, "feed"))}
          >
            {copied === "feed" ? <Check size={17} /> : <Copy size={17} />}
          </button>
        </div>
        <small>
          Anyone with this link can read the calendar. Keep it private.
        </small>
        <button
          className="text-button"
          onClick={() =>
            run("rotate", async () => {
              if (
                !window.confirm(
                  "Replace your calendar link? Existing subscriptions will stop updating until you add the new link.",
                )
              )
                return;
              await api("settings/rotate-feed", {});
              await reload();
              notify("New calendar link created.");
            })
          }
        >
          Replace subscription link
        </button>
      </section>
      <GmailSettings settings={s} reload={reload} notify={notify} />
      <section className="settings-card">
        <div className="settings-title">
          <Mail size={21} />
          <h2>Email forwarding</h2>
        </div>
        <p>
          Forward order confirmations and shipping notices to your household
          address. Follow-up emails update the same package.
        </p>
        {s.forwardingAddress ? (
          <div className="copy-field">
            <code>{s.forwardingAddress}</code>
            <button
              className="icon-button"
              aria-label="Copy forwarding address"
              onClick={() =>
                run("copy", () => copy(s.forwardingAddress!, "email"))
              }
            >
              {copied === "email" ? <Check size={17} /> : <Copy size={17} />}
            </button>
          </div>
        ) : (
          <div className="info-box">
            {s.demo
              ? "Your private forwarding address appears after you create a household and connect email receiving."
              : "Email receiving needs to be configured on your server before your forwarding address is ready."}
          </div>
        )}
        <div className="settings-divider" />
        <h3>Connected services</h3>
        {[
          ["OpenAI · email extraction", s.services.openai],
          ["Postmark · incoming email", s.services.postmark],
          ["EasyPost · delivery tracking", s.services.easypost],
          ["Google · calendar connection", s.services.google],
        ].map(([name, on]) => (
          <div className="setting-row" key={String(name)}>
            <span>{name}</span>
            <span className={"status " + (on ? "status-delivered" : "")}>
              {on ? "Configured" : "Setup needed"}
            </span>
          </div>
        ))}
        <details className="setup-details">
          <summary>Service setup</summary>
          <p>
            The person hosting Doorstep can connect these services in the
            server’s environment configuration. The project README includes the
            exact steps.
          </p>
          <dl>
            <dt>Incoming email</dt>
            <dd>
              Postmark inbound webhook: <code>/api/webhooks/postmark</code>
            </dd>
            <dt>Tracking updates</dt>
            <dd>
              EasyPost webhook: <code>/api/webhooks/easypost</code>
            </dd>
            <dt>Google authorization</dt>
            <dd>
              Redirect path: <code>/api/google/callback</code>
            </dd>
          </dl>
          <p>
            Images and shipping text are processed to extract your packages. You
            can review the source emails in Inbox.
          </p>
        </details>
      </section>
      <section className="settings-card">
        <div className="settings-title">
          <RefreshCw size={21} />
          <h2>Background updates</h2>
          <span
            className={
              "status " + (stale ? "status-delayed" : "status-delivered")
            }
          >
            {stale ? "Not running" : "Running"}
          </span>
        </div>
        <p>Delivery tracking continues on the server when the app is closed.</p>
        <div className="setting-row">
          <span>Worker last seen</span>
          <strong>{since(s.worker.lastSeenAt)}</strong>
        </div>
        <div className="setting-row">
          <span>Jobs needing attention</span>
          <strong>{s.worker.failedJobs}</strong>
        </div>
        {s.worker.failedJobs > 0 && (
          <button
            className="secondary"
            onClick={() =>
              run("retry", async () => {
                await api("settings/retry-jobs", {});
                await reload();
                notify("Failed jobs queued for another attempt.");
              })
            }
          >
            Retry failed jobs
          </button>
        )}
        <div className="settings-divider" />
        <h3>Your data</h3>
        <p>Download your package details and source emails.</p>
        <a className="secondary" href="/api/settings/export" download>
          <Download size={17} />
          Export household data
        </a>
        {!s.demo && (
          <>
            <div className="settings-divider" />
            <p>Signed in as {s.userName}.</p>
            <button
              className="subtle-button"
              onClick={() => run("logout", logout)}
            >
              Sign out
            </button>
          </>
        )}
      </section>
    </div>
  );
}
