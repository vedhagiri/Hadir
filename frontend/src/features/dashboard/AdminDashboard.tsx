// Admin dashboard — the Admin's morning page. Answers, in order:
//   1. Today at a glance      (who is in / late / not in yet / absent / on leave)
//   2. Needs your attention   (actionable links, hidden when zero)
//   3. System health          (cameras + recognition rate + one pipeline line)
//   4. Latest sightings       (face crop, person, camera, time ago)
//   5. Attendance trend       (last 14 working days, same numbers as Insights/PDF)
//   6. Storage                (compact)
//
// Existing endpoints only:
//   /api/insights/overview (today + a 28-day window for the trend)
//   /api/system/health, /api/system/cameras-health, /api/operations/workers
//   /api/requests/inbox/summary, /api/employees/photos/pending
//   /api/detection-events (latest rows + page_size=1 counts for today)
// Everything polls at 60 s (the trend at 5 min) — no per-row fetches.

import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";

import { api } from "../../api/client";
import { useMe } from "../../auth/AuthProvider";
import { SkeletonCards, SkeletonChart, SkeletonLines } from "../../components/Skeleton";
import { useInboxSummary } from "../../requests/hooks";
import { Icon } from "../../shell/Icon";
import type { IconName } from "../../shell/Icon";
import { useTenantDateTime } from "../../util/datetime";
import { addDaysIso, tenantBound, tenantDayKey } from "../camera-logs/clUi";
import type { DetectionEvent, DetectionEventListResponse } from "../camera-logs/types";
import { avatarBg, initials } from "../employees/EmployeesPage";
import { AttendanceTrendChart, InsightsNotice } from "../insights/insightsUi";
import type { InsightsOverview, InsightsTrendDay } from "../insights/types";
import type { WorkersListResponse, WorkerStatus } from "../operations/types";
import type { SystemHealth, StorageStats } from "../system/types";
import { Panel, PanelEmpty, PanelError, SegmentBar, Tile, TileGrid, firstName } from "./DashUi";

import "./admin-dash.css";

const K = "dashboard.admin";
const POLL = 60_000;

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/** /api/system/cameras-health row. The shared type still says
 *  ``enabled``; the API sends ``worker_enabled`` (P28.5b rename). */
interface CamHealthRow {
  camera_id: number;
  name: string;
  location: string;
  worker_enabled?: boolean;
  enabled?: boolean;
  last_seen_at: string | null;
  latest_frames_last_minute: number;
  latest_reachable: boolean;
}

interface PendingPhotos {
  items: Array<{ photo_id: number }>;
}

function useHealth() {
  return useQuery({
    queryKey: ["system", "health"],
    queryFn: () => api<SystemHealth>("/api/system/health"),
    refetchInterval: POLL,
  });
}

function useCams() {
  return useQuery({
    queryKey: ["system", "cameras-health"],
    queryFn: () => api<{ items: CamHealthRow[] }>("/api/system/cameras-health"),
    refetchInterval: POLL,
  });
}

function useWorkersSlow() {
  return useQuery({
    queryKey: ["operations", "workers"],
    queryFn: () => api<WorkersListResponse>("/api/operations/workers"),
    refetchInterval: POLL,
  });
}

function usePendingPhotos() {
  return useQuery({
    queryKey: ["employees", "photo-approvals", "pending"],
    queryFn: () => api<PendingPhotos>("/api/employees/photos/pending"),
    refetchInterval: POLL,
  });
}

function useOverview(start: string, end: string, refetch: number) {
  return useQuery({
    queryKey: ["insights", "overview", start, end, null],
    queryFn: () => api<InsightsOverview>(`/api/insights/overview?start=${start}&end=${end}`),
    refetchInterval: refetch,
    staleTime: 30_000,
  });
}

function useSightings() {
  return useQuery({
    queryKey: ["dashboard", "admin", "sightings"],
    queryFn: () => api<DetectionEventListResponse>("/api/detection-events?page=1&page_size=6"),
    refetchInterval: POLL,
  });
}

