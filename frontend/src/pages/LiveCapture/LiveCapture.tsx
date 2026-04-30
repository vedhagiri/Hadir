// Live Capture page — full-page video player with a camera-picker
// sidebar. The event-stream feed that used to sit under the viewer
// has been removed; the Camera Logs page is the persistent
// historical view, and a full-page player is what operators actually
// want here.
//
// The viewer is a plain <img> pointing at the MJPEG endpoint;
// bounding boxes are baked into the JPEG by the capture worker, so
// there's no canvas or SVG overlay layer.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useCameras } from "../../features/cameras/hooks";
import type { Camera } from "../../features/cameras/types";
import { RollingNumber } from "../../motion/RollingNumber";
import { Icon } from "../../shell/Icon";
import { useLiveStats } from "./hooks";

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
  const [isFullscreen, setIsFullscreen] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const viewerCardRef = useRef<HTMLDivElement | null>(null);

  // Stats hook is the only stream we keep — it powers the
  // online/offline pill and the rolling counters. The WebSocket
  // event-stream subscription was retired alongside the
  // event-stream UI block; Camera Logs is the historical view.
  const activeCam = useMemo(
    () => allCameras.find((c) => c.id === activeCamId) ?? null,
    [allCameras, activeCamId],
  );
  const activeIsLive =
    activeCam != null && activeCam.worker_enabled && activeCam.display_enabled;
  const stats = useLiveStats(paused || !activeIsLive ? null : activeCamId);

  const onTogglePause = () => setPaused((p) => !p);
  const onSelect = (id: number) => {
    if (id === activeCamId) return;
    setActiveCamId(id);
    setPaused(false);
  };

  const camStatus = stats.data?.status ?? "offline";
  const showOffline =
    activeIsLive &&
    !paused &&
    stats.data &&
    camStatus === "offline";

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
    // ``object-fit: contain`` preserves the camera's native aspect
    // ratio — letterboxing on either axis instead of stretching /
    // cropping. The black backdrop on ``.cam-stage`` (set on the
    // wrapping div below) absorbs the letterbox bands cleanly.
    img.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;";
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

  // Track real fullscreen state — ESC and the browser's own controls
  // can leave fullscreen without firing through our toggle, so we
  // sync from ``fullscreenchange`` instead of trusting local state.
  useEffect(() => {
    const onChange = () => {
      setIsFullscreen(document.fullscreenElement === viewerCardRef.current);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const onToggleFullscreen = async () => {
    const el = viewerCardRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await el.requestFullscreen();
      }
    } catch {
      // Fullscreen API can refuse (sandbox, no user gesture, etc.)
      // — silently ignore; the operator can press F11 instead.
    }
  };

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
            onClick={onToggleFullscreen}
            disabled={activeCamId == null}
            aria-pressed={isFullscreen}
            title={
              isFullscreen
                ? (t("liveCapture.exitFullscreen", {
                    defaultValue: "Exit fullscreen",
                  }) as string)
                : (t("liveCapture.fullscreen", {
                    defaultValue: "Fullscreen",
                  }) as string)
            }
          >
            <Icon name={isFullscreen ? "minimize" : "maximize"} size={12} />
            {isFullscreen
              ? (t("liveCapture.exitFullscreen", {
                  defaultValue: "Exit fullscreen",
                }) as string)
              : (t("liveCapture.fullscreen", {
                  defaultValue: "Fullscreen",
                }) as string)}
          </button>
        </div>
      </div>

      <div
        className="grid"
        style={{
          // Full-page layout: player dominates, camera picker is a
          // slim sidebar. The grid stretches to fill the remaining
          // viewport height beneath the page header so the player
          // is not aspect-ratio constrained — operators want the
          // largest possible viewer.
          gridTemplateColumns: "minmax(0, 1fr) 280px",
          gap: 16,
          height: "calc(100vh - 180px)",
          minHeight: 480,
        }}
      >
        {/* Viewer */}
        <div
          ref={viewerCardRef}
          className="card"
          style={{
            padding: 0,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            // Real fullscreen reuses this same element via
            // ``element.requestFullscreen()`` — no portal, no remount,
            // so the MJPEG <img> stream keeps streaming through the
            // mode flip with zero re-fetch cost.
            background: isFullscreen ? "#000" : undefined,
          }}
        >
          <div
            className="cam-stage"
            style={{
              flex: 1,
              minHeight: 0,
              position: "relative",
              background: "#000",
            }}
          >
            {isFullscreen && (
              <button
                type="button"
                onClick={onToggleFullscreen}
                title={t("liveCapture.exitFullscreen", {
                  defaultValue: "Exit fullscreen",
                }) as string}
                style={{
                  position: "absolute",
                  top: 12,
                  insetInlineEnd: 12,
                  zIndex: 5,
                  background: "rgba(0,0,0,0.55)",
                  color: "white",
                  border: "1px solid rgba(255,255,255,0.18)",
                  borderRadius: 6,
                  padding: "6px 10px",
                  fontSize: 12,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  cursor: "pointer",
                  backdropFilter: "blur(4px)",
                  WebkitBackdropFilter: "blur(4px)",
                }}
              >
                <Icon name="minimize" size={12} />
                {t("liveCapture.exitFullscreen", {
                  defaultValue: "Exit fullscreen",
                }) as string}
              </button>
            )}
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
        <div
          className="card"
          style={{
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <div className="card-head">
            <h3 className="card-title">{t("liveCapture.cameras")}</h3>
          </div>
          <div
            style={{
              padding: 8,
              display: "flex",
              flexDirection: "column",
              gap: 2,
              overflowY: "auto",
              flex: 1,
              minHeight: 0,
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
