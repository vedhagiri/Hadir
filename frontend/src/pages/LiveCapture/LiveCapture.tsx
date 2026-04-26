// P28.5 — Live Capture page.
//
// Layout ported from design-reference/pages.jsx::LiveCapture: a header
// strip with Pause/Resume + Reconnect, a 2:1 grid (viewer + camera
// list), and a full-width event-stream card below. The viewer is a
// plain <img> pointing at the MJPEG endpoint; bounding boxes are
// baked into the JPEG by the capture worker, so there's no canvas
// or SVG overlay layer.

import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useCameras } from "../../features/cameras/hooks";
import { Icon } from "../../shell/Icon";
import { useEventStream, useLiveStats } from "./hooks";
import type { LiveEvent } from "./types";

function formatTime(iso: string): string {
  // Mirror the design's HH:MM:SS local time. Timestamps from the
  // backend are UTC ISO strings; ``toLocaleTimeString`` honours the
  // browser locale + timezone.
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

function formatPct(conf: number | null): string {
  if (conf == null) return "—";
  return `${Math.round(conf * 100)}%`;
}

export function LiveCapturePage() {
  const { t } = useTranslation();
  const camerasQuery = useCameras();
  const enabledCameras = useMemo(
    () =>
      (camerasQuery.data?.items ?? []).filter((c) => c.enabled),
    [camerasQuery.data],
  );

  const [activeCamId, setActiveCamId] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const [showOnlyUnknown, setShowOnlyUnknown] = useState(false);
  const [streamNonce, setStreamNonce] = useState(0);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const stats = useLiveStats(paused ? null : activeCamId);
  const stream = useEventStream(activeCamId);

  const activeCam = useMemo(
    () => enabledCameras.find((c) => c.id === activeCamId) ?? null,
    [enabledCameras, activeCamId],
  );

  const onTogglePause = () => setPaused((p) => !p);
  const onReconnect = () => {
    setStreamNonce((n) => n + 1);
    stream.reconnect();
  };
  const onSelect = (id: number) => {
    if (id === activeCamId) return;
    setActiveCamId(id);
    setPaused(false);
    setStreamNonce((n) => n + 1);
  };

  const onExport = () => {
    if (activeCamId == null) return;
    const url = `/api/cameras/${activeCamId}/events.csv?hours=1`;
    // Same-origin; cookie auth flows automatically. Use a hidden
    // anchor to trigger the browser's download UI.
    const a = document.createElement("a");
    a.href = url;
    a.rel = "noopener";
    a.click();
  };

  const filteredEvents: LiveEvent[] = useMemo(() => {
    if (!showOnlyUnknown) return stream.events;
    return stream.events.filter((e) => e.status === "unknown");
  }, [stream.events, showOnlyUnknown]);

  const camStatus =
    stats.data?.status ??
    (stream.status === "open" ? "online" : "offline");
  const showOffline =
    activeCamId != null && !paused && stats.data && camStatus === "offline";
  const showReconnecting =
    activeCamId != null && !paused && stream.status === "reconnecting";

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("liveCapture.title")}</h1>
          <p className="page-sub">
            {t("liveCapture.subtitle")}
            {stats.data && (
              <>
                {" · "}
                <span className="mono">
                  {stats.data.fps.toFixed(1)} fps
                </span>
              </>
            )}
          </p>
        </div>
        <div className="page-actions">
          <button
            className="btn"
            onClick={onTogglePause}
            disabled={activeCamId == null}
            aria-pressed={paused}
          >
            <Icon name={paused ? "play" : "pause"} size={12} />
            {paused ? t("liveCapture.resume") : t("liveCapture.pause")}
          </button>
          <button
            className="btn"
            onClick={onReconnect}
            disabled={activeCamId == null}
          >
            <Icon name="refresh" size={12} />
            {t("liveCapture.reconnect")}
          </button>
        </div>
      </div>

      <div
        className="grid"
        style={{
          gridTemplateColumns: "2fr 1fr",
          gap: 16,
          marginBottom: 16,
        }}
      >
        {/* Viewer */}
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div className="cam-stage" style={{ aspectRatio: "16 / 8.2" }}>
            <div className="cam-bg" />
            {activeCamId == null && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "grid",
                  placeItems: "center",
                  color: "var(--text-secondary)",
                  fontSize: 13,
                }}
              >
                {t("liveCapture.selectCameraPrompt")}
              </div>
            )}
            {activeCamId != null && !paused && !showOffline && (
              <img
                ref={imgRef}
                key={`${activeCamId}-${streamNonce}`}
                src={`/api/cameras/${activeCamId}/live.mjpg?t=${streamNonce}`}
                alt={t("liveCapture.viewerAlt")}
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                }}
              />
            )}
            {activeCamId != null && paused && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "grid",
                  placeItems: "center",
                  color: "var(--text-secondary)",
                  fontSize: 13,
                }}
              >
                {t("liveCapture.paused")}
              </div>
            )}
            {showOffline && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "grid",
                  placeItems: "center",
                  color: "var(--warning-text)",
                  fontSize: 13,
                  textAlign: "center",
                  padding: 24,
                }}
              >
                {t("liveCapture.offline")}
              </div>
            )}
            {showReconnecting && (
              <div
                style={{
                  position: "absolute",
                  bottom: 12,
                  left: 12,
                  background: "rgba(0,0,0,0.45)",
                  color: "var(--bg)",
                  padding: "4px 10px",
                  borderRadius: 4,
                  fontSize: 11,
                }}
              >
                {t("liveCapture.reconnecting")}
              </div>
            )}
            {activeCam && (
              <div className="cam-label rec">
                {`CAM-${activeCam.id} · ${activeCam.name}`}
              </div>
            )}
            {stats.data && (
              <div className="cam-timestamp">
                {new Date().toISOString().slice(11, 19)}
                {" · "}
                {stats.data.fps.toFixed(1)} fps
              </div>
            )}
          </div>
          <div className="cam-meta" style={{ padding: "10px 14px" }}>
            <div className="flex items-center gap-3">
              <span
                className={`pill ${
                  camStatus === "online" ? "pill-success" : "pill-warning"
                }`}
              >
                {camStatus === "online"
                  ? t("liveCapture.statusOnline")
                  : t("liveCapture.statusOffline")}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-dim">
                {t("liveCapture.detectionsLast10m")}
                {": "}
                <span
                  className="mono"
                  style={{ color: "var(--text)" }}
                >
                  {stats.data?.detections_last_10m ?? 0}
                </span>
              </span>
              <span className="text-xs text-dim">
                {" · "}
                {t("liveCapture.known")}{" "}
                <span
                  className="mono"
                  style={{ color: "var(--success-text)" }}
                >
                  {stats.data?.known_count ?? 0}
                </span>
                {" · "}
                {t("liveCapture.unknown")}{" "}
                <span
                  className="mono"
                  style={{ color: "var(--warning-text)" }}
                >
                  {stats.data?.unknown_count ?? 0}
                </span>
              </span>
            </div>
          </div>
        </div>

        {/* Camera list */}
        <div className="card">
          <div className="card-head">
            <h3 className="card-title">{t("liveCapture.cameras")}</h3>
          </div>
          <div
            style={{
              padding: 8,
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            {camerasQuery.isLoading && (
              <div
                style={{
                  padding: 16,
                  textAlign: "center",
                  color: "var(--text-secondary)",
                  fontSize: 12,
                }}
              >
                {t("common.loading")}
              </div>
            )}
            {!camerasQuery.isLoading && enabledCameras.length === 0 && (
              <div
                style={{
                  padding: 16,
                  textAlign: "center",
                  color: "var(--text-secondary)",
                  fontSize: 12,
                }}
              >
                {t("liveCapture.noCameras")}
              </div>
            )}
            {enabledCameras.map((c) => {
              const active = c.id === activeCamId;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onSelect(c.id)}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 7,
                    cursor: "pointer",
                    background: active
                      ? "var(--bg-sunken)"
                      : "transparent",
                    border: active
                      ? "1px solid var(--border)"
                      : "1px solid transparent",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    width: "100%",
                    textAlign: "start",
                    color: "inherit",
                  }}
                >
                  <Icon
                    name="camera"
                    size={13}
                    className="text-secondary"
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 500 }}>
                      {c.name}
                    </div>
                    <div className="text-xs text-dim mono">
                      CAM-{c.id} · {c.location || "—"}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Event stream */}
      <div className="card">
        <div className="card-head">
          <h3 className="card-title">
            {t("liveCapture.eventStream")}{" "}
            <span
              className="pill pill-info"
              style={{ marginInlineStart: 6 }}
            >
              {t("liveCapture.live")}
            </span>
          </h3>
          <div className="flex items-center gap-2">
            <button
              className={`btn btn-sm ${showOnlyUnknown ? "" : "btn-ghost"}`}
              onClick={() => setShowOnlyUnknown((s) => !s)}
              aria-pressed={showOnlyUnknown}
            >
              <Icon name="filter" size={12} />
              {t("liveCapture.onlyUnknown")}
            </button>
            <button
              className="btn btn-sm"
              onClick={onExport}
              disabled={activeCamId == null}
            >
              <Icon name="download" size={12} />
              {t("liveCapture.exportLastHour")}
            </button>
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>{t("liveCapture.col.time")}</th>
              <th>{t("liveCapture.col.camera")}</th>
              <th>{t("liveCapture.col.identified")}</th>
              <th>{t("liveCapture.col.confidence")}</th>
              <th>{t("liveCapture.col.status")}</th>
            </tr>
          </thead>
          <tbody>
            {filteredEvents.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  style={{
                    textAlign: "center",
                    padding: 18,
                    color: "var(--text-secondary)",
                    fontSize: 12,
                  }}
                >
                  {activeCamId == null
                    ? t("liveCapture.eventsEmpty")
                    : t("liveCapture.eventsWaiting")}
                </td>
              </tr>
            )}
            {filteredEvents.map((ev, i) => {
              const known = ev.status === "identified";
              return (
                <tr
                  key={`${ev.time}-${i}`}
                  style={{
                    animation: "fadeInRow 200ms ease",
                  }}
                >
                  <td className="mono text-sm">{formatTime(ev.time)}</td>
                  <td>
                    <span className="pill pill-neutral">
                      CAM-{ev.camera_id}
                    </span>
                  </td>
                  <td>
                    {known ? (
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 500 }}>
                          {ev.employee_name ?? `EMP ${ev.employee_id}`}
                        </div>
                        {ev.employee_code && (
                          <div className="text-xs text-dim mono">
                            {ev.employee_code}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-secondary">
                        {t("liveCapture.unknownFace")}
                      </span>
                    )}
                  </td>
                  <td
                    className="mono text-sm"
                    style={{
                      color:
                        (ev.confidence ?? 0) > 0.7
                          ? "var(--success-text)"
                          : "var(--warning-text)",
                    }}
                  >
                    {formatPct(ev.confidence)}
                  </td>
                  <td>
                    <span
                      className={`pill ${
                        known ? "pill-success" : "pill-warning"
                      }`}
                    >
                      {known
                        ? t("liveCapture.identified")
                        : t("liveCapture.unknown")}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <style>{`
        @keyframes fadeInRow {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </>
  );
}
