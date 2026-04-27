// Operations / Workers — tenant Admin only.
//
// 5-second polling. Summary strip + per-worker cards.
// Restart-all has type-to-confirm. Sort defaults to "most-broken
// first" (red stages descending) — operators see what needs
// attention without scrolling.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "../../shell/Icon";
import { RestartAllModal } from "./RestartAllModal";
import { WorkerCard } from "./WorkerCard";
import {
  useRestartAllWorkers,
  useRestartWorker,
  useWorkers,
} from "./hooks";

export function WorkersPage() {
  const { t } = useTranslation();
  const list = useWorkers();
  const restartOne = useRestartWorker();
  const restartAll = useRestartAllWorkers();
  const [restartAllOpen, setRestartAllOpen] = useState(false);

  const onRestart = (cameraId: number) => {
    restartOne.mutate(cameraId);
  };

  const onRestartAll = () => {
    restartAll.mutate(undefined, {
      onSettled: () => setRestartAllOpen(false),
    });
  };

  const summary = list.data?.summary;
  const workers = list.data?.workers ?? [];

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {t("operations.workers.title") as string}
          </h1>
          <p className="page-sub">
            {t("operations.workers.subtitle") as string}
          </p>
        </div>
        <div className="page-actions">
          <button
            className="btn"
            onClick={() => list.refetch()}
            disabled={list.isFetching}
          >
            <Icon name="refresh" size={12} />
            {t("operations.actions.refreshNow") as string}
          </button>
          <button
            className="btn"
            style={{ background: "var(--danger)", color: "white" }}
            onClick={() => setRestartAllOpen(true)}
            disabled={workers.length === 0}
          >
            {t("operations.actions.restartAll") as string}
          </button>
        </div>
      </div>

      {/* Summary strip */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 10,
          marginBottom: 16,
        }}
      >
        <SummaryCard
          label={t("operations.summary.running") as string}
          value={
            summary
              ? `${summary.running} / ${summary.configured}`
              : "—"
          }
          tone={
            summary
              ? summary.running === summary.configured
                ? "success"
                : summary.running === 0
                  ? "danger"
                  : "warning"
              : "neutral"
          }
        />
        <SummaryCard
          label={t("operations.summary.stagesIssues") as string}
          value={
            summary
              ? `${summary.stages_red_count} red · ${summary.stages_amber_count} amber`
              : "—"
          }
          tone={
            summary
              ? summary.stages_red_count > 0
                ? "danger"
                : summary.stages_amber_count > 0
                  ? "warning"
                  : "success"
              : "neutral"
          }
        />
        <SummaryCard
          label={t("operations.summary.errors5min") as string}
          value={summary ? String(summary.errors_5min_total) : "—"}
          tone={
            summary && summary.errors_5min_total > 0 ? "warning" : "neutral"
          }
        />
        <SummaryCard
          label={t("operations.summary.detectionsLastHour") as string}
          value={summary ? String(summary.detection_events_last_hour) : "—"}
          tone="neutral"
        />
        <SummaryCard
          label={t("operations.summary.matchesLastHour") as string}
          value={summary ? String(summary.successful_matches_last_hour) : "—"}
          tone="neutral"
        />
      </div>

      {/* Worker list */}
      {list.isLoading && (
        <div className="text-sm text-dim">
          {t("common.loading") as string}
        </div>
      )}
      {list.isError && (
        <div className="text-sm" style={{ color: "var(--danger-text)" }}>
          {t("operations.workers.loadFailed") as string}
        </div>
      )}
      {!list.isLoading && workers.length === 0 && (
        <div
          className="card"
          style={{ padding: 24, textAlign: "center" }}
        >
          <div className="text-sm text-dim">
            {t("operations.workers.empty") as string}
          </div>
          <a
            href="/cameras"
            style={{
              display: "inline-block",
              marginTop: 8,
              fontSize: 13,
              color: "var(--accent)",
              textDecoration: "underline",
            }}
          >
            {t("operations.workers.goToCameras") as string}
          </a>
        </div>
      )}
      {workers.map((w) => (
        <WorkerCard
          key={`${w.tenant_id}-${w.camera_id}`}
          worker={w}
          onRestart={onRestart}
          restartPending={restartOne.isPending}
        />
      ))}

      {restartAllOpen && (
        <RestartAllModal
          workerCount={summary?.configured ?? workers.length}
          onCancel={() => setRestartAllOpen(false)}
          onConfirm={onRestartAll}
          pending={restartAll.isPending}
        />
      )}
    </>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "success" | "warning" | "danger" | "neutral";
}) {
  const toneToColor: Record<string, string> = {
    success: "var(--success)",
    warning: "var(--warning)",
    danger: "var(--danger)",
    neutral: "var(--text-tertiary)",
  };
  return (
    <div
      className="card"
      style={{
        padding: "12px 14px",
        borderInlineStart: `3px solid ${toneToColor[tone]}`,
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--text-tertiary)",
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 18,
          fontWeight: 600,
          marginTop: 4,
          color: "var(--text)",
        }}
      >
        {value}
      </div>
    </div>
  );
}