/** Today's event counts (tenant-local day): all / unidentified / former. */
function useTodayCounts(today: string, tz: string) {
  const start = tenantBound(today, "00:00:00", tz);
  const end = tenantBound(today, "23:59:59", tz);
  const base = `start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&page=1&page_size=1`;
  const paths = [base, `identified=false&${base}`, `former_only=true&${base}`];
  return useQueries({
    queries: paths.map((p) => ({
      queryKey: ["dashboard", "admin", "count", p],
      queryFn: async () => (await api<DetectionEventListResponse>(`/api/detection-events?${p}`)).total,
      refetchInterval: POLL,
    })),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function useAgo() {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  return (iso: string | null | undefined, now: number): string => {
    if (!iso) return t(`${K}.ago.never`, { defaultValue: "Never" });
    const ms = now - new Date(iso).getTime();
    if (!Number.isFinite(ms)) return "—";
    const min = Math.max(0, Math.floor(ms / 60_000));
    if (min < 1) return t(`${K}.ago.justNow`, { defaultValue: "Just now" });
    if (min < 60) return t(`${K}.ago.minutes`, { defaultValue: "{{n}} min ago", n: min });
    const h = Math.floor(min / 60);
    if (h < 24) return t(`${K}.ago.hours`, { defaultValue: "{{n}} h ago", n: h });
    const d = Math.floor(h / 24);
    if (d < 7) return t(`${K}.ago.days`, { defaultValue: "{{n}} d ago", n: d });
    return dt.formatDate(iso);
  };
}

function hasRecords(d: InsightsTrendDay): boolean {
  return d.present + d.absent + d.leave > 0;
}

function fmtInt(n: number): string {
  return n.toLocaleString();
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return v >= 100 || i === 0 ? `${v.toFixed(0)} ${units[i]}` : `${v.toFixed(1)} ${units[i]}`;
}

type CamState = "online" | "reconnecting" | "offline" | "paused";

interface CamView {
  id: number;
  name: string;
  location: string;
  state: CamState;
  lastSeen: string | null;
}

const RECONNECT_WINDOW_MS = 15 * 60_000;

function camState(c: CamHealthRow, worker: WorkerStatus | undefined, now: number): CamState {
  const enabled = c.worker_enabled ?? c.enabled ?? true;
  if (!enabled) return "paused";
  if (c.latest_reachable) return "online";
  const recent = c.last_seen_at != null && now - new Date(c.last_seen_at).getTime() < RECONNECT_WINDOW_MS;
  if ((worker === "reconnecting" || worker === "starting") && recent) return "reconnecting";
  return "offline";
}

const CAM_ORDER: Record<CamState, number> = { offline: 0, reconnecting: 1, online: 2, paused: 3 };

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AdminDashboard() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const me = useMe();
  const now = useNow();
  const tz = me.data?.tenant_timezone ?? "Asia/Muscat";
  const today = tenantDayKey(tz, new Date(now));

  const health = useHealth();
  const cams = useCams();
  const workers = useWorkersSlow();
  const inbox = useInboxSummary();
  const photos = usePendingPhotos();
  const todayOv = useOverview(today, today, POLL);
  const trendOv = useOverview(addDaysIso(today, -27), today, 5 * POLL);
  const sightings = useSightings();
  const [cAll, cUnknown, cFormer] = useTodayCounts(today, tz);

  const retry = t("dashboard.common.retry", { defaultValue: "Retry" });
  const failedBody = t("dashboard.common.loadFailedBody", { defaultValue: "The API did not respond. Try again in a moment." });

  // ---- Cameras -------------------------------------------------------------
  const camViews: CamView[] = useMemo(() => {
    const ws = new Map<number, WorkerStatus>((workers.data?.workers ?? []).map((w) => [w.camera_id, w.status]));
    return (cams.data?.items ?? [])
      .map((c) => ({
        id: c.camera_id,
        name: c.name,
        location: c.location,
        state: camState(c, ws.get(c.camera_id), now),
        lastSeen: c.last_seen_at,
      }))
      .sort((a, b) => CAM_ORDER[a.state] - CAM_ORDER[b.state] || a.name.localeCompare(b.name));
  }, [cams.data, workers.data, now]);
  const camsActive = camViews.filter((c) => c.state !== "paused");
  const camsDown = camViews.filter((c) => c.state === "offline" || c.state === "reconnecting");
  const camsOnline = camViews.filter((c) => c.state === "online").length;

  // ---- Today ---------------------------------------------------------------
  const ov = todayOv.data;
  const total = ov?.kpis.total ?? 0;
  const inToday = ov?.kpis.present ?? 0;
  const lateToday = ov?.kpis.late ?? 0;
  const absentToday = ov?.kpis.absent ?? 0;
  const leaveToday = ov?.kpis.leave ?? 0;
  const waitingToday = ov?.breakdown.find((b) => b.key === "waiting")?.count ?? 0;
  const attPct = total > 0 ? Math.round((inToday / total) * 100) : null;

  // Same weekday last week (or the latest earlier working day with records).
  const trendDays = trendOv.data?.trend ?? [];
  const refDay = useMemo(() => {
    const sameWd = trendDays.find((d) => d.date === addDaysIso(today, -7));
    if (sameWd && hasRecords(sameWd) && !sameWd.is_weekend && !sameWd.is_holiday) return { day: sameWd, sameWeekday: true };
    for (let i = trendDays.length - 1; i >= 0; i--) {
      const d = trendDays[i]!;
      if (d.date < today && !d.is_weekend && !d.is_holiday && hasRecords(d)) return { day: d, sameWeekday: false };
    }
    return null;
  }, [trendDays, today]);

  const lang = i18n.language;
  const weekdayOf = (iso: string) =>
    new Date(`${iso}T12:00:00Z`).toLocaleDateString(lang, { weekday: "long", timeZone: "UTC" });
  const shortDate = (iso: string) =>
    new Date(`${iso}T12:00:00Z`).toLocaleDateString(lang, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const dateLabel = new Date(`${today}T12:00:00Z`).toLocaleDateString(lang, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });

  // ---- Counts --------------------------------------------------------------
  const eventsToday = cAll?.data ?? null;
  const unknownToday = cUnknown?.data ?? null;
  const formerToday = cFormer?.data ?? 0;
  const identifiedToday = eventsToday !== null && unknownToday !== null ? Math.max(0, eventsToday - unknownToday) : null;
  const recognition = eventsToday && identifiedToday !== null ? Math.round((identifiedToday / eventsToday) * 100) : null;

  const h = health.data;
  const noPhoto = h ? Math.max(0, h.employees_active - h.enrolled_employees) : 0;
  const storage = h?.storage;
  const diskPct = storage && storage.disk_total_bytes > 0 ? Math.round((storage.disk_used_bytes / storage.disk_total_bytes) * 100) : null;

  // Sparse data: most people unseen today because photos / cameras are missing.
  const sparse = !!ov && total > 0 && (attPct ?? 0) < 10 && absentToday + waitingToday > total * 0.5;

  return (
    <div className="adm">
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {me.data
              ? t(`${K}.greeting`, { defaultValue: "Good day, {{name}}", name: firstName(me.data.full_name) })
              : t(`${K}.title`, { defaultValue: "Dashboard" })}
          </h1>
          <p className="page-sub">
            {t(`${K}.subtitleToday`, {
              defaultValue: "{{date}} · today's attendance, what needs you, and how the system is doing",
              date: dateLabel,
            })}
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => navigate("/insights")}>
            <Icon name="sparkles" size={13} />
            {t(`${K}.openInsights`, { defaultValue: "Insights" })}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => navigate("/daily-attendance")}>
            <Icon name="users" size={13} />
            {t(`${K}.openDaily`, { defaultValue: "Daily attendance" })}
          </button>
        </div>
      </div>

      {/* ---- 1. Today at a glance ----------------------------------------- */}
      <h2 className="adm-section">{t(`${K}.glance.title`, { defaultValue: "Today at a glance" })}</h2>
      {todayOv.isLoading ? (
        <div className="adm-gap">
          <SkeletonCards count={5} minWidth={180} />
        </div>
      ) : todayOv.isError ? (
        <div className="card adm-gap">
          <PanelError
            title={t(`${K}.glance.loadFailed`, { defaultValue: "Couldn't load today's attendance" })}
            body={failedBody}
            retryLabel={retry}
            onRetry={() => void todayOv.refetch()}
          />
        </div>
      ) : (
        <div className="adm-glance">
        <TileGrid>
          <Tile
            tone="success"
            icon="check"
            label={t(`${K}.glance.in`, { defaultValue: "In today" })}
            value={
              <>
                {attPct ?? 0}
                <span className="adm-of">%</span>
              </>
            }
            sub={
              <>
                {t(`${K}.glance.inSub`, { defaultValue: "{{n}} of {{total}} in", n: fmtInt(inToday), total: fmtInt(total) })}
                {refDay && (
                  <span
                    className="adm-ref"
                    title={t(`${K}.glance.refTitle`, { defaultValue: "Full day on {{date}}", date: shortDate(refDay.day.date) })}
                  >
                    {refDay.sameWeekday
                      ? t(`${K}.glance.vsWeekday`, { defaultValue: "Last {{weekday}}: {{pct}}%", weekday: weekdayOf(refDay.day.date), pct: refDay.day.present_pct })
                      : t(`${K}.glance.vsDay`, { defaultValue: "{{date}}: {{pct}}%", date: shortDate(refDay.day.date), pct: refDay.day.present_pct })}
                  </span>
                )}
              </>
            }
            extra={ov && ov.arrivals.length > 1 ? <ArrivalsSpark buckets={ov.arrivals} /> : undefined}
            onClick={() => navigate("/daily-attendance")}
          />
          <Tile
            tone="warning"
            icon="clock"
            label={t(`${K}.glance.late`, { defaultValue: "Late" })}
            value={fmtInt(lateToday)}
            sub={
              inToday > 0
                ? t(`${K}.glance.lateSub`, { defaultValue: "{{pct}}% of those in", pct: Math.round((lateToday / inToday) * 100) })
                : t(`${K}.glance.lateSubNone`, { defaultValue: "Arrived after the grace period" })
            }
            onClick={() => navigate("/daily-attendance")}
          />
          <Tile
            tone="info"
            icon="activity"
            label={t(`${K}.glance.waiting`, { defaultValue: "Not in yet" })}
            value={fmtInt(waitingToday)}
            sub={t(`${K}.glance.waitingSub`, { defaultValue: "Shift still open" })}
            onClick={() => navigate("/daily-attendance")}
          />
          <Tile
            tone="danger"
            icon="user"
            label={t(`${K}.glance.absent`, { defaultValue: "Absent" })}
            value={fmtInt(absentToday)}
            sub={t(`${K}.glance.absentSub`, { defaultValue: "No sighting, no approved leave" })}
            onClick={() => navigate("/daily-attendance")}
          />
          <Tile
            tone="accent"
            icon="calendar"
            label={t(`${K}.glance.leave`, { defaultValue: "On leave" })}
            value={fmtInt(leaveToday)}
            sub={t(`${K}.glance.leaveSub`, { defaultValue: "Approved leave today" })}
            onClick={() => navigate("/daily-attendance")}
          />
        </TileGrid>
        </div>
      )}

      {sparse && (
        <InsightsNotice
          tone="info"
          icon="camera"
          title={t(`${K}.sparse.title`, { defaultValue: "Most people haven't been seen by a camera today" })}
          body={[
            noPhoto > 0 && h
              ? t(`${K}.sparse.photos`, {
                  defaultValue: "{{n}} of {{total}} employees have no reference photo, so they can't be recognised.",
                  n: fmtInt(noPhoto),
                  total: fmtInt(h.employees_active),
                })
              : null,
            camsActive.length > 0 && camsDown.length > 0
              ? t(`${K}.sparse.cameras`, {
                  defaultValue: "{{n}} of {{total}} cameras are not capturing.",
                  n: camsDown.length,
                  total: camsActive.length,
                })
              : null,
            t(`${K}.sparse.hint`, { defaultValue: "Until that's fixed, attendance reads lower than it really is." }),
          ]
            .filter(Boolean)
            .join(" ")}
          action={
            <>
              <Link className="btn btn-sm" to="/employees">
                {t(`${K}.sparse.photosBtn`, { defaultValue: "Employee photos" })}
              </Link>
              <Link className="btn btn-sm" to="/cameras">
                {t(`${K}.sparse.camerasBtn`, { defaultValue: "Cameras" })}
              </Link>
            </>
          }
        />
      )}

      {/* ---- 2. Needs attention | 3. System health ------------------------- */}
      <div className="adm-row adm-row-even">
        <AttentionPanel
          loading={health.isLoading || cams.isLoading || inbox.isLoading || photos.isLoading}
          failed={[health, cams, inbox, photos, cUnknown, cFormer].some((q) => q?.isError)}
          onRetry={() => {
            for (const q of [health, cams, inbox, photos, cUnknown, cFormer]) if (q?.isError) void q.refetch();
          }}
          items={([
            camsDown.length > 0 && {
              id: "cams",
              tone: "danger",
              icon: "camera",
              to: "/cameras",
              count: camsDown.length,
              title: t(`${K}.attn.cameras`, { defaultValue: "Cameras not capturing" }),
              detail: camsDown.map((c) => c.name).join(", "),
            },
            (inbox.data?.pending_count ?? 0) > 0 && {
              id: "approvals",
              tone: (inbox.data?.breached_count ?? 0) > 0 ? "danger" : "warning",
              icon: "inbox",
              to: "/approvals",
              count: inbox.data?.pending_count ?? 0,
              title: t(`${K}.attn.approvals`, { defaultValue: "Requests waiting for approval" }),
              detail:
                (inbox.data?.breached_count ?? 0) > 0
                  ? t(`${K}.attn.approvalsBreached`, { defaultValue: "{{n}} past the response time", n: inbox.data?.breached_count ?? 0 })
                  : t(`${K}.attn.approvalsSub`, { defaultValue: "Leave and exception requests" }),
            },
            (photos.data?.items.length ?? 0) > 0 && {
              id: "photos",
              tone: "warning",
              icon: "shield",
              to: "/photo-approvals",
              count: photos.data?.items.length ?? 0,
              title: t(`${K}.attn.photos`, { defaultValue: "Photos waiting for approval" }),
              detail: t(`${K}.attn.photosSub`, { defaultValue: "Uploaded reference photos to review" }),
            },
            noPhoto > 0 &&
              h && {
                id: "nophoto",
                tone: "warning",
                icon: "user",
                to: "/employees",
                count: noPhoto,
                title: t(`${K}.attn.noPhoto`, { defaultValue: "Employees who can't be recognised" }),
                detail: t(`${K}.attn.noPhotoSub`, {
                  defaultValue: "No reference photo yet · {{enrolled}} of {{total}} ready",
                  enrolled: fmtInt(h.enrolled_employees),
                  total: fmtInt(h.employees_active),
                }),
              },
            (unknownToday ?? 0) > 0 && {
              id: "unknown",
              tone: "info",
              icon: "eye",
              to: "/unidentified-faces",
              count: unknownToday ?? 0,
              title: t(`${K}.attn.unknown`, { defaultValue: "Unidentified faces today" }),
              detail: t(`${K}.attn.unknownSub`, { defaultValue: "Review and map them to employees" }),
            },
            diskPct !== null &&
              diskPct >= 80 && {
                id: "storage",
                tone: diskPct >= 90 ? "danger" : "warning",
                icon: "database",
                to: "/storage-analytics",
                count: `${diskPct}%`,
                title: t(`${K}.attn.storage`, { defaultValue: "Storage is filling up" }),
                detail: t(`${K}.attn.storageSub`, {
                  defaultValue: "{{free}} free of {{total}}",
                  free: formatBytes(storage?.disk_free_bytes ?? 0),
                  total: formatBytes(storage?.disk_total_bytes ?? 0),
                }),
              },
            formerToday > 0 && {
              id: "former",
              tone: "danger",
              icon: "shield",
              to: "/former-employees",
              count: formerToday,
              title: t(`${K}.attn.former`, { defaultValue: "Former employees seen today" }),
              detail: t(`${K}.attn.formerSub`, { defaultValue: "People who have left were recognised on camera" }),
            },
          ] as Array<AttnItem | false | undefined>).filter((x): x is AttnItem => !!x)}
        />

        <HealthPanel
          loading={cams.isLoading}
          error={cams.isError}
          onRetry={() => void cams.refetch()}
          cams={camViews}
          online={camsOnline}
          active={camsActive.length}
          now={now}
          eventsToday={eventsToday}
          identifiedToday={identifiedToday}
          recognition={recognition}
          workers={workers.data ?? null}
          schedulerRunning={h ? h.attendance_scheduler_running : null}
        />
      </div>

      {/* ---- 5. Trend | 4. Latest sightings -------------------------------- */}
      <div className="adm-row adm-row-wide">
        <TrendPanel
          days={trendDays}
          today={today}
          loading={trendOv.isLoading}
          error={trendOv.isError}
          onRetry={() => void trendOv.refetch()}
        />
        <SightingsPanel
          items={sightings.data?.items ?? null}
          loading={sightings.isLoading}
          error={sightings.isError}
          onRetry={() => void sightings.refetch()}
          now={now}
        />
      </div>

      {/* ---- 6. Storage --------------------------------------------------- */}
      {health.isError ? (
        <Panel title={t(`${K}.storage.title`, { defaultValue: "Storage" })}>
          <PanelError
            title={t(`${K}.storage.loadFailed`, { defaultValue: "Couldn't load storage" })}
            body={failedBody}
            retryLabel={retry}
            onRetry={() => void health.refetch()}
          />
        </Panel>
      ) : health.isLoading ? (
        <Panel title={t(`${K}.storage.title`, { defaultValue: "Storage" })}>
          <SkeletonLines lines={3} />
        </Panel>
      ) : storage ? (
        <StoragePanel storage={storage} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Arrivals sparkline (today, 30-minute buckets)
// ---------------------------------------------------------------------------

function ArrivalsSpark({ buckets }: { buckets: Array<{ bucket: string; count: number }> }) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const W = 112;
  const H = 26;
  const gap = 2;
  const bw = Math.max(2, (W - gap * (buckets.length - 1)) / buckets.length);
  return (
    <svg className="adm-spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      {buckets.map((b, i) => {
        const bh = Math.max(1.5, (b.count / max) * H);
        return <rect key={b.bucket} x={i * (bw + gap)} y={H - bh} width={bw} height={bh} rx={1.5} />;
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Needs your attention
// ---------------------------------------------------------------------------

interface AttnItem {
  id: string;
  tone: "danger" | "warning" | "info";
  icon: IconName;
  to: string;
  count: number | string;
  title: string;
  detail: string;
}

function AttentionPanel({
  items,
  loading,
  failed,
  onRetry,
}: {
  items: AttnItem[];
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Panel
      title={t(`${K}.attn.title`, { defaultValue: "Needs your attention" })}
      sub={t(`${K}.attn.sub`, { defaultValue: "Things you can act on right now" })}
    >
      {loading ? (
        <SkeletonLines lines={6} />
      ) : items.length === 0 && !failed ? (
        <PanelEmpty
          tone="success"
          icon="check"
          title={t(`${K}.attn.clear`, { defaultValue: "All clear" })}
          body={t(`${K}.attn.clearBody`, { defaultValue: "Cameras, approvals, photos and storage all look fine." })}
        />
      ) : (
        <>
          <ul className="adm-attn">
            {items.map((it) => (
              <li key={it.id}>
                <Link to={it.to} className="adm-attn-row">
                  <span className={`adm-attn-icon is-${it.tone}`} aria-hidden>
                    <Icon name={it.icon} size={16} />
                  </span>
                  <span className="adm-attn-text">
                    <span className="adm-attn-title">{it.title}</span>
                    <span className="adm-attn-detail" title={it.detail}>
                      {it.detail}
                    </span>
                  </span>
                  <span className={`adm-attn-count is-${it.tone}`}>{typeof it.count === "number" ? fmtInt(it.count) : it.count}</span>
                  <span className="adm-attn-chev" aria-hidden>
                    <Icon name="chevronRight" size={14} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {failed && (
            <div className="adm-attn-failed">
              <Icon name="info" size={13} />
              <span>{t(`${K}.attn.someFailed`, { defaultValue: "Some checks couldn't load." })}</span>
              <button type="button" className="btn btn-sm btn-ghost" onClick={onRetry}>
                {t("dashboard.common.retry", { defaultValue: "Retry" })}
              </button>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// System health
// ---------------------------------------------------------------------------

const CAM_SHOWN = 6;

function HealthPanel({
  loading,
  error,
  onRetry,
  cams,
  online,
  active,
  now,
  eventsToday,
  identifiedToday,
  recognition,
  workers,
  schedulerRunning,
}: {
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  cams: CamView[];
  online: number;
  active: number;
  now: number;
  eventsToday: number | null;
  identifiedToday: number | null;
  recognition: number | null;
  workers: WorkersListResponse | null;
  schedulerRunning: boolean | null;
}) {
  const { t } = useTranslation();
  const ago = useAgo();
  const stateLabel: Record<CamState, string> = {
    online: t(`${K}.health.state.online`, { defaultValue: "Online" }),
    reconnecting: t(`${K}.health.state.reconnecting`, { defaultValue: "Reconnecting" }),
    offline: t(`${K}.health.state.offline`, { defaultValue: "Offline" }),
    paused: t(`${K}.health.state.paused`, { defaultValue: "Paused" }),
  };

  // One plain-language pipeline line.
  const s = workers?.summary;
  let pipeTone: "success" | "warning" | "danger" | "neutral" = "neutral";
  let pipeText = t(`${K}.health.pipeLoading`, { defaultValue: "Checking the capture pipeline…" });
  if (s) {
    if (s.configured === 0) {
      pipeText = t(`${K}.health.pipeNone`, { defaultValue: "No cameras are capturing yet." });
    } else if (s.running === s.configured && s.stages_red_count === 0) {
      pipeTone = "success";
      pipeText = t(`${K}.health.pipeOk`, { defaultValue: "All {{n}} cameras are capturing and recognising normally.", n: s.configured });
    } else if (s.running === 0) {
      pipeTone = "danger";
      pipeText = t(`${K}.health.pipeDown`, { defaultValue: "No camera is capturing right now — attendance can't be recorded." });
    } else {
      pipeTone = "warning";
      pipeText = t(`${K}.health.pipePartial`, {
        defaultValue: "{{running}} of {{total}} cameras capturing — some sightings may be missed.",
        running: s.running,
        total: s.configured,
      });
    }
  }
  if (schedulerRunning === false) {
    pipeTone = "danger";
    pipeText = `${pipeText} ${t(`${K}.health.schedulerOff`, { defaultValue: "Attendance calculation is paused." })}`;
  }

  const shown = cams.slice(0, CAM_SHOWN);

  return (
    <Panel
      title={t(`${K}.health.title`, { defaultValue: "System health" })}
      sub={
        active > 0
          ? t(`${K}.health.sub`, { defaultValue: "{{online}} of {{total}} cameras online", online, total: active })
          : t(`${K}.health.subNone`, { defaultValue: "No active cameras" })
      }
      actions={
        <Link className="btn btn-sm btn-ghost" to="/pipeline-monitor">
          {t(`${K}.health.monitor`, { defaultValue: "Pipeline Monitor" })}
        </Link>
      }
    >
      {loading ? (
        <SkeletonLines lines={6} />
      ) : error ? (
        <PanelError
          title={t(`${K}.health.loadFailed`, { defaultValue: "Couldn't load camera health" })}
          body={t("dashboard.common.loadFailedBody", { defaultValue: "The API did not respond. Try again in a moment." })}
          retryLabel={t("dashboard.common.retry", { defaultValue: "Retry" })}
          onRetry={onRetry}
        />
      ) : (
        <>
          <div className={`adm-pipe is-${pipeTone}`}>
            <span className="adm-dot" aria-hidden />
            <span>{pipeText}</span>
          </div>

          <div className="adm-facts">
            <div>
              <div className="adm-fact-value">{recognition !== null ? `${recognition}%` : "—"}</div>
              <div className="adm-fact-label">{t(`${K}.health.recognition`, { defaultValue: "Recognised today" })}</div>
              <div className="adm-fact-sub">
                {eventsToday
                  ? t(`${K}.health.recognitionSub`, {
                      defaultValue: "{{n}} of {{total}} faces",
                      n: fmtInt(identifiedToday ?? 0),
                      total: fmtInt(eventsToday),
                    })
                  : t(`${K}.health.noFacesToday`, { defaultValue: "No faces seen yet today" })}
              </div>
            </div>
            <div>
              <div className="adm-fact-value">{eventsToday !== null ? fmtInt(eventsToday) : "—"}</div>
              <div className="adm-fact-label">{t(`${K}.health.sightings`, { defaultValue: "Sightings today" })}</div>
              <div className="adm-fact-sub">
                {workers
                  ? t(`${K}.health.lastHour`, { defaultValue: "{{n}} in the last hour", n: fmtInt(workers.summary.detection_events_last_hour) })
                  : "—"}
              </div>
            </div>
          </div>

          {cams.length === 0 ? (
            <PanelEmpty
              icon="camera"
              title={t(`${K}.health.noCams`, { defaultValue: "No cameras added yet" })}
              action={
                <Link className="btn btn-sm" to="/cameras">
                  {t(`${K}.health.addCamera`, { defaultValue: "Add a camera" })}
                </Link>
              }
            />
          ) : (
            <ul className="adm-cams">
              {shown.map((c) => (
                <li key={c.id} className="adm-cam">
                  <span className={`adm-dot is-${c.state}`} aria-hidden />
                  <span className="adm-cam-text">
                    <span className="adm-cam-name">{c.name}</span>
                    {c.location && <span className="adm-cam-loc">{c.location}</span>}
                  </span>
                  <span className={`adm-cam-state is-${c.state}`}>{stateLabel[c.state]}</span>
                  <span className="adm-cam-seen" title={t(`${K}.health.lastSeen`, { defaultValue: "Last frame" })}>
                    {c.state === "online" ? t(`${K}.health.liveNow`, { defaultValue: "Live now" }) : ago(c.lastSeen, now)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {cams.length > CAM_SHOWN && (
            <Link className="btn btn-sm btn-ghost adm-more" to="/cameras">
              {t(`${K}.health.allCams`, { defaultValue: "View all {{n}} cameras", n: cams.length })}
            </Link>
          )}
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Latest sightings
// ---------------------------------------------------------------------------

function SightingsPanel({
  items,
  loading,
  error,
  onRetry,
  now,
}: {
  items: DetectionEvent[] | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  now: number;
}) {
  const { t } = useTranslation();
  const ago = useAgo();
  return (
    <Panel
      title={t(`${K}.sightings.title`, { defaultValue: "Latest sightings" })}
      sub={t(`${K}.sightings.sub`, { defaultValue: "Faces the cameras saw most recently" })}
      actions={
        <Link className="btn btn-sm btn-ghost" to="/camera-logs">
          {t(`${K}.sightings.viewAll`, { defaultValue: "Camera logs" })}
        </Link>
      }
    >
      {loading ? (
        <SkeletonLines lines={6} />
      ) : error ? (
        <PanelError
          title={t(`${K}.sightings.loadFailed`, { defaultValue: "Couldn't load sightings" })}
          body={t("dashboard.common.loadFailedBody", { defaultValue: "The API did not respond. Try again in a moment." })}
          retryLabel={t("dashboard.common.retry", { defaultValue: "Retry" })}
          onRetry={onRetry}
        />
      ) : !items || items.length === 0 ? (
        <PanelEmpty
          tone="accent"
          icon="camera"
          title={t(`${K}.sightings.empty`, { defaultValue: "No sightings yet" })}
          body={t(`${K}.sightings.emptyBody`, { defaultValue: "Faces appear here as soon as a camera sees someone." })}
        />
      ) : (
        <ul className="adm-sight">
          {items.map((ev) => {
            const name = ev.employee_name ?? (ev.former_employee_match ? ev.former_match_employee_name ?? null : null);
            const to = ev.employee_id ? `/employees/${ev.employee_id}` : "/camera-logs";
            return (
              <li key={ev.id}>
                <Link to={to} className="adm-sight-row">
                  <SightThumb ev={ev} name={name} />
                  <span className="adm-sight-text">
                    <span className="adm-sight-name">
                      {name ?? t(`${K}.sightings.unknown`, { defaultValue: "Unknown person" })}
                      {ev.former_employee_match && (
                        <span className="pill pill-danger adm-sight-tag">{t(`${K}.sightings.former`, { defaultValue: "Former" })}</span>
                      )}
                    </span>
                    <span className="adm-sight-meta">{ev.camera_name}</span>
                  </span>
                  <span className="adm-sight-time">{ago(ev.captured_at, now)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function SightThumb({ ev, name }: { ev: DetectionEvent; name: string | null }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  if (ev.has_crop && !failed) {
    return (
      <span className="adm-thumb">
        <img
          src={`/api/detection-events/${ev.id}/crop`}
          alt={t(`${K}.sightings.cropAlt`, { defaultValue: "Face seen on camera" })}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      </span>
    );
  }
  return (
    <span className="adm-thumb is-empty" style={name ? { background: avatarBg(name) } : undefined} aria-hidden>
      {name ? initials(name) : <Icon name="user" size={16} />}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Attendance trend — last 14 working days
// ---------------------------------------------------------------------------

function TrendPanel({
  days,
  today,
  loading,
  error,
  onRetry,
}: {
  days: InsightsTrendDay[];
  today: string;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const working = days.filter((d) => !d.is_weekend && !d.is_holiday);
  const last = working.slice(-14);
  const from = last[0]?.date ?? today;
  const shown = days.filter((d) => d.date >= from);
  const complete = last.filter((d) => d.date < today);
  const withData = complete.filter(hasRecords);
  const avg = withData.length ? Math.round(withData.reduce((s, d) => s + d.present_pct, 0) / withData.length) : null;
  const best = withData.reduce<InsightsTrendDay | null>((b, d) => (!b || d.present_pct > b.present_pct ? d : b), null);
  const lateTotal = withData.reduce((s, d) => s + d.late, 0);
  const lang = useTranslation().i18n.language;
  const short = (iso: string) =>
    new Date(`${iso}T12:00:00Z`).toLocaleDateString(lang, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

  return (
    <Panel
      title={t(`${K}.trend.title`, { defaultValue: "Attendance trend" })}
      sub={t(`${K}.trend.sub`, { defaultValue: "Share of employees who came in · last 14 working days" })}
      actions={
        <Link className="btn btn-sm btn-ghost" to="/insights">
          {t(`${K}.trend.open`, { defaultValue: "Open Insights" })}
        </Link>
      }
    >
      {loading ? (
        <SkeletonChart height={220} />
      ) : error ? (
        <PanelError
          title={t(`${K}.trend.loadFailed`, { defaultValue: "Couldn't load the trend" })}
          body={t("dashboard.common.loadFailedBody", { defaultValue: "The API did not respond. Try again in a moment." })}
          retryLabel={t("dashboard.common.retry", { defaultValue: "Retry" })}
          onRetry={onRetry}
        />
      ) : (
        <>
          <div className="adm-trend-facts">
            <TrendFact
              value={avg !== null ? `${avg}%` : "—"}
              label={t(`${K}.trend.avg`, { defaultValue: "Average attendance" })}
            />
            <TrendFact
              value={best ? `${best.present_pct}%` : "—"}
              label={best ? t(`${K}.trend.best`, { defaultValue: "Best day · {{date}}", date: short(best.date) }) : t(`${K}.trend.bestNone`, { defaultValue: "Best day" })}
            />
            <TrendFact value={fmtInt(lateTotal)} label={t(`${K}.trend.late`, { defaultValue: "Late arrivals" })} />
            <TrendFact
              value={`${withData.length}/${complete.length}`}
              label={t(`${K}.trend.recorded`, { defaultValue: "Days with records" })}
            />
          </div>
          {complete.length > 0 && withData.length < complete.length / 2 && (
            <p className="adm-trend-note">
              <Icon name="info" size={13} />
              {t(`${K}.trend.sparse`, {
                defaultValue: "Only {{n}} of the last {{total}} working days have attendance records — days without records are shown as a flat line.",
                n: withData.length,
                total: complete.length,
              })}
            </p>
          )}
          <AttendanceTrendChart
            days={shown}
            height={220}
            reference={avg}
            referenceLabel={t(`${K}.trend.avgRef`, { defaultValue: "14-day average" })}
          />
        </>
      )}
    </Panel>
  );
}

function TrendFact({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div>
      <div className="adm-fact-value">{value}</div>
      <div className="adm-fact-label">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Storage — compact
// ---------------------------------------------------------------------------

function StoragePanel({ storage }: { storage: StorageStats }) {
  const { t } = useTranslation();
  const total = storage.disk_total_bytes || 1;
  const tenantBytes =
    storage.face_crops_bytes + storage.attachments_bytes + storage.reports_bytes + storage.erp_exports_bytes + storage.db_size_bytes;
  const usedPct = Math.min(100, Math.round((storage.disk_used_bytes / total) * 100));
  const tenantPct = (tenantBytes / total) * 100;
  const otherUsed = Math.max(0, storage.disk_used_bytes - tenantBytes);
  const free = Math.max(0, storage.disk_free_bytes);
  const tone = usedPct >= 90 ? "danger" : usedPct >= 80 ? "warning" : "neutral";

  return (
    <Panel
      title={t(`${K}.storage.title`, { defaultValue: "Storage" })}
      sub={t(`${K}.storage.sub`, { defaultValue: "Disk space on the server and what this workspace uses" })}
      actions={
        <Link className="btn btn-sm btn-ghost" to="/storage-analytics">
          {t(`${K}.storage.open`, { defaultValue: "Storage analytics" })}
        </Link>
      }
    >
      <div className="adm-storage">
        <div className="adm-storage-disk">
          <div className="adm-storage-head">
            <span className={`adm-storage-pct is-${tone}`}>{usedPct}%</span>
            <span className="adm-storage-of">
              {t(`${K}.storage.used`, {
                defaultValue: "used · {{free}} free of {{total}}",
                free: formatBytes(free),
                total: formatBytes(storage.disk_total_bytes),
              })}
            </span>
          </div>
          <SegmentBar
            label={t(`${K}.storage.aria`, { defaultValue: "Disk used: {{pct}}%", pct: usedPct })}
            segments={[
              { tone: "accent", value: tenantBytes, title: `${t(`${K}.storage.legendTenant`, { defaultValue: "This workspace" })} — ${formatBytes(tenantBytes)}` },
              { tone: tone === "neutral" ? "neutral" : tone, value: otherUsed, title: `${t(`${K}.storage.legendOther`, { defaultValue: "Everything else" })} — ${formatBytes(otherUsed)}` },
              { tone: "free", value: free, title: `${t(`${K}.storage.legendFree`, { defaultValue: "Free" })} — ${formatBytes(free)}` },
            ]}
          />
        </div>
        <div className="adm-storage-facts">
          <div>
            <div className="adm-fact-value">{formatBytes(tenantBytes)}</div>
            <div className="adm-fact-label">
              {t(`${K}.storage.tenant`, {
                defaultValue: "This workspace · {{pct}}% of disk",
                pct: tenantPct < 1 ? "<1" : Math.round(tenantPct),
              })}
            </div>
          </div>
          <div>
            <div className="adm-fact-value">{fmtInt(storage.detection_events_total)}</div>
            <div className="adm-fact-label">
              {t(`${K}.storage.events`, { defaultValue: "Captured faces · {{size}}", size: formatBytes(storage.face_crops_bytes) })}
            </div>
          </div>
          <div>
            <div className="adm-fact-value">{formatBytes(storage.db_size_bytes)}</div>
            <div className="adm-fact-label">{t(`${K}.storage.db`, { defaultValue: "Database" })}</div>
          </div>
          <div>
            <div className="adm-fact-value">{fmtInt(storage.attendance_records_total)}</div>
            <div className="adm-fact-label">{t(`${K}.storage.attendance`, { defaultValue: "Attendance records" })}</div>
          </div>
        </div>
      </div>
    </Panel>
  );
}
