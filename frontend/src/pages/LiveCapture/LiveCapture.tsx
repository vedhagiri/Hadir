// P28.5 — Live Capture page.
//
// Layout ported from design-reference/pages.jsx::LiveCapture: a header
// strip with Pause/Resume + Reconnect, a 2:1 grid (viewer + camera
// list), and a full-width event-stream card below. The viewer is a
// plain <img> pointing at the MJPEG endpoint; bounding boxes are
// baked into the JPEG by the capture worker, so there's no canvas
// or SVG overlay layer.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useCameras } from "../../features/cameras/hooks";
import type { Camera } from "../../features/cameras/types";
import { RollingNumber } from "../../motion/RollingNumber";
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

  // P28.5b: cameras list now splits along the worker / display axes.
  // The worker can be off while display is on (no recording, viewer
  // sees offline state) and vice versa (recording happens but Live
  // Capture hides the feed).
  const allCameras = camerasQuery.data?.items ?? [];
  const liveCameras = useMemo(
    () => allCameras.filter((c) => c.worker_enabled && c.display_enabled),
    [allCameras],
  );
  const displayDisabledCameras = useMemo(
    () => allCameras.filter((c) => c.worker_enabled && !c.display_enabled),
    [allCameras],
  );
  const workerDisabledCameras = useMemo(
    () => allCameras.filter((c) => !c.worker_enabled),
    [allCameras],
  );

  const [activeCamId, setActiveCamId] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const [showOnlyUnknown, setShowOnlyUnknown] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // The streams + stats hooks short-circuit when the active camera is
  // display-disabled — no point polling /live-stats or opening a WS
  // for a feed the backend will refuse.
  const activeCam = useMemo(
    () => allCameras.find((c) => c.id === activeCamId) ?? null,
    [allCameras, activeCamId],
  );
  const activeIsLive =
    activeCam != null && activeCam.worker_enabled && activeCam.display_enabled;
  const stats = useLiveStats(paused || !activeIsLive ? null : activeCamId);
  const stream = useEventStream(activeIsLive ? activeCamId : null);

  const onTogglePause = () => setPaused((p) => !p);
  const onSelect = (id: number) => {
    if (id === activeCamId) return;
    setActiveCamId(id);
    setPaused(false);
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
    activeIsLive &&
    !paused &&
    stats.data &&
    camStatus === "offline";
  const showReconnecting =
    activeIsLive && !paused && stream.status === "reconnecting";

  // P28.5b: explanatory empty states for cameras the operator
  // selected but that aren't currently streaming. The MJPEG endpoint
  // returns 503 / WebSocket closes — but we want a clear "not loading"
  // message rather than the offline timeout state.
  const showDisplayDisabled =
    activeCam != null && activeCam.worker_enabled && !activeCam.display_enabled;
  const showWorkerDisabled =
    activeCam != null && !activeCam.worker_enabled;

  // MJPEG (multipart/x-mixed-replace) cleanup is notoriously bad in
  // browsers — Chromium keeps the TCP stream open for the lifetime
  // of the page when the <img> element is unmounted, even if the
  // element is removed from the DOM. Camera *switches* are easy
  // (point src at an in-memory data URL — the browser supersedes
  // the prior fetch for that element). But page *navigation* is
  // harder because React's useEffect cleanup races with DOM removal,
  // and the browser may never process the src change.
  //
  // Fix: render the <img> imperatively into a container ref. On
  // every dep change OR unmount we (a) point src at a tiny data
  // URL to abort the in-flight fetch and (b) physically detach the
  // element from the DOM. Browsers close MJPEG fetches reliably
  // when the owning element leaves the document.
  //
  // 1×1 transparent GIF — 43 bytes, parsed instantly, no network.
  const ABORT_PIXEL =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const showLiveImg =
    activeIsLive && !showOffline && !paused && activeCamId != null;
  const streamingUrl = showLiveImg
    ? `/api/cameras/${activeCamId}/live.mjpg`
    : "";
  const stageRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const img = document.createElement("img");
    img.alt = "live camera";
    img.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;";
    img.src = streamingUrl || ABORT_PIXEL;
    stage.appendChild(img);
    imgRef.current = img;

    return () => {
      // Step 1: supersede the in-flight fetch for THIS element.
      img.src = ABORT_PIXEL;
      // Step 2: detach. Browser closes the MJPEG TCP fetch as soon
      // as the owning element leaves the document — this is the
      // fail-safe for page navigation, where useEffect cleanup
      // races with DOM removal and the browser otherwise never
      // sees the src change land before the element is gone.
      if (img.parentNode) {
        img.parentNode.removeChild(img);
      }
      if (imgRef.current === img) imgRef.current = null;
    };
  }, [streamingUrl]);

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
        </div>
      </div>

      <div
        className="grid"
        style={{
          // Bumped from 2fr 1fr → 3fr 1fr so the player gets ~75 % of
          // the row width (was 67 %). Combined with the taller aspect
          // ratio below, the viewer is noticeably larger.
          gridTemplateColumns: "3fr 1fr",
          gap: 16,
          marginBottom: 16,
        }}
      >
        {/* Viewer */}
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          {/* Bumped from 16/8.2 → 16/9: same width yields ~10 % more
              vertical space. */}
          <div className="cam-stage" style={{ aspectRatio: "16 / 9" }}>
            <div className="cam-bg" />
            {/* Stage container the imperative <img> attaches into.
                Sits between cam-bg and the overlays so the DOM order
                naturally puts overlays on top (siblings later in
                document order paint on top under default CSS). */}
            <div
              ref={stageRef}
              style={{
                position: "absolute",
                inset: 0,
                pointerEvents: "none",
              }}
            />
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
            {/* The <img> element is created/destroyed imperatively
                in the streamingUrl useEffect above (see ``stageRef``
                + ``imgRef``). React doesn't manage it — physical
                detach on cleanup is the only way to reliably close
                MJPEG TCP fetches across browsers. The cam-stage
                <div> here is the parent container the effect
                appends to. */}
            {showDisplayDisabled && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "grid",
                  placeItems: "center",
                  color: "var(--text-secondary)",
                  fontSize: 13,
                  textAlign: "center",
                  padding: 24,
                }}
              >
                {t("liveCapture.displayDisabled")}
              </div>
            )}
            {showWorkerDisabled && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "grid",
                  placeItems: "center",
                  color: "var(--text-secondary)",
                  fontSize: 13,
                  textAlign: "center",
                  padding: 24,
                }}
              >
                {t("liveCapture.workerDisabled")}
              </div>
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
                  <RollingNumber value={stats.data?.detections_last_10m ?? 0} />
                </span>
              </span>
              <span className="text-xs text-dim">
                {" · "}
                {t("liveCapture.known")}{" "}
                <span
                  className="mono"
                  style={{ color: "var(--success-text)" }}
                >
                  <RollingNumber value={stats.data?.known_count ?? 0} />
                </span>
                {" · "}
                {t("liveCapture.unknown")}{" "}
                <span
                  className="mono"
                  style={{ color: "var(--warning-text)" }}
                >
                  <RollingNumber value={stats.data?.unknown_count ?? 0} />
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
            {!camerasQuery.isLoading &&
              liveCameras.length === 0 &&
              displayDisabledCameras.length === 0 &&
              workerDisabledCameras.length === 0 && (
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

            {/* Live cameras (worker on + display on). */}
            {liveCameras.map((c) => (
              <CameraRow
                key={c.id}
                cam={c}
                active={c.id === activeCamId}
                kind="live"
                onSelect={onSelect}
              />
            ))}

            {/* Display-disabled cameras (worker on + display off):
                still in the main list but greyed; clicking shows an
                empty "Display disabled by Admin" state. */}
            {displayDisabledCameras.map((c) => (
              <CameraRow
                key={c.id}
                cam={c}
                active={c.id === activeCamId}
                kind="display-disabled"
                onSelect={onSelect}
                tooltip={t("liveCapture.displayDisabledTooltip")}
              />
            ))}

            {/* Worker-disabled cameras grouped at the bottom of the
                list. They're not recording — no live stream possible. */}
            {workerDisabledCameras.length > 0 && (
              <div
                className="text-xs text-dim"
                style={{
                  padding: "10px 10px 4px",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                }}
              >
                {t("liveCapture.workerDisabledHeading")}
              </div>
            )}
            {workerDisabledCameras.map((c) => (
              <CameraRow
                key={c.id}
                cam={c}
                active={c.id === activeCamId}
                kind="worker-disabled"
                onSelect={onSelect}
                tooltip={t("liveCapture.workerDisabledTooltip")}
              />
            ))}
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
              <th style={{ width: 72 }}>{t("liveCapture.col.face")}</th>
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
                  colSpan={6}
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
                  <td>
                    {ev.event_id != null ? (
                      <img
                        src={`/api/detection-events/${ev.event_id}/crop`}
                        alt={`event ${ev.event_id}`}
                        loading="lazy"
                        style={{
                          display: "block",
                          width: 56,
                          height: 56,
                          objectFit: "cover",
                          borderRadius: "var(--radius-sm)",
                          border: "1px solid var(--border)",
                        }}
                      />
                    ) : (
                      <div
                        title="No crop available"
                        aria-label="No crop available"
                        style={{
                          display: "grid",
                          placeItems: "center",
                          width: 56,
                          height: 56,
                          borderRadius: "var(--radius-sm)",
                          border: "1px dashed var(--border)",
                          background: "var(--bg-sunken)",
                          color: "var(--text-tertiary)",
                          fontSize: 9,
                          textAlign: "center",
                          lineHeight: 1.1,
                          padding: 4,
                        }}
                      >
                        —
                      </div>
                    )}
                  </td>
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


// P28.5b: shared row renderer for the camera list. The "kind" tag
// drives styling: live (full-colour), display-disabled (greyed +
// tooltip), worker-disabled (greyed + bottom group).
function CameraRow({
  cam,
  active,
  kind,
  onSelect,
  tooltip,
}: {
  cam: Camera;
  active: boolean;
  kind: "live" | "display-disabled" | "worker-disabled";
  onSelect: (id: number) => void;
  tooltip?: string;
}) {
  const dimmed = kind !== "live";
  return (
    <button
      type="button"
      onClick={() => onSelect(cam.id)}
      title={tooltip}
      style={{
        padding: "8px 10px",
        borderRadius: 7,
        cursor: "pointer",
        background: active ? "var(--bg-sunken)" : "transparent",
        border: active
          ? "1px solid var(--border)"
          : "1px solid transparent",
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        textAlign: "start",
        color: dimmed ? "var(--text-secondary)" : "inherit",
        opacity: dimmed ? 0.7 : 1,
      }}
    >
      <Icon name="camera" size={13} className="text-secondary" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500 }}>{cam.name}</div>
        <div className="text-xs text-dim mono">
          CAM-{cam.id} · {cam.location || "—"}
        </div>
      </div>
      {kind === "display-disabled" && (
        <span className="pill pill-neutral" style={{ fontSize: 10 }}>
          display
        </span>
      )}
      {kind === "worker-disabled" && (
        <span className="pill pill-neutral" style={{ fontSize: 10 }}>
          off
        </span>
      )}
    </button>
  );
}
