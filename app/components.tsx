"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { X, Package, LoaderCircle, ArrowRight, Users } from "lucide-react";
import type { Shipment, Estimate } from "@/lib/types";
import { estimateLocal } from "@/lib/display";
import { STATUSES, STATUS_LABEL } from "@/lib/types";
export async function api<T = Record<string, unknown>>(
  path: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : method,
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || "Could not complete this request.");
  return result as T;
}
export function Modal({
  children,
  title,
  onClose,
  wide = false,
  sheet = false,
}: {
  children: ReactNode;
  title: string;
  onClose: () => void;
  wide?: boolean;
  sheet?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""} ${sheet ? "sheet" : ""}`}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) {
          const r = ref.current!.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
      aria-label={title}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close dialog"
        >
          <X size={21} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Spinner() {
  return <LoaderCircle size={18} className="spin" />;
}
export function MerchantTile({
  shipment,
  small = false,
}: {
  shipment: Shipment;
  small?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const src = shipment.items.find((i) => i.imageUrl)?.imageUrl;
  return (
    <div
      className={
        (small ? "small-tile" : "merchant-tile") +
        " merchant-" +
        shipment.merchant.toLowerCase().replace(/[^a-z]/g, "")
      }
    >
      {src && !failed ? (
        <img
          src={src}
          alt={shipment.items[0]?.name || shipment.merchant}
          onError={() => setFailed(true)}
        />
      ) : (
        shipment.merchant.slice(0, 1)
      )}
    </div>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span>
        <Package size={27} />
      </span>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function PackageForm({
  value,
  onSaved,
  onClose,
  timeZone,
}: {
  value?: Shipment;
  onSaved: (id: string) => void;
  onClose: () => void;
  timeZone: string;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState(value?.estimate?.kind || "none");
  const [items, setItems] = useState(
    value?.items.length
      ? value.items
      : [{ name: "", quantity: 1, imageUrl: null }],
  );
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const f = new FormData(e.currentTarget);
    const str = (k: string) => String(f.get(k) || "").trim();
    let estimate: Estimate | null = null;
    if (kind !== "none") {
      const start =
        str("deliveryDate") +
        (kind === "date" || kind === "date_range"
          ? ""
          : "T" + str("startTime") + ":00");
      estimate = {
        kind: kind as Estimate["kind"],
        start,
        end:
          kind === "date_range"
            ? str("endDate")
            : kind === "window"
              ? str("endDate") + "T" + str("endTime") + ":00"
              : null,
        timeZone: str("timeZone") || timeZone,
        label: null,
      };
    }
    if (
      estimate &&
      value?.estimate &&
      estimate.kind === value.estimate.kind &&
      estimate.timeZone === value.estimate.timeZone &&
      estimate.start ===
        estimateLocal(value.estimate.start, value.estimate.timeZone) &&
      estimate.end ===
        (value.estimate.end
          ? estimateLocal(value.estimate.end, value.estimate.timeZone)
          : null)
    ) {
      estimate = value.estimate;
    }
    try {
      const result = await api<{ id: string }>(
        "shipments" + (value ? "/" + value.id : ""),
        {
          merchant: str("merchant"),
          orderNumber: str("orderNumber") || null,
          orderedAt: str("orderedAt") || null,
          items,
          carrier: str("carrier") || null,
          trackingNumber: str("trackingNumber") || null,
          trackingUrl: str("trackingUrl") || null,
          status: str("status"),
          shippedAt: str("shippedAt")
            ? new Date(str("shippedAt") + "T12:00:00").toISOString()
            : null,
          estimate,
          deliveredAt: str("deliveredAt")
            ? new Date(str("deliveredAt")).toISOString()
            : null,
          manualOverride: f.get("manualOverride") === "on",
        },
        value ? "PATCH" : "POST",
      );
      onSaved(result.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save package.");
    } finally {
      setBusy(false);
    }
  }
  const timed = ["window", "point", "deadline"].includes(kind);
  const startLocal = value?.estimate
    ? estimateLocal(value.estimate.start, value.estimate.timeZone)
    : "";
  const endLocal = value?.estimate?.end
    ? estimateLocal(value.estimate.end, value.estimate.timeZone)
    : "";
  return (
    <form onSubmit={submit} className="form-body">
      <p className="form-intro">
        {value
          ? "Make a correction or fill in a missing detail."
          : "Add a package with the details you have. You can fill in the rest later."}
      </p>
      <div className="form-grid">
        <label>
          Shop
          <input
            name="merchant"
            defaultValue={value?.merchant}
            placeholder="e.g. Patagonia"
            required
            maxLength={160}
            autoFocus
          />
        </label>
        <label>
          Order number <span>Optional</span>
          <input
            name="orderNumber"
            defaultValue={value?.orderNumber || ""}
            placeholder="Order ID"
          />
        </label>
      </div>
      <div className="items-editor">
        <div className="label-row">
          <label>Items</label>
          <button
            type="button"
            className="text-button"
            onClick={() =>
              setItems([...items, { name: "", quantity: 1, imageUrl: null }])
            }
          >
            + Add item
          </button>
        </div>
        {items.map((item, i) => (
          <div className="item-edit" key={i}>
            <input
              aria-label={`Item ${i + 1} name`}
              placeholder="What’s in the package?"
              value={item.name}
              onChange={(e) =>
                setItems(
                  items.map((x, j) =>
                    j === i ? { ...x, name: e.target.value } : x,
                  ),
                )
              }
              required
            />
            <input
              aria-label={`Item ${i + 1} quantity`}
              type="number"
              min="1"
              max="10000"
              value={item.quantity}
              onChange={(e) =>
                setItems(
                  items.map((x, j) =>
                    j === i ? { ...x, quantity: Number(e.target.value) } : x,
                  ),
                )
              }
            />
            {items.length > 1 && (
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove item ${i + 1}`}
                onClick={() => setItems(items.filter((_, j) => j !== i))}
              >
                <X size={16} />
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="form-grid">
        <label>
          Carrier
          <input
            name="carrier"
            list="carriers"
            defaultValue={value?.carrier || ""}
            placeholder="e.g. UPS"
          />
          <datalist id="carriers">
            {[
              "UPS",
              "USPS",
              "FedEx",
              "DHLExpress",
              "OnTrac",
              "CanadaPost",
              "RoyalMail",
            ].map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>
        </label>
        <label>
          Tracking number
          <input
            name="trackingNumber"
            defaultValue={value?.trackingNumber || ""}
            placeholder="Tracking code"
          />
        </label>
        <label>
          Order date
          <input
            type="date"
            name="orderedAt"
            defaultValue={value?.orderedAt || ""}
          />
        </label>
        <label>
          Shipment date
          <input
            type="date"
            name="shippedAt"
            defaultValue={value?.shippedAt?.slice(0, 10) || ""}
          />
        </label>
      </div>
      <label>
        Tracking link <span>Optional</span>
        <input
          type="url"
          name="trackingUrl"
          defaultValue={value?.trackingUrl || ""}
          placeholder="https://…"
        />
      </label>
      <div className="form-divider" />
      <div className="form-grid">
        <label>
          Status
          <select name="status" defaultValue={value?.status || "ordered"}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Delivery estimate
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="none">Not available yet</option>
            <option value="date">A date</option>
            <option value="date_range">A range of dates</option>
            <option value="window">A time window</option>
            <option value="point">An approximate time</option>
            <option value="deadline">By a specific time</option>
          </select>
        </label>
      </div>
      {kind !== "none" && (
        <div className="estimate-fields">
          <div className="form-grid">
            <label>
              {kind === "date_range" ? "Earliest date" : "Delivery date"}
              <input
                name="deliveryDate"
                type="date"
                required
                defaultValue={startLocal.slice(0, 10)}
              />
            </label>
            {(kind === "date_range" || kind === "window") && (
              <label>
                {kind === "window" ? "End date" : "Latest date"}
                <input
                  name="endDate"
                  type="date"
                  required
                  defaultValue={
                    endLocal.slice(0, 10) || startLocal.slice(0, 10)
                  }
                />
              </label>
            )}
            {timed && (
              <label>
                {kind === "deadline" ? "By" : "Start time"}
                <input
                  name="startTime"
                  type="time"
                  required
                  defaultValue={startLocal.slice(11, 16)}
                />
              </label>
            )}
            {kind === "window" && (
              <label>
                End time
                <input
                  name="endTime"
                  type="time"
                  required
                  defaultValue={endLocal.slice(11, 16)}
                />
              </label>
            )}
          </div>
          <label>
            Delivery time zone
            <input
              name="timeZone"
              defaultValue={value?.estimate?.timeZone || timeZone}
              required
            />
          </label>
        </div>
      )}
      <label>
        Actual delivery time <span>If known</span>
        <input
          name="deliveredAt"
          type="datetime-local"
          defaultValue={
            value?.deliveredAt
              ? new Date(
                  new Date(value.deliveredAt).getTime() -
                    new Date(value.deliveredAt).getTimezoneOffset() * 60000,
                )
                  .toISOString()
                  .slice(0, 16)
              : ""
          }
        />
      </label>
      <label className="check-label">
        <input
          type="checkbox"
          name="manualOverride"
          defaultChecked={value?.manualOverride}
        />
        <span>Keep my status and delivery estimate until I turn this off.</span>
      </label>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="modal-actions">
        <button className="secondary" type="button" onClick={onClose}>
          Cancel
        </button>
        <button className="primary" disabled={busy}>
          {busy ? <Spinner /> : null}
          {value ? "Save changes" : "Add package"}
        </button>
      </div>
    </form>
  );
}
export function GoogleMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65Z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59a14.4 14.4 0 0 1 0-9.18l-7.98-6.19A23.87 23.87 0 0 0 0 24c0 3.87.93 7.53 2.56 10.78l7.97-6.19Z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.91-5.8l-7.73-6c-2.15 1.45-4.92 2.3-8.18 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z"
      />
    </svg>
  );
}
export function AuthForm({
  onSuccess: _onSuccess,
  preview,
  onClose,
  initialError = "",
}: {
  onSuccess: () => void;
  preview: boolean;
  onClose?: () => void;
  initialError?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const [googleAvailable, setGoogleAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    void api<{ google: boolean }>("auth/config")
      .then((x) => setGoogleAvailable(x.google))
      .catch(() => {});
  }, []);
  async function google() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ url: string }>("auth/google/start", {});
      window.location.assign(result.url);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not start Google sign-in.",
      );
      setBusy(false);
    }
  }
  return (
    <div className="auth-form">
      <span className="brand-icon">
        <Package size={27} />
      </span>
      <h1>Welcome home.</h1>
      <p>One place for everything on its way to your door.</p>
      <button
        type="button"
        className="google-button full"
        onClick={() => void google()}
        disabled={busy}
      >
        {busy ? <Spinner /> : <GoogleMark />}Continue with Google
      </button>
      <small className="auth-caption">
        Sign in or create an account with Google.{" "}
        <a className="privacy-link" href="/privacy">
          Privacy policy
        </a>
      </small>
      <div className="auth-household-note">
        <Users size={20} />
        <p>
          If someone added your Google email, you’ll join their household
          automatically. Otherwise, we’ll create one for you.
        </p>
      </div>
      {googleAvailable === false && (
        <div className="info-box">
          Google sign-in is awaiting configuration by the person hosting
          PorchPong.
        </div>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <small className="auth-caption">
        Your delivery calendar is connected separately in Settings.
      </small>
      {preview && onClose && (
        <button type="button" className="secondary full" onClick={onClose}>
          Back to sample household
        </button>
      )}
    </div>
  );
}
