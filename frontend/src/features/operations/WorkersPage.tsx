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
import { useRestartAllAndRecover, useRestartWorker, useWorkers } from "./hooks";
import type { RestartAllAndRecoverResult } from "./types";
import { SkeletonCards, SkeletonPanel } from "../../components/Skeleton";
import { EmptyPanel } from "../../components/ListPageUi";
import { Banner, METRIC_ICON, MetricGrid, MetricTile } from "../system/opsUi";

export function WorkersPage() {
  const { t } = useTranslation();
  const list = useWorkers();
  const restartOne = useRestartWorker();
  const restartAll = useRestartAllAndRecover();
  const [restartAllOpen, setRestartAllOpen] = useState(false);
  const [lastResult, setLastResult] = useState<RestartAllAndRecoverResult | null>(null);

  const onRestart = (cameraId: number) => {
    restartOne.mutate(cameraId);
  };

  const onRestartAll = () => {
    restartAll.mutate(undefined, {
      onSuccess: (result) => {
        setLastResult(result);
      },
      onSettled: () => setRestartAllOpen(false),
    });
  };

  const summary = list.data?.summary;
  const workers = list.data?.workers ?? [];
  const noWorkers = !list.isLoading && !list.isError && workers.length === 0;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("operations.workers.title") as string}</h1>
          <p className="page-sub">{t("operations.workers.subtitle") as string}</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => void list.refetch()} disabled={list.isFetching}>
            <Icon name="refresh" size={12} />
            {t("operations.actions.refreshNow") as string}
          </button>
          <button type="button" className="btn btn-danger" onClick={() => setRestartAllOpen(true)} disabled={workers.length === 0}>
            <Icon name="refresh" size={12} />
            {t("operations.actions.restartAll") as string}
          </button>
        </div>
      </div>

      {/* Recovery result banner — shown after a successful Restart
          All Workers. The X button dismisses it. */}
      {lastResult && (
        <div style={{ marginBottom: 16 }}>
          <Banner tone="success" role="status" icon={<Icon name="check" size={14} />}>
            <span>
              <strong>{t("operations.restart.resultTitle") as string}</strong>
              {" — "}
              <span className="text-dim">
                {t("operations.restart.resultCapture", {
                  restarted: lastResult.capture_restarted,
                  total: lastResult.capture_total,
                }) as string}
              </span>
              {" · "}
              <span className="text-dim">
                {t("operations.restart.resultRecovery", {
                  scanned: lastResult.recovery.scanned,
                  a: lastResult.recovery.class_a,
                  b: lastResult.recovery.class_b,
                  c: lastResult.recovery.class_c,
                }) as string}
              </span>
            </span>
            <span className="ops-banner-spacer" />
            <button type="button" className="icon-btn" aria-label={t("common.dismiss") as string} onClick={() => setLastResult(null)}>
              <Icon name="x" size={12} />
            </button>
          </Banner>
        </div>
      )}

      {list.isLoading && (
        <div className="ops-stack">
          <SkeletonCards count={5} minWidth={180} />
          <SkeletonPanel lines={4} />
          <SkeletonPanel lines={4} />
        </div>
      )}

      {list.isError && (
        <div className="card">
          <EmptyPanel
            tone="danger"
            icon={<Icon name="info" size={30} />}
            title={t("operations.workers.loadFailedTitle", { defaultValue: "Couldn't load workers" })}
            body={t("operations.workers.loadFailed") as string}
            actions={
              <button type="button" className="btn" onClick={() => void list.refetch()}>
                <Icon name="refresh" size={12} />
                {t("common.retry", { defaultValue: "Retry" })}
              </button>
            }
          />
        </div>
      )}

      {noWorkers && (
        <div className="card">
          <EmptyPanel
            tone="accent"
            icon={<Icon name="camera" size={30} />}
            title={t("operations.workers.emptyTitle", { defaultValue: "No capture workers yet" })}
            body={t("operations.workers.empty") as string}
            actions={
              <a href="/cameras" className="btn btn-primary">
                <Icon name="plus" size={12} />
                {t("operations.workers.goToCameras") as string}
              </a>
            }
          />
        </div>
      )}

      {!list.isLoading && !list.isError && workers.length > 0 && (
        <>
          {/* Summary strip */}
          <MetricGrid>
            <MetricTile
              tone={summary ? (summary.running === summary.configured ? "success" : summary.running === 0 ? "danger" : "warning") : "neutral"}
              icon={METRIC_ICON.activity}
              label={t("operations.summary.running") as string}
              value={summary ? `${summary.running} / ${summary.configured}` : "—"}
              sub={t("operations.summary.runningSub", { defaultValue: "Running / configured" })}
            />
            <MetricTile
              tone={summary ? (summary.stages_red_count > 0 ? "danger" : summary.stages_amber_count > 0 ? "warning" : "success") : "neutral"}
              icon={METRIC_ICON.alert}
              label={t("operations.summary.stagesIssues") as string}
              value={summary ? summary.stages_red_count + summary.stages_amber_count : "—"}
              sub={
                summary
                  ? t("operations.summary.stagesIssuesSub", {
                      defaultValue: "{{red}} red · {{amber}} amber",
                      red: summary.stages_red_count,
                      amber: summary.stages_amber_count,
                    })
                  : ""
              }
            />
            <MetricTile
              tone={summary && summary.errors_5min_total > 0 ? "warning" : "neutral"}
              icon={METRIC_ICON.x}
              label={t("operations.summary.errors5min") as string}
              value={summary ? summary.errors_5min_total : "—"}
              sub={t("operations.summary.errors5minSub", { defaultValue: "Across all workers" })}
            />
            <MetricTile
              tone="info"
              icon={METRIC_ICON.eye}
              label={t("operations.summary.detectionsLastHour") as string}
              value={summary ? summary.detection_events_last_hour : "—"}
              sub={t("operations.summary.lastHourSub", { defaultValue: "Last 60 minutes" })}
            />
            <MetricTile
              tone="success"
              icon={METRIC_ICON.users}
              label={t("operations.summary.matchesLastHour") as string}
              value={summary ? summary.successful_matches_last_hour : "—"}
              sub={t("operations.summary.lastHourSub", { defaultValue: "Last 60 minutes" })}
            />
          </MetricGrid>

          {workers.map((w) => (
            <WorkerCard key={`${w.tenant_id}-${w.camera_id}`} worker={w} onRestart={onRestart} restartPending={restartOne.isPending} />
          ))}
        </>
      )}

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
