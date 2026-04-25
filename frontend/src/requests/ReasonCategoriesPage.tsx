// Settings → Request reasons. Admin-only CRUD on the reason category
// list employees see when filing a new request. Two segmented tables
// (Exception / Leave) so the operator can extend each list separately.

import { useState } from "react";

import { ApiError } from "../api/client";
import { SettingsTabs } from "../settings/SettingsTabs";
import { Icon } from "../shell/Icon";
import {
  useCreateReasonCategory,
  useDeleteReasonCategory,
  usePatchReasonCategory,
  useReasonCategoriesAll,
} from "./hooks";
import type { ReasonCategory, RequestType } from "./types";

export function ReasonCategoriesPage() {
  const all = useReasonCategoriesAll(true);
  const [error, setError] = useState<string | null>(null);

  const exceptionRows = (all.data ?? []).filter(
    (c) => c.request_type === "exception",
  );
  const leaveRows = (all.data ?? []).filter(
    (c) => c.request_type === "leave",
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SettingsTabs />
      <header>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 28,
            margin: "0 0 4px 0",
            fontWeight: 400,
          }}
        >
          Request reasons
        </h1>
        <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 13 }}>
          The dropdown options employees see when filing an exception or
          leave request. Seeded from BRD §FR-REQ-008 — extend the list
          when HR asks. Existing requests keep their original code on the
          row, so deletions never break history.
        </p>
      </header>

      {error && (
        <div
          role="alert"
          style={{
            background: "var(--danger-soft)",
            color: "var(--danger-text)",
            border: "1px solid var(--border)",
            padding: "8px 10px",
            borderRadius: "var(--radius-sm)",
            fontSize: 12.5,
          }}
        >
          {error}
        </div>
      )}

      {all.isLoading ? (
        <p>Loading…</p>
      ) : all.error ? (
        <p style={{ color: "var(--danger-text)" }}>
          Couldn’t load reason categories.
        </p>
      ) : (
        <>
          <CategoryTable
            title="Exception reasons"
            requestType="exception"
            rows={exceptionRows}
            onError={setError}
          />
          <CategoryTable
            title="Leave reasons"
            requestType="leave"
            rows={leaveRows}
            onError={setError}
          />
        </>
      )}
    </div>
  );
}

function CategoryTable({
  title,
  requestType,
  rows,
  onError,
}: {
  title: string;
  requestType: RequestType;
  rows: ReasonCategory[];
  onError: (msg: string | null) => void;
}) {
  const create = useCreateReasonCategory();
  const patch = usePatchReasonCategory();
  const del = useDeleteReasonCategory();

  const [showCreate, setShowCreate] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    onError(null);
    try {
      await create.mutateAsync({
        request_type: requestType,
        code: code.trim(),
        name: name.trim(),
      });
      setCode("");
      setName("");
      setShowCreate(false);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Save failed.");
    }
  };

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <h2 style={{ fontSize: 16, margin: 0 }}>{title}</h2>
        <button
          className="btn btn-sm"
          onClick={() => setShowCreate((s) => !s)}
        >
          <Icon name="plus" size={12} /> {showCreate ? "Close" : "Add"}
        </button>
      </div>
      {showCreate && (
        <form
          onSubmit={submit}
          style={{
            background: "var(--bg-sunken)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: 10,
            display: "grid",
            gridTemplateColumns: "1fr 1.4fr auto",
            gap: 8,
            alignItems: "end",
          }}
        >
          <Field label="Code">
            <input
              className="input mono"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Doctor"
            />
          </Field>
          <Field label="Display name">
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Doctor's appointment"
            />
          </Field>
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={create.isPending}
          >
            {create.isPending ? "Saving…" : "Save"}
          </button>
        </form>
      )}
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 80 }}>Order</th>
              <th>Code</th>
              <th>Name</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-sm text-dim">
                  No categories yet.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono text-xs">{r.display_order}</td>
                  <td className="mono">{r.code}</td>
                  <td>{r.name}</td>
                  <td>
                    <span
                      className={`pill ${r.active ? "pill-success" : "pill-neutral"}`}
                    >
                      {r.active ? "active" : "inactive"}
                    </span>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      className="btn btn-sm"
                      onClick={() =>
                        patch.mutate({
                          id: r.id,
                          input: { active: !r.active },
                        })
                      }
                      disabled={patch.isPending}
                    >
                      {r.active ? "Hide" : "Activate"}
                    </button>{" "}
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete '${r.code}'? Existing requests keep their original code, but new submissions won't see it.`,
                          )
                        ) {
                          del.mutate(r.id);
                        }
                      }}
                      style={{ color: "var(--danger-text)" }}
                      disabled={del.isPending}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontSize: 12,
        color: "var(--text-secondary)",
      }}
    >
      <span
        style={{
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          fontWeight: 500,
          fontSize: 11,
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}
