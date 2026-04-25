// Settings → Integrations → ERP Export. Admin-only.
//
// Operators configure the daily file-drop here: format (CSV / JSON),
// relative output path under the tenant root, cron, and a window
// (default 1 day = today). "Run now" hits POST .../run-now and
// streams the produced file back so the operator can verify the
// schema before pointing the ERP at the directory.

import { useEffect, useState } from "react";

import { ApiError } from "../api/client";
import { describeCron } from "../scheduled-reports/cronPreview";
import { SettingsTabs } from "../settings/SettingsTabs";
import { Icon } from "../shell/Icon";
import {
  useErpExportConfig,
  usePatchErpExportConfig,
} from "./hooks";
import type { ErpFormat } from "./types";

export function ErpExportPage() {
  const cfg = useErpExportConfig();
  const patch = usePatchErpExportConfig();

  const [enabled, setEnabled] = useState(false);
  const [format, setFormat] = useState<ErpFormat>("csv");
  const [outputPath, setOutputPath] = useState("");
  const [scheduleCron, setScheduleCron] = useState("");
  const [windowDays, setWindowDays] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!cfg.data) return;
    setEnabled(cfg.data.enabled);
    setFormat(cfg.data.format);
    setOutputPath(cfg.data.output_path);
    setScheduleCron(cfg.data.schedule_cron);
    setWindowDays(cfg.data.window_days);
  }, [cfg.data]);

  const onSave = async () => {
    setError(null);
    setInfo(null);
    try {
      await patch.mutateAsync({
        enabled,
        format,
        output_path: outputPath,
        schedule_cron: scheduleCron,
        window_days: windowDays,
      });
      setInfo("Saved.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Save failed.");
    }
  };

  const onRunNow = async () => {
    setError(null);
    setInfo(null);
    setRunning(true);
    try {
      const resp = await fetch("/api/erp-export-config/run-now", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!resp.ok) {
        const detail = await resp
          .json()
          .then((b) => b.detail)
          .catch(() => null);
        setError(
          detail ?? `Run failed (${resp.status}). Check the audit log.`,
        );
        return;
      }
      const blob = await resp.blob();
      const cd = resp.headers.get("content-disposition") ?? "";
      const m = /filename="([^"]+)"/.exec(cd);
      const filename = m
        ? m[1] ?? "hadir-attendance.csv"
        : "hadir-attendance.csv";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setInfo(`Wrote ${filename} to the tenant drop directory.`);
      cfg.refetch();
    } catch {
      setError("Network error running the export.");
    } finally {
      setRunning(false);
    }
  };

  if (cfg.isLoading) return <p>Loading ERP export settings…</p>;
  if (cfg.error)
    return (
      <p style={{ color: "var(--danger-text)" }}>
        Couldn’t load ERP export settings.
      </p>
    );
  if (!cfg.data) return <p>Sign in to manage ERP export.</p>;

  const cronLabel = describeCron(scheduleCron || "");

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
          ERP file-drop export
        </h1>
        <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 13 }}>
          Hadir writes a daily attendance file the client ERP polls.
          Output always lives under{" "}
          <span className="mono">{cfg.data.tenant_root}</span> — paths
          that escape that root are rejected on save. See{" "}
          <span className="mono">docs/erp-file-drop-schema.md</span>{" "}
          for the column reference you can hand to the ERP team.
        </p>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSave();
        }}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: 18,
          maxWidth: 720,
        }}
      >
        <label
          style={{ display: "flex", gap: 6, fontSize: 13, alignItems: "center" }}
        >
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Run scheduled exports
        </label>

        <Field label="Format">
          <div style={{ display: "flex", gap: 6 }}>
            {(["csv", "json"] as ErpFormat[]).map((f) => (
              <label
                key={f}
                className={`pill ${format === f ? "pill-accent" : "pill-neutral"}`}
                style={{ cursor: "pointer", textTransform: "uppercase" }}
              >
                <input
                  type="radio"
                  name="format"
                  value={f}
                  checked={format === f}
                  onChange={() => setFormat(f)}
                  style={{ display: "none" }}
                />
                {f}
              </label>
            ))}
          </div>
        </Field>

        <Field
          label="Output path (relative to tenant root)"
          hint={
            outputPath
              ? `Files will land in ${cfg.data.tenant_root}/${outputPath.replace(/^\/+/, "")}`
              : `Files will land directly under ${cfg.data.tenant_root}`
          }
        >
          <input
            className="input mono"
            value={outputPath}
            onChange={(e) => setOutputPath(e.target.value)}
            placeholder="incoming/attendance"
          />
        </Field>

        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}
        >
          <Field
            label="Cron schedule"
            hint={
              scheduleCron && cronLabel !== scheduleCron
                ? cronLabel
                : "Leave empty to disable automatic runs."
            }
          >
            <input
              className="input mono"
              value={scheduleCron}
              onChange={(e) => setScheduleCron(e.target.value)}
              placeholder="0 1 * * *"
            />
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
        </div>

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

        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={patch.isPending}
          >
            {patch.isPending ? "Saving…" : "Save changes"}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void onRunNow()}
            disabled={running}
          >
            <Icon name="download" size={12} />{" "}
            {running ? "Running…" : "Run now"}
          </button>
        </div>
      </form>

      <section
        style={{
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: 18,
          maxWidth: 720,
        }}
      >
        <h2 style={{ fontSize: 16, margin: "0 0 8px 0" }}>Last run</h2>
        {cfg.data.last_run_at ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 6,
              fontSize: 13,
            }}
          >
            <Fact
              label="When"
              value={new Date(cfg.data.last_run_at).toLocaleString()}
            />
            <Fact label="Status" value={cfg.data.last_run_status ?? "—"} />
            <Fact
              label="File"
              value={cfg.data.last_run_path ?? "—"}
              mono
              full
            />
            {cfg.data.last_run_error && (
              <Fact
                label="Error"
                value={cfg.data.last_run_error}
                full
              />
            )}
            {cfg.data.next_run_at && (
              <Fact
                label="Next run"
                value={new Date(cfg.data.next_run_at).toLocaleString()}
              />
            )}
          </div>
        ) : (
          <p style={{ color: "var(--text-secondary)", margin: 0 }}>
            No runs yet. Hit "Run now" to verify the schema before the
            cron picks it up.
          </p>
        )}
      </section>
    </div>
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

function Fact({
  label,
  value,
  mono,
  full,
}: {
  label: string;
  value: string;
  mono?: boolean;
  full?: boolean;
}) {
  return (
    <div
      style={{
        gridColumn: full ? "1 / -1" : "auto",
        background: "var(--bg-sunken)",
        padding: "6px 8px",
        borderRadius: 6,
      }}
    >
      <div
        className="text-xs text-dim"
        style={{
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      <div className={mono ? "mono" : ""} style={{ fontSize: 13 }}>
        {value}
      </div>
    </div>
  );
}
