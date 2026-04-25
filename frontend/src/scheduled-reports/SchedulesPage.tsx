// Settings → Report Schedules. Admin-managed list; HR can read.

import { useState } from "react";

import { ApiError } from "../api/client";
import { SettingsTabs } from "../settings/SettingsTabs";
import { Icon } from "../shell/Icon";
import { describeCron } from "./cronPreview";
import {
  useCreateSchedule,
  useDeleteSchedule,
  usePatchSchedule,
  useReportRuns,
  useReportSchedules,
  useRunNow,
} from "./hooks";
import type {
  ReportFormat,
  ReportSchedule,
  ReportScheduleCreateInput,
} from "./types";

export function SchedulesPage() {
  const schedules = useReportSchedules();
  const create = useCreateSchedule();
  const patch = usePatchSchedule();
  const remove = useDeleteSchedule();
  const runNow = useRunNow();
  const recentRuns = useReportRuns(null);

  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const onRunNow = async (s: ReportSchedule) => {
    setError(null);
    setInfo(null);
    try {
      const run = await runNow.mutateAsync(s.id);
      setInfo(
        run.status === "succeeded"
          ? `Sent · ${run.recipients_delivered_to.length} recipient(s) · delivery=${run.delivery_mode}`
          : `Run ${run.status}: ${run.error_message ?? "see report-runs log"}`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Run failed.");
    }
  };

  const onToggleActive = (s: ReportSchedule) => {
    patch.mutate({ id: s.id, input: { active: !s.active } });
  };

  const onDelete = (s: ReportSchedule) => {
    if (
      window.confirm(
        `Delete schedule '${s.name}'? Past runs stay in the audit log; future deliveries stop.`,
      )
    ) {
      remove.mutate(s.id);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SettingsTabs />
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
        }}
      >
        <div>
          <h1
            style={{
              fontFamily: "var(--font-display)",
              fontSize: 28,
              margin: "0 0 4px 0",
              fontWeight: 400,
            }}
          >
            Report schedules
          </h1>
          <p
            style={{
              margin: 0,
              color: "var(--text-secondary)",
              fontSize: 13,
            }}
          >
            Recurring attendance reports — Excel or PDF — emailed to
            the recipient list. Configure email credentials in the
            Email tab first. Files larger than the cap auto-fall back
            to a signed-URL link valid for 7 days.
          </p>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => setShowCreate((s) => !s)}
        >
          <Icon name="plus" size={12} /> {showCreate ? "Close" : "New schedule"}
        </button>
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
      {info && (
        <div
          style={{
            background: "var(--bg-sunken)",
            padding: "8px 10px",
            borderRadius: "var(--radius-sm)",
            fontSize: 12.5,
          }}
        >
          {info}
        </div>
      )}

      {showCreate && (
        <CreateForm
          onCreate={(input) => create.mutateAsync(input)}
          onClose={() => setShowCreate(false)}
        />
      )}

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Format</th>
              <th>Schedule</th>
              <th>Recipients</th>
              <th>Last run</th>
              <th>Next run</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {schedules.isLoading ? (
              <tr>
                <td colSpan={7} className="text-sm text-dim">
                  Loading…
                </td>
              </tr>
            ) : (schedules.data ?? []).length === 0 ? (
              <tr>
                <td colSpan={7} className="text-sm text-dim">
                  No schedules yet.
                </td>
              </tr>
            ) : (
              schedules.data!.map((s) => (
                <tr key={s.id}>
                  <td>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {s.name}
                    </div>
                    <div className="text-xs text-dim">
                      window {s.filter_config.window_days}d
                    </div>
                  </td>
                  <td>
                    <span
                      className={`pill ${s.format === "pdf" ? "pill-info" : "pill-neutral"}`}
                    >
                      {s.format}
                    </span>
                  </td>
                  <td>
                    <div style={{ fontSize: 13 }}>
                      {describeCron(s.schedule_cron)}
                    </div>
                    <div className="text-xs text-dim mono">
                      {s.schedule_cron}
                    </div>
                  </td>
                  <td className="text-xs">{s.recipients.length}</td>
                  <td>
                    {s.last_run_at ? (
                      <>
                        <div className="text-xs">
                          {new Date(s.last_run_at).toLocaleString()}
                        </div>
                        <span
                          className={`pill ${s.last_run_status === "succeeded" ? "pill-success" : "pill-warning"}`}
                        >
                          {s.last_run_status}
                        </span>
                      </>
                    ) : (
                      <span className="text-dim">—</span>
                    )}
                  </td>
                  <td className="text-xs">
                    {s.next_run_at
                      ? new Date(s.next_run_at).toLocaleString()
                      : "—"}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      className="btn btn-sm"
                      onClick={() => void onRunNow(s)}
                      disabled={runNow.isPending}
                    >
                      Run now
                    </button>{" "}
                    <button
                      className="btn btn-sm"
                      onClick={() => onToggleActive(s)}
                      disabled={patch.isPending}
                    >
                      {s.active ? "Pause" : "Resume"}
                    </button>{" "}
                    <button
                      className="btn btn-sm"
                      onClick={() => onDelete(s)}
                      disabled={remove.isPending}
                      style={{ color: "var(--danger-text)" }}
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

      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Recent runs</h2>
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Schedule</th>
                <th>Status</th>
                <th>Delivery</th>
                <th>Size</th>
                <th>Started</th>
                <th>Finished</th>
              </tr>
            </thead>
            <tbody>
              {(recentRuns.data ?? []).length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-sm text-dim">
                    No runs yet.
                  </td>
                </tr>
              ) : (
                recentRuns.data!.slice(0, 20).map((r) => (
                  <tr key={r.id}>
                    <td className="mono text-xs">#{r.id}</td>
                    <td className="text-xs">
                      {r.schedule_id ? `#${r.schedule_id}` : "—"}
                    </td>
                    <td>
                      <span
                        className={`pill ${r.status === "succeeded" ? "pill-success" : r.status === "failed" ? "pill-danger" : "pill-warning"}`}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="text-xs">{r.delivery_mode ?? "—"}</td>
                    <td className="mono text-xs">
                      {r.file_size_bytes != null
                        ? `${(r.file_size_bytes / 1024).toFixed(0)} KB`
                        : "—"}
                    </td>
                    <td className="text-xs">
                      {new Date(r.started_at).toLocaleString()}
                    </td>
                    <td className="text-xs">
                      {r.finished_at
                        ? new Date(r.finished_at).toLocaleString()
                        : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

function CreateForm({
  onCreate,
  onClose,
}: {
  onCreate: (input: ReportScheduleCreateInput) => Promise<unknown>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [format, setFormat] = useState<ReportFormat>("pdf");
  const [windowDays, setWindowDays] = useState(7);
  const [recipientsText, setRecipientsText] = useState("");
  const [cronExpr, setCronExpr] = useState("0 8 * * 1");
  const [error, setError] = useState<string | null>(null);

  const cronLabel = describeCron(cronExpr);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const recipients = recipientsText
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (recipients.length === 0) {
      setError("Pick at least one recipient.");
      return;
    }
    try {
      await onCreate({
        name: name.trim(),
        format,
        filter_config: { window_days: windowDays },
        recipients,
        schedule_cron: cronExpr.trim(),
        active: true,
      });
      setName("");
      setRecipientsText("");
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Save failed.");
    }
  };

  return (
    <form
      onSubmit={submit}
      style={{
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: 14,
        display: "grid",
        gridTemplateColumns: "1.4fr 1fr 1fr 1fr",
        gap: 10,
        alignItems: "end",
      }}
    >
      <Field label="Name">
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Weekly attendance"
        />
      </Field>
      <Field label="Format">
        <select
          className="input"
          value={format}
          onChange={(e) => setFormat(e.target.value as ReportFormat)}
        >
          <option value="pdf">PDF</option>
          <option value="xlsx">Excel</option>
        </select>
      </Field>
      <Field label="Window (days)">
        <input
          className="input"
          type="number"
          min={1}
          max={180}
          value={windowDays}
          onChange={(e) => setWindowDays(Number(e.target.value))}
        />
      </Field>
      <Field
        label="Cron expression"
        {...(cronLabel === cronExpr ? {} : { hint: cronLabel })}
      >
        <input
          className="input mono"
          value={cronExpr}
          onChange={(e) => setCronExpr(e.target.value)}
          placeholder="0 8 * * 1"
        />
      </Field>
      <div style={{ gridColumn: "1 / -1" }}>
        <Field label="Recipients (comma or newline separated)">
          <textarea
            className="input"
            rows={2}
            value={recipientsText}
            onChange={(e) => setRecipientsText(e.target.value)}
            placeholder="hr@company.com, manager@company.com"
            style={{ resize: "vertical" }}
          />
        </Field>
      </div>
      {error && (
        <div
          style={{
            gridColumn: "1 / -1",
            color: "var(--danger-text)",
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}
      <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary">
          Save schedule
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--text-tertiary)",
        }}
      >
        {label}
      </span>
      {children}
      {hint && (
        <span style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>
          {hint}
        </span>
      )}
    </label>
  );
}
