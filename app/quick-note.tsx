"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./components";

export function QuickNote({
  id,
  note,
  onSaved,
}: {
  id: string;
  note: string | null;
  onSaved: (id: string, note: string | null) => void;
}) {
  const [draft, setDraft] = useState(note || "");
  const [saved, setSaved] = useState(note || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const savingRef = useRef(false);

  const save = useCallback(
    async (value: string) => {
      const next = value.trim();
      if (savingRef.current || next === saved) return;
      savingRef.current = true;
      setSaving(true);
      setError("");
      try {
        const result = await api<{ note: string | null }>(
          `shipments/${id}/note`,
          { note: next || null },
          "PATCH",
        );
        setSaved(result.note || "");
        onSaved(id, result.note);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save your note.");
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [id, onSaved, saved],
  );

  useEffect(() => {
    if (saving || error || draft.trim() === saved) return;
    const timer = setTimeout(() => void save(draft), 800);
    return () => clearTimeout(timer);
  }, [draft, saved, saving, error, save]);

  useEffect(() => {
    const current = note || "";
    if (!saving && !error && draft.trim() === saved && current !== saved) {
      setDraft(current);
      setSaved(current);
    }
  }, [note, draft, saved, saving, error]);

  return (
    <div className="package-note-editor">
      <label htmlFor={`note-${id}`}>Your note</label>
      <textarea
        id={`note-${id}`}
        aria-label="Your note"
        placeholder="Click to add a note"
        maxLength={1000}
        rows={1}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setError("");
        }}
        onBlur={() => void save(draft)}
      />
      <span className="package-note-status" role="status">
        {saving
          ? "Saving…"
          : error
            ? "Could not save"
            : draft.trim() !== saved
              ? "Saving soon…"
              : ""}
      </span>
      {error && (
        <button
          type="button"
          className="subtle-button"
          onClick={() => void save(draft)}
        >
          Retry
        </button>
      )}
    </div>
  );
}
