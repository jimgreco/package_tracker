"use client";
import { useCallback, useEffect, useState } from "react";
import {
  Package,
  ArrowUpRight,
  Truck,
  Check,
  Plus,
  CalendarDays,
  Mail,
  ChevronRight,
  Search,
  Settings as SettingsIcon,
  ArrowRight,
  RefreshCw,
  X,
  Copy,
  ExternalLink,
  AlertCircle,
  CheckCircle2,
  Inbox,
  Merge,
  ChevronLeft,
} from "lucide-react";
import type {
  DashboardData,
  Shipment,
  TrackingEvent,
  Email,
} from "@/lib/types";
import { STATUS_LABEL } from "@/lib/types";
import {
  dateLabel,
  estimateLabel,
  estimateTime,
  todayInZone,
  dayFor,
  includesDay,
  since,
} from "@/lib/display";
import {
  Modal,
  PackageForm,
  AuthForm,
  MerchantTile,
  Spinner,
  Empty,
  api,
} from "./components";
import { CalendarView, InboxView, SettingsView } from "./views";
type Detail = { shipment: Shipment; events: TrackingEvent[]; emails: Email[] };
type View = "packages" | "calendar" | "inbox" | "settings";
export default function Page() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [view, setView] = useState<View>("packages");
  const [filter, setFilter] = useState("All packages");
  const [search, setSearch] = useState("");
  const [initialError, setInitialError] = useState("");
  const [auth, setAuth] = useState(false);
  const [authError, setAuthError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [form, setForm] = useState<Shipment | "new" | null>(null);
  const [paste, setPaste] = useState(false);
  const [email, setEmail] = useState<Email | null>(null);
  const [merge, setMerge] = useState(false);
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const notify = useCallback(
    (message: string, error = false) => setToast({ message, error }),
    [],
  );
  const reload = useCallback(async () => {
    try {
      const next = await api<DashboardData>("dashboard");
      setData(next);
      setInitialError("");
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Could not load your household.";
      if (message === "Sign in to your household.") setAuth(true);
      else setInitialError(message);
    }
  }, []);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const v = p.get("view");
    if (["packages", "calendar", "inbox", "settings"].includes(v || ""))
      setView(v as View);
    if (p.get("shipment")) setSelected(p.get("shipment"));
    if (p.get("authError")) {
      setAuthError(p.get("authError")!);
      setAuth(true);
    }
    if (p.has("authError")) {
      p.delete("authError");
      window.history.replaceState(
        null,
        "",
        window.location.pathname + (p.size ? "?" + p.toString() : ""),
      );
    }
    if (p.get("googleError")) notify(p.get("googleError")!, true);
    else if (p.get("google") === "connected")
      notify("Google connected. Your delivery calendar is being prepared.");
    void reload();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, 30000);
    return () => clearInterval(timer);
  }, [reload, notify]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(timer);
  }, [toast]);
  const selectedUpdatedAt = data?.shipments.find(
    (s) => s.id === selected,
  )?.updatedAt;
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setDetail(null);
    setDetailError("");
    api<Detail>("shipments/" + selected)
      .then((r) => {
        if (!cancelled) setDetail(r);
      })
      .catch((e) => {
        if (!cancelled) setDetailError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, selectedUpdatedAt]);
  function navigate(v: View) {
    setView(v);
    window.history.replaceState(
      null,
      "",
      v === "packages" ? "/" : "/?view=" + v,
    );
  }
  function select(id: string) {
    setSelected(id);
    window.history.replaceState(null, "", `/?view=${view}&shipment=${id}`);
  }
  function closeDetail() {
    setSelected(null);
    setDetail(null);
    window.history.replaceState(
      null,
      "",
      view === "packages" ? "/" : "/?view=" + view,
    );
  }
  async function action(key: string, fn: () => Promise<void>) {
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
  async function connect() {
    if (data?.settings.demo) {
      setAuth(true);
      notify("Create your household to connect a real Google calendar.");
      return;
    }
    const result = await api<{ url: string }>("google/connect", {});
    window.location.assign(result.url);
  }
  async function openEmail(id: string) {
    await action("email", async () =>
      setEmail(await api<Email>("emails/" + id)),
    );
  }
  async function logout() {
    await api("auth/logout", {});
    setData(null);
    setAuth(true);
  }
  const today = data ? todayInZone(data.settings.timeZone) : "";
  const all = data?.shipments || [];
  const active = all.filter((s) =>
    [
      "pre_transit",
      "in_transit",
      "out_for_delivery",
      "delayed",
      "available_for_pickup",
      "failure",
    ].includes(s.status),
  );
  const arriving = active.filter((s) =>
    includesDay(s, today, data!.settings.timeZone),
  );
  const delivered = all.filter((s) => s.status === "delivered");
  const visible = all.filter(
    (s) =>
      (filter === "All packages" ||
        (filter === "On the way"
          ? active.includes(s)
          : filter === "Delivered"
            ? s.status === "delivered"
            : s.needsReview || ["failure", "delayed"].includes(s.status))) &&
      [
        s.merchant,
        s.orderNumber,
        s.trackingNumber,
        ...s.items.map((i) => i.name),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const upcoming = all
    .filter(
      (s) => s.estimate && s.status !== "delivered" && s.status !== "cancelled",
    )
    .sort((a, b) => a.estimate!.start.localeCompare(b.estimate!.start))
    .slice(0, 3);
  const headings = {
    packages: [
      "Your doorstep, at a glance",
      "Everything on its way to your home, in one place.",
    ],
    calendar: [
      "A little heads-up for your day",
      "See what’s arriving, and when to expect it.",
    ],
    inbox: [
      "Good news travels by email",
      "Your orders, shipping notices, and delivery updates.",
    ],
    settings: [
      "Make yourself at home",
      "Your household, connected services, and preferences.",
    ],
  };
  return (
    <>
      <header className="topbar">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate("packages");
          }}
        >
          <span className="brand-icon">
            <Package size={22} />
          </span>
          doorstep<span className="brand-period">.</span>
        </a>
        <nav aria-label="Main navigation">
          {(
            [
              ["packages", Package, "Packages"],
              ["calendar", CalendarDays, "Calendar"],
              ["inbox", Mail, "Inbox"],
            ] as const
          ).map(([v, Icon, label]) => (
            <button
              key={v}
              className={view === v ? "active" : ""}
              onClick={() => navigate(v)}
            >
              <Icon size={17} />
              {label}
              {v === "inbox" &&
              data?.emails.some(
                (e) => e.status === "needs_review" || e.status === "failed",
              ) ? (
                <span className="nav-dot" />
              ) : null}
            </button>
          ))}
        </nav>
        <button
          className={"household " + (view === "settings" ? "active" : "")}
          onClick={() => navigate("settings")}
          aria-label="Household settings"
        >
          <span className="avatar">
            {data?.settings.householdName.slice(0, 1) || "H"}
          </span>
          {data?.settings.householdName || "Your household"}
          <SettingsIcon size={17} />
        </button>
      </header>
      <main className="workspace">
        {data?.settings.demo && (
          <div className="preview-notice">
            <span>Sample household</span>Explore with sample packages.
            <button onClick={() => setAuth(true)}>
              Create your household
              <ArrowRight size={13} />
            </button>
          </div>
        )}
        {initialError && (
          <div className="error-banner" role="alert">
            <AlertCircle size={19} />
            {initialError}
            <button className="text-button" onClick={() => void reload()}>
              Try again
            </button>
          </div>
        )}
        {!data && !auth ? (
          <div className="loading-state">
            <Spinner />
            <p>Getting your doorstep ready…</p>
          </div>
        ) : (
          data && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">HOUSEHOLD DELIVERIES</div>
                  <h1>
                    {headings[view][0]}
                    <span>.</span>
                  </h1>
                  <p>{headings[view][1]}</p>
                </div>
                {view === "packages" && (
                  <button className="primary" onClick={() => setForm("new")}>
                    <Plus size={18} />
                    Add package
                  </button>
                )}
              </div>
              {view === "packages" ? (
                <>
                  <section className="stats" aria-label="Delivery summary">
                    <div>
                      <span className="stat-icon blue">
                        <Truck />
                      </span>
                      <div>
                        <strong>{active.length}</strong>
                        <span>On the way</span>
                      </div>
                    </div>
                    <div>
                      <span className="stat-icon violet">
                        <CalendarDays />
                      </span>
                      <div>
                        <strong>{arriving.length}</strong>
                        <span>Arriving today</span>
                      </div>
                    </div>
                    <div>
                      <span className="stat-icon green">
                        <Check />
                      </span>
                      <div>
                        <strong>{delivered.length}</strong>
                        <span>Delivered</span>
                      </div>
                    </div>
                  </section>
                  <div className="dashboard-grid">
                    <section>
                      <div className="toolbar">
                        <div className="tabs" aria-label="Filter packages">
                          {[
                            "All packages",
                            "On the way",
                            "Delivered",
                            "Needs attention",
                          ].map((t) => (
                            <button
                              key={t}
                              className={filter === t ? "selected" : ""}
                              onClick={() => setFilter(t)}
                              aria-pressed={filter === t}
                            >
                              {t}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="list-label">
                        LATEST SHIPMENTS
                        <span>{visible.length} packages · Newest first</span>
                      </div>
                      <div className="search-box">
                        <Search size={17} />
                        <input
                          type="search"
                          placeholder="Search shops, items, or tracking numbers"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          aria-label="Search packages"
                        />
                      </div>
                      {visible.length ? (
                        <div className="shipment-list">
                          {visible.map((s) => (
                            <button
                              key={s.id}
                              className={
                                "shipment-card " +
                                (s.status === "out_for_delivery"
                                  ? "arriving-card"
                                  : "")
                              }
                              onClick={() => select(s.id)}
                            >
                              <MerchantTile shipment={s} />
                              <div className="shipment-main">
                                <div className="shipment-heading">
                                  <h3>{s.merchant}</h3>
                                  <span className={"status status-" + s.status}>
                                    {STATUS_LABEL[s.status]}
                                  </span>
                                  {s.needsReview && (
                                    <span
                                      className="review-indicator"
                                      title="Needs review"
                                    >
                                      <AlertCircle size={14} />
                                    </span>
                                  )}
                                </div>
                                <p>
                                  {s.items
                                    .map(
                                      (i) =>
                                        i.name +
                                        (i.quantity > 1
                                          ? " × " + i.quantity
                                          : ""),
                                    )
                                    .join(", ") || "Item details not available"}
                                </p>
                                <div className="shipment-meta">
                                  <span>
                                    {s.carrier || "Awaiting shipping details"}
                                  </span>
                                  {s.orderNumber && (
                                    <span>{s.orderNumber}</span>
                                  )}
                                </div>
                                {s.status === "out_for_delivery" && (
                                  <div
                                    className="delivery-progress"
                                    aria-label="Out for delivery"
                                  >
                                    <span />
                                    <span />
                                    <span />
                                    <span className="unfinished" />
                                  </div>
                                )}
                              </div>
                              <div className="shipment-eta">
                                <span>
                                  {s.status === "delivered"
                                    ? "Delivered"
                                    : "Expected delivery"}
                                </span>
                                <strong>
                                  {s.status === "delivered" && s.deliveredAt
                                    ? dateLabel(
                                        dayFor(s, data.settings.timeZone)!,
                                      )
                                    : s.estimate?.start.slice(0, 10) ===
                                          today &&
                                        s.estimate.kind !== "date_range"
                                      ? "Today"
                                      : estimateLabel(s.estimate)}
                                </strong>
                                {s.status !== "delivered" &&
                                  estimateTime(s.estimate) && (
                                    <small>{estimateTime(s.estimate)}</small>
                                  )}
                              </div>
                              <ChevronRight className="card-arrow" size={19} />
                            </button>
                          ))}
                        </div>
                      ) : (
                        <Empty
                          title={
                            all.length
                              ? "Nothing here just yet"
                              : "Your doorstep is clear"
                          }
                          action={
                            all.length ? (
                              <button
                                className="secondary"
                                onClick={() => {
                                  setSearch("");
                                  setFilter("All packages");
                                }}
                              >
                                Show all packages
                              </button>
                            ) : (
                              <button
                                className="primary"
                                onClick={() => setForm("new")}
                              >
                                <Plus size={17} />
                                Add your first package
                              </button>
                            )
                          }
                        >
                          {all.length
                            ? "Try a different filter or search."
                            : "Forward a shipping email or add your first package to get started."}
                        </Empty>
                      )}
                    </section>
                    <aside>
                      <section className="side-card">
                        <div className="side-heading">
                          <h2>Your delivery week</h2>
                          <button
                            className="icon-button"
                            aria-label="Open delivery calendar"
                            onClick={() => navigate("calendar")}
                          >
                            <CalendarDays size={19} />
                          </button>
                        </div>
                        <div className="week-strip">
                          {Array.from({ length: 7 }, (_, i) => {
                            const d = new Date(today + "T12:00:00Z");
                            d.setUTCDate(
                              d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + i,
                            );
                            const key = d.toISOString().slice(0, 10);
                            return (
                              <button
                                key={key}
                                className={key === today ? "today" : ""}
                                onClick={() => navigate("calendar")}
                                aria-label={`View ${dateLabel(key)} in calendar`}
                              >
                                <span>
                                  {d.toLocaleDateString("en-US", {
                                    weekday: "narrow",
                                    timeZone: "UTC",
                                  })}
                                </span>
                                <strong>{d.getUTCDate()}</strong>
                                {all.some(
                                  (s) =>
                                    s.status !== "delivered" &&
                                    includesDay(s, key, data.settings.timeZone),
                                ) && <i />}
                              </button>
                            );
                          })}
                        </div>
                        {upcoming.length ? (
                          upcoming.map((s) => (
                            <button
                              className="aside-delivery"
                              key={s.id}
                              onClick={() => select(s.id)}
                            >
                              <MerchantTile shipment={s} small />
                              <div>
                                <strong>{s.merchant}</strong>
                                <span>
                                  {s.estimate?.start.slice(0, 10) === today
                                    ? "Today"
                                    : estimateLabel(s.estimate)}
                                  {estimateTime(s.estimate)
                                    ? " · " + estimateTime(s.estimate)
                                    : ""}
                                </span>
                              </div>
                              <ArrowUpRight size={17} />
                            </button>
                          ))
                        ) : (
                          <p className="quiet">
                            No upcoming delivery estimates.
                          </p>
                        )}
                      </section>
                      <section className="side-card calendar-card">
                        <span className="service-icon">
                          <CalendarDays size={23} />
                        </span>
                        <h2>
                          {data.settings.google.connected
                            ? "Your calendar, connected."
                            : "Make room for arrivals."}
                        </h2>
                        <p>
                          {data.settings.google.connected
                            ? "Delivery updates go straight to your Google calendar."
                            : "Delivery dates in Google Calendar, and wherever you take it."}
                        </p>
                        <button
                          className="secondary"
                          onClick={() =>
                            data.settings.google.connected
                              ? navigate("settings")
                              : void action("google", connect)
                          }
                          disabled={busy === "google"}
                        >
                          {busy === "google" ? <Spinner /> : null}
                          {data.settings.google.connected
                            ? "Calendar settings"
                            : "Connect Google Calendar"}
                          <ArrowRight size={17} />
                        </button>
                        <small>Dates move when your deliveries do.</small>
                      </section>
                      <section className="side-card forwarding-card">
                        <Mail size={23} />
                        <h2>Forward it. Forget it.</h2>
                        <p>
                          Send a shipping email to your household address. We’ll
                          take it from there.
                        </p>
                        {data.settings.forwardingAddress ? (
                          <button
                            className="text-button"
                            onClick={() =>
                              action("copy", async () => {
                                await navigator.clipboard.writeText(
                                  data.settings.forwardingAddress!,
                                );
                                notify("Forwarding address copied.");
                              })
                            }
                          >
                            Copy forwarding address
                            <Copy size={15} />
                          </button>
                        ) : (
                          <button
                            className="text-button"
                            onClick={() => navigate("settings")}
                          >
                            Set up email forwarding
                            <ArrowRight size={16} />
                          </button>
                        )}
                        <button
                          className="text-button paste-link"
                          onClick={() => setPaste(true)}
                        >
                          Or paste an email here
                        </button>
                      </section>
                    </aside>
                  </div>
                </>
              ) : view === "calendar" ? (
                <CalendarView
                  data={data}
                  select={select}
                  busy={busy === "google"}
                  connect={() =>
                    data.settings.google.connected
                      ? navigate("settings")
                      : void action("google", connect)
                  }
                />
              ) : view === "inbox" ? (
                <InboxView
                  emails={data.emails}
                  open={openEmail}
                  paste={() => setPaste(true)}
                />
              ) : (
                <SettingsView
                  settings={data.settings}
                  reload={reload}
                  notify={notify}
                  connect={connect}
                  auth={() => setAuth(true)}
                  logout={logout}
                />
              )}
              <footer>
                <span>
                  <Package size={14} /> A home for everything coming home.
                </span>
                <span>
                  {data.settings.demo
                    ? "Sample data"
                    : "Updates run in the background"}
                  {" · "}
                  <a className="privacy-link" href="/privacy">
                    Privacy policy
                  </a>
                </span>
              </footer>
            </>
          )
        )}
      </main>
      {auth && !data && (
        <div className="login-surface">
          <AuthForm
            initialError={authError}
            preview={false}
            onSuccess={() => {
              setAuth(false);
              setAuthError("");
              void reload();
            }}
          />
        </div>
      )}
      {auth && data && (
        <Modal
          title="Your household"
          onClose={() => {
            if (data) {
              setAuth(false);
              setAuthError("");
            }
          }}
        >
          <AuthForm
            initialError={authError}
            preview={!!data?.settings.demo}
            onSuccess={() => {
              setAuth(false);
              setAuthError("");
              void reload();
            }}
            onClose={data ? () => setAuth(false) : undefined}
          />
        </Modal>
      )}
      {form && data && (
        <Modal
          title={form === "new" ? "Add a package" : "Edit package"}
          onClose={() => setForm(null)}
          wide
        >
          <PackageForm
            value={form === "new" ? undefined : form}
            timeZone={data.settings.timeZone}
            onClose={() => setForm(null)}
            onSaved={(id) => {
              setForm(null);
              notify("Package saved.");
              void reload();
              select(id);
            }}
          />
        </Modal>
      )}
      {selected && (
        <Modal title="Package details" onClose={closeDetail} sheet>
          {detailError ? (
            <div className="form-body">
              <div className="form-error">{detailError}</div>
            </div>
          ) : !detail ? (
            <div className="loading-state">
              <Spinner />
              Loading package…
            </div>
          ) : (
            <div className="detail-body">
              <div className="detail-product">
                <MerchantTile shipment={detail.shipment} />
                <div>
                  <h2>{detail.shipment.merchant}</h2>
                  <p>
                    {detail.shipment.items.map((i) => i.name).join(", ") ||
                      "Item details unavailable"}
                  </p>
                </div>
              </div>
              <span className={"status status-" + detail.shipment.status}>
                {STATUS_LABEL[detail.shipment.status]}
              </span>
              {detail.shipment.needsReview && (
                <div className="info-box review-box">
                  <AlertCircle size={19} />
                  <span>
                    {detail.shipment.reviewReason ||
                      "Some details need your review."}
                  </span>
                </div>
              )}
              <div className="arrival-detail">
                <span>
                  {detail.shipment.status === "delivered"
                    ? "Delivered"
                    : "Expected delivery"}
                </span>
                <strong>
                  {detail.shipment.status === "delivered" &&
                  detail.shipment.deliveredAt
                    ? dateLabel(detail.shipment.deliveredAt)
                    : estimateLabel(detail.shipment.estimate)}
                </strong>
                <p>{estimateTime(detail.shipment.estimate)}</p>
                {detail.shipment.estimate && (
                  <small>
                    {detail.shipment.estimate.timeZone.replaceAll("_", " ")}
                  </small>
                )}
              </div>
              <dl className="package-facts">
                <div>
                  <dt>Order number</dt>
                  <dd>{detail.shipment.orderNumber || "Not provided"}</dd>
                </div>
                <div>
                  <dt>Ordered</dt>
                  <dd>
                    {detail.shipment.orderedAt
                      ? dateLabel(detail.shipment.orderedAt, {
                          month: "long",
                          day: "numeric",
                          year: "numeric",
                        })
                      : "Not provided"}
                  </dd>
                </div>
                <div>
                  <dt>Shipped</dt>
                  <dd>
                    {detail.shipment.shippedAt
                      ? dateLabel(detail.shipment.shippedAt)
                      : "Not provided"}
                  </dd>
                </div>
                <div>
                  <dt>Carrier</dt>
                  <dd>{detail.shipment.carrier || "Not available"}</dd>
                </div>
                <div>
                  <dt>Tracking number</dt>
                  <dd className="tracking-code">
                    {detail.shipment.trackingNumber || "Not available"}
                    {detail.shipment.trackingNumber && (
                      <button
                        className="icon-button"
                        aria-label="Copy tracking number"
                        onClick={() =>
                          action("copy", async () => {
                            await navigator.clipboard.writeText(
                              detail.shipment.trackingNumber!,
                            );
                            notify("Tracking number copied.");
                          })
                        }
                      >
                        <Copy size={15} />
                      </button>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Last checked</dt>
                  <dd>{since(detail.shipment.lastCheckedAt)}</dd>
                </div>
              </dl>
              {detail.shipment.isDemo ? (
                <div className="info-box">
                  This is a sample package. Tracking history illustrates how
                  live updates will appear.
                </div>
              ) : (
                ["unsupported", "unconfigured", "error"].includes(
                  detail.shipment.trackingState,
                ) && (
                  <div className="info-box">
                    {detail.shipment.trackingState === "unsupported"
                      ? "Automatic tracking is unavailable for this shipment. Use the original tracking link or forward another update."
                      : detail.shipment.trackingState === "unconfigured"
                        ? "Connect EasyPost in the server configuration to start automatic tracking."
                        : "The carrier could not be reached. The worker will retry."}
                  </div>
                )
              )}
              {detail.shipment.manualOverride && (
                <div className="info-box">
                  Your status and delivery estimate are protected from automatic
                  changes.
                </div>
              )}
              <div className="button-row detail-actions">
                <button
                  className="primary"
                  onClick={() => setForm(detail.shipment)}
                >
                  Edit details
                </button>
                {detail.shipment.trackingUrl && (
                  <a
                    className="secondary"
                    href={detail.shipment.trackingUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Track package
                    <ExternalLink size={15} />
                  </a>
                )}
                <button
                  className="secondary"
                  disabled={
                    busy === "refresh" ||
                    detail.shipment.isDemo ||
                    !detail.shipment.trackingNumber
                  }
                  onClick={() =>
                    action("refresh", async () => {
                      await api(`shipments/${selected}/refresh`, {});
                      notify("Tracking refresh queued.");
                    })
                  }
                >
                  <RefreshCw size={16} />
                  Refresh
                </button>
              </div>
              <h3 className="detail-section-title">Delivery history</h3>
              {detail.events.length ? (
                <ol className="event-list">
                  {detail.events.map((event, i) => (
                    <li key={event.id}>
                      <span
                        className={"event-dot " + (i === 0 ? "current" : "")}
                      >
                        {i === 0 ? <Check size={11} /> : null}
                      </span>
                      <div>
                        <strong>{event.message}</strong>
                        {event.location && <p>{event.location}</p>}
                        <small>
                          {new Date(event.occurredAt).toLocaleString("en-US", {
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                            timeZone: data?.settings.timeZone,
                          })}{" "}
                          · {event.source}
                        </small>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="quiet">Carrier updates will appear here.</p>
              )}
              <h3 className="detail-section-title">Source emails</h3>
              {detail.emails.length ? (
                detail.emails.map((e) => (
                  <button
                    className="source-link"
                    key={e.id}
                    onClick={() => setEmail(e)}
                  >
                    <Mail size={19} />
                    <span>{e.subject}</span>
                    <ChevronRight size={17} />
                  </button>
                ))
              ) : (
                <p className="quiet">
                  {detail.shipment.isDemo
                    ? "This sample package has no source email."
                    : "Added manually. Future shipping emails will appear here."}
                </p>
              )}
              {all.length > 1 && (
                <button
                  className="subtle-button merge-link"
                  onClick={() => setMerge(true)}
                >
                  <Merge size={16} />
                  Merge into another package
                </button>
              )}
            </div>
          )}
        </Modal>
      )}
      {merge && selected && (
        <Modal title="Merge duplicate package" onClose={() => setMerge(false)}>
          <form
            className="form-body"
            onSubmit={(e) => {
              e.preventDefault();
              const targetId = new FormData(e.currentTarget).get("targetId");
              void action("merge", async () => {
                await api(`shipments/${selected}/merge`, { targetId });
                setMerge(false);
                select(String(targetId));
                await reload();
                notify("Packages merged.");
              });
            }}
          >
            <p className="form-intro">
              Keep the selected package’s details and combine both histories and
              source emails. The duplicate will be archived and its calendar
              event removed.
            </p>
            <label>
              Package to keep
              <select name="targetId" required>
                {all
                  .filter((s) => s.id !== selected)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.merchant} · {s.items[0]?.name || s.orderNumber}
                    </option>
                  ))}
              </select>
            </label>
            <div className="modal-actions">
              <button
                className="secondary"
                type="button"
                onClick={() => setMerge(false)}
              >
                Cancel
              </button>
              <button className="primary" disabled={busy === "merge"}>
                Merge packages
              </button>
            </div>
          </form>
        </Modal>
      )}
      {paste && (
        <Modal title="Paste a shipping email" onClose={() => setPaste(false)}>
          <form
            className="form-body"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void action("paste", async () => {
                await api("emails", {
                  subject: f.get("subject"),
                  text: f.get("text"),
                });
                setPaste(false);
                navigate("inbox");
                await reload();
                notify("Email saved. Extraction will run in the background.");
              });
            }}
          >
            <p className="form-intro">
              Include the original message date, item names, and tracking links.
              The email text will be sent to OpenAI to extract package details.
            </p>
            {data?.settings.demo && (
              <div className="info-box">
                Create your household and connect OpenAI to process real emails.
                You can explore manual package entry in this preview.
              </div>
            )}
            <label>
              Subject
              <input
                name="subject"
                placeholder="Your order has shipped"
                required
                maxLength={1000}
              />
            </label>
            <label>
              Email contents
              <textarea
                name="text"
                rows={10}
                placeholder="Paste the full shipping email here…"
                required
                minLength={20}
                maxLength={100000}
              />
            </label>
            <div className="modal-actions">
              <button
                className="secondary"
                type="button"
                onClick={() => setPaste(false)}
              >
                Cancel
              </button>
              {data?.settings.demo ? (
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    setPaste(false);
                    setAuth(true);
                  }}
                >
                  Create household
                </button>
              ) : (
                <button className="primary" disabled={busy === "paste"}>
                  {busy === "paste" ? <Spinner /> : null}Extract package details
                </button>
              )}
            </div>
          </form>
        </Modal>
      )}
      {email && (
        <Modal title="Source email" onClose={() => setEmail(null)} wide>
          <div className="form-body">
            <h3>{email.subject}</h3>
            <p className="quiet">
              {email.from} · {new Date(email.receivedAt).toLocaleString()}
            </p>
            {email.error && <div className="form-error">{email.error}</div>}
            <pre className="email-text">{email.text}</pre>
            {email.extraction != null && (
              <details className="extraction">
                <summary>Extracted details</summary>
                <pre>{JSON.stringify(email.extraction, null, 2)}</pre>
              </details>
            )}
            {email.status &&
              ["failed", "needs_review"].includes(email.status) && (
                <button
                  className="secondary"
                  disabled={busy === "retry"}
                  onClick={() =>
                    action("retry", async () => {
                      await api(`emails/${email.id}/retry`, {});
                      setEmail(null);
                      await reload();
                      notify("Email queued for another attempt.");
                    })
                  }
                >
                  <RefreshCw size={16} />
                  Try extraction again
                </button>
              )}
          </div>
        </Modal>
      )}
      {toast && (
        <div
          className={"toast " + (toast.error ? "error" : "")}
          role={toast.error ? "alert" : "status"}
        >
          {toast.error ? <AlertCircle size={19} /> : <CheckCircle2 size={19} />}
          <span>{toast.message}</span>
          <button
            className="icon-button"
            onClick={() => setToast(null)}
            aria-label="Dismiss notification"
          >
            <X size={16} />
          </button>
        </div>
      )}
    </>
  );
}
