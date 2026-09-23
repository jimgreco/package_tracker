"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "../components";

type Account = {
  id: string;
  name: string;
  plan: "free" | "paid";
  createdAt: string;
  members: { name: string; email: string; role: string }[];
};

export default function AdminPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(async () => {
    try {
      setAccounts(await api<Account[]>("admin/accounts"));
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not load accounts.",
      );
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function change(account: Account, plan: Account["plan"]) {
    setBusy(account.id);
    try {
      await api(`admin/accounts/${account.id}/plan`, { plan }, "PATCH");
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not update this account.",
      );
    } finally {
      setBusy("");
    }
  }

  return (
    <main className="admin-page">
      <a href="/?view=settings">← Settings</a>
      <h1>Accounts</h1>
      <p>
        Paid accounts can connect Gmail and use carrier API tracking. Free
        accounts receive updates through forwarded emails.
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {!loaded && <p>Loading accounts…</p>}
      {loaded && !error && accounts.length === 0 && <p>No accounts yet.</p>}
      <div className="admin-accounts">
        {accounts.map((account) => (
          <section className="settings-card" key={account.id}>
            <div className="settings-title">
              <h2>{account.name}</h2>
              <span className="status">
                {account.plan === "paid" ? "Paid" : "Free"}
              </span>
            </div>
            <p className="admin-account-id">Account ID: {account.id}</p>
            <ul>
              {account.members.map((member) => (
                <li key={member.email}>
                  {member.name} · {member.email} ({member.role})
                </li>
              ))}
            </ul>
            <label>
              Access level
              <select
                value={account.plan}
                disabled={!!busy}
                onChange={(event) =>
                  void change(account, event.target.value as Account["plan"])
                }
              >
                <option value="free">Free · forwarding</option>
                <option value="paid">Paid · Gmail and carrier API</option>
              </select>
            </label>
          </section>
        ))}
      </div>
    </main>
  );
}
