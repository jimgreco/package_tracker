"use client";

import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { api, Modal } from "./components";

export function QuickNote({
  id,
  merchant,
  note,
  onSaved,
}: {
  id: string;
  merchant: string;
  note: string | null;
  onSaved: (id: string, note: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) return;
    const frame = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [editing]);

  function open() {
    setDraft(note || "");
    setError("");
    setEditing(true);
  }

  async function save() {
    if (saving) return;
    const next = draft.trim();
    if (next === (note || "")) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const result = await api<{ note: string | null }>(
        `shipments/${id}/note`,
        { note: next || null },
        "PATCH",
      );
      onSaved(id, result.note);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save your note.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="package-note-trigger"
        aria-label={`${note ? "Edit" : "Add"} note for ${merchant}`}
        title={`${note ? "Edit" : "Add"} note for ${merchant}`}
        onClick={open}
      >
        <Pencil size={15} aria-hidden="true" />
        {note ? "Edit note" : "Add note"}
      </button>
      {editing && (
        <Modal
          title={`Note for ${merchant}`}
          onClose={() => !saving && setEditing(false)}
        >
          <div className="package-note-form">
            <label htmlFor={`quick-note-${id}`}>Your note</label>
            <textarea
              ref={textareaRef}
              id={`quick-note-${id}`}
              maxLength={1000}
              rows={5}
              placeholder="How you'll recognize this package"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setError("");
              }}
            />
            <p>Optional, up to 1,000 characters.</p>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                disabled={saving}
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={saving}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : "Save note"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
