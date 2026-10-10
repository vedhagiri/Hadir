// Clip Logs — detail drawer. Saved clips get a player that reuses the
// Person Clips approach (GET /api/person-clips/{id}/stream fetched once
// into a blob URL, poster from /thumbnail). Logs-only rows have no file,
// so the drawer shows the presence-log facts only.

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { DrawerShell } from "../../components/DrawerShell";
import { FormHeader } from "../../components/FormKit";
import { SkeletonLines } from "../../components/Skeleton";
import { Icon } from "../../shell/Icon";
import { useClipProcessingResults } from "../person-clips/hooks";
import type { PersonClipOut } from "../person-clips/types";
import { Chips, ModeIcon, useClipChips, useClipTimeFmt } from "./ClipLogUi";
import { fmtDuration, fmtFileSize, hasVideo, isPlayable } from "./clipLogUtil";

export function ClipLogDrawer({
  clip,
  onClose,
  onPrev,
  onNext,
}: {
  clip: PersonClipOut;
  onClose: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
}) {
  const { t } = useTranslation();
  const fmtTime = useClipTimeFmt();
  const chipsFor = useClipChips();
  const video = hasVideo(clip);
  const start = new Date(clip.clip_start);
  const end = new Date(clip.clip_end);
  const dateLabel = start.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const results = useClipProcessingResults(clip.id);

  const res = clip.resolution_w && clip.resolution_h ? `${clip.resolution_w}×${clip.resolution_h}` : null;
  const fps =
    clip.fps_recorded ?? (clip.duration_seconds > 0 && clip.frame_count > 0 ? clip.frame_count / clip.duration_seconds : null);
  const names = clip.matched_employee_names ?? [];

  return (
    <DrawerShell onClose={onClose}>
      <div className="drawer drawer-wide clg-drawer" role="dialog" aria-labelledby="clg-drawer-title">
        <FormHeader
          titleId="clg-drawer-title"
          icon={<ModeIcon mode={video ? "save_clips" : "logs_only"} size={18} />}
          eyebrow={
            video
              ? t("clipLogs.drawer.eyebrowSaved", { defaultValue: "Saved clip" })
              : t("clipLogs.drawer.eyebrowLog", { defaultValue: "Presence log" })
          }
          title={clip.camera_name}
          subtitle={`${dateLabel} · ${fmtTime(start)} → ${fmtTime(end)}`}
          actions={
            <span className="clg-drawer-nav">
              <button
                type="button"
                className="icon-btn"
                onClick={onPrev ?? undefined}
                disabled={!onPrev}
                aria-label={t("clipLogs.drawer.prev", { defaultValue: "Previous clip" })}
                title={t("clipLogs.drawer.prev", { defaultValue: "Previous clip" })}
              >
                <Icon name="chevronLeft" size={16} />
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={onNext ?? undefined}
                disabled={!onNext}
                aria-label={t("clipLogs.drawer.next", { defaultValue: "Next clip" })}
                title={t("clipLogs.drawer.next", { defaultValue: "Next clip" })}
              >
                <Icon name="chevronRight" size={16} />
              </button>
            </span>
          }
          onClose={onClose}
        />

        <div className="drawer-body clg-drawer-body">
          {video ? (
            <ClipPlayer key={clip.id} clip={clip} />
          ) : (
            <div className="clg-notice">
              <Icon name="info" size={16} />
              <span>
                {t("clipLogs.drawer.noVideo", {
                  defaultValue:
                    "This camera is in “Logs only” mode, so no video file was kept — only the fact that someone was seen, when, and for how long.",
                })}
              </span>
            </div>
          )}

          <Chips chips={chipsFor(clip)} />

          <section className="clg-section">
            <h3 className="clg-section-title">{t("clipLogs.drawer.details", { defaultValue: "Details" })}</h3>
            <dl className="clg-facts">
              <Fact label={t("clipLogs.colCamera", { defaultValue: "Camera" })}>{clip.camera_name}</Fact>
              <Fact label={t("clipLogs.colDate", { defaultValue: "Date" })}>{dateLabel}</Fact>
              <Fact label={t("clipLogs.colStart", { defaultValue: "Start" })} mono>
                {fmtTime(start)}
              </Fact>
              <Fact label={t("clipLogs.colEnd", { defaultValue: "End" })} mono>
                {fmtTime(end)}
              </Fact>
              <Fact label={t("clipLogs.colDuration", { defaultValue: "Duration" })} mono>
                {fmtDuration(clip.duration_seconds)}
              </Fact>
              {video && clip.filesize_bytes > 0 && (
                <Fact label={t("clipLogs.colSize", { defaultValue: "Size" })} mono>
                  {fmtFileSize(clip.filesize_bytes)}
                </Fact>
              )}
              <Fact label={t("clipLogs.colPersons", { defaultValue: "Persons" })} mono>
                {clip.person_count ?? 0}
              </Fact>
              {res && (
                <Fact label={t("clipLogs.drawer.resolution", { defaultValue: "Resolution" })} mono>
                  {res}
                </Fact>
              )}
              {fps !== null && video && (
                <Fact label={t("clipLogs.drawer.fps", { defaultValue: "Frame rate" })} mono>
                  {`${fps.toFixed(1)} fps`}
                </Fact>
              )}
              {video && clip.frame_count > 0 && (
                <Fact label={t("clipLogs.drawer.frames", { defaultValue: "Frames" })} mono>
                  {clip.frame_count.toLocaleString()}
                </Fact>
              )}
              {video && clip.chunk_count > 1 && (
                <Fact label={t("clipLogs.drawer.chunks", { defaultValue: "Merged chunks" })} mono>
                  {clip.chunk_count}
                </Fact>
              )}
              {video && clip.clip_name && (
                <Fact label={t("clipLogs.drawer.file", { defaultValue: "Clip name" })} mono wide>
                  {clip.clip_name}
                </Fact>
              )}
            </dl>
          </section>

          {names.length > 0 && (
            <section className="clg-section">
              <h3 className="clg-section-title">
                {t("clipLogs.drawer.matched", { defaultValue: "Matched employees" })}
              </h3>
              <div className="clg-chips">
                {names.map((n) => (
                  <span key={n} className="pill pill-accent">
                    <Icon name="user" size={11} />
                    {n}
                  </span>
                ))}
              </div>
            </section>
          )}

          {video && (
            <section className="clg-section">
              <h3 className="clg-section-title">
                {t("clipLogs.drawer.processing", { defaultValue: "Face identification" })}
              </h3>
              {results.isLoading ? (
                <SkeletonLines lines={2} />
              ) : results.isError ? (
                <p className="clg-muted">
                  {t("clipLogs.drawer.processingError", { defaultValue: "Couldn’t load processing results." })}
                </p>
              ) : (results.data?.results ?? []).length === 0 ? (
                <p className="clg-muted">
                  {t("clipLogs.drawer.notProcessed", {
                    defaultValue: "Not processed yet. Run identification on this clip from Clip Analytics.",
                  })}
                </p>
              ) : (
                <ul className="clg-uc-list">
                  {(results.data?.results ?? []).map((r) => (
                    <li key={r.id} className="clg-uc">
                      <span className="clg-uc-name">{r.use_case.toUpperCase()}</span>
                      <span
                        className={`pill ${
                          r.status === "completed"
                            ? "pill-success"
                            : r.status === "failed"
                              ? "pill-danger"
                              : r.status === "processing"
                                ? "pill-info"
                                : "pill-neutral"
                        }`}
                      >
                        {t(`clipLogs.ucStatus.${r.status}`, { defaultValue: r.status })}
                      </span>
                      <span className="clg-uc-meta">
                        {t("clipLogs.drawer.ucFaces", { defaultValue: "{{n}} faces", n: r.face_crop_count })}
                        {r.matched_employee_names.length > 0 && ` · ${r.matched_employee_names.join(", ")}`}
                        {r.unknown_count > 0 &&
                          ` · ${t("clipLogs.drawer.ucUnknown", { defaultValue: "{{n}} unknown", n: r.unknown_count })}`}
                      </span>
                      {r.duration_ms !== null && (
                        <span className="clg-uc-time mono">{fmtDuration(r.duration_ms / 1000)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>

        <div className="drawer-foot">
          {video && (
            <Link className="btn" to="/clip-analytics">
              <Icon name="activity" size={12} />
              {t("clipLogs.drawer.openAnalytics", { defaultValue: "Open Clip Analytics" })}
            </Link>
          )}
          <button type="button" className="btn btn-primary" onClick={onClose}>
            {t("common.close", { defaultValue: "Close" })}
          </button>
        </div>
      </div>
    </DrawerShell>
  );
}

function Fact({ label, children, mono, wide }: { label: string; children: ReactNode; mono?: boolean; wide?: boolean }) {
  return (
    <div className={`clg-fact${wide ? " is-wide" : ""}`}>
      <dt>{label}</dt>
      <dd className={mono ? "mono" : undefined}>{children}</dd>
    </div>
  );
}

/** Poster + play button; on click fetches the decrypted MP4 once into a
 *  blob URL (same approach as the Person Clips card) and plays it. */
function ClipPlayer({ clip }: { clip: PersonClipOut }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(false);
  const [posterErr, setPosterErr] = useState(false);
  const playable = isPlayable(clip);

  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);

  const play = () => {
    if (!playable || loading) return;
    setLoading(true);
    setErr(false);
    fetch(`/api/person-clips/${clip.id}/stream`)
      .then((res) => {
        if (!res.ok) throw new Error("fetch failed");
        return res.blob();
      })
      .then((blob) => setUrl(URL.createObjectURL(blob)))
      .catch(() => setErr(true))
      .finally(() => setLoading(false));
  };

  if (url && !err) {
    return (
      <div className="clg-player">
        <video src={url} controls autoPlay onError={() => setErr(true)} />
      </div>
    );
  }

  const inFlight = clip.recording_status === "recording" || clip.recording_status === "finalizing";
  return (
    <div className="clg-player">
      {playable && !posterErr && (
        <img src={`/api/person-clips/${clip.id}/thumbnail`} alt="" onError={() => setPosterErr(true)} />
      )}
      <div className="clg-player-overlay">
        {err ? (
          <>
            <Icon name="info" size={22} />
            <span>{t("clipLogs.player.error", { defaultValue: "This clip couldn’t be loaded. The file may have been removed." })}</span>
            <button type="button" className="btn btn-sm" onClick={play}>
              <Icon name="refresh" size={12} />
              {t("clipLogs.retry", { defaultValue: "Retry" })}
            </button>
          </>
        ) : inFlight ? (
          <>
            <Icon name="videocam" size={26} />
            <span>
              {clip.recording_status === "recording"
                ? t("clipLogs.player.recording", { defaultValue: "Still recording — the video will be playable once it finishes." })
                : t("clipLogs.player.encoding", { defaultValue: "Encoding — the video will be playable in a moment." })}
            </span>
          </>
        ) : !playable ? (
          <>
            <Icon name="videocam" size={26} />
            <span>{t("clipLogs.player.unavailable", { defaultValue: "No playable video for this clip." })}</span>
          </>
        ) : (
          <button
            type="button"
            className="clg-play-btn"
            onClick={play}
            disabled={loading}
            aria-label={t("clipLogs.player.play", { defaultValue: "Play clip" })}
          >
            {loading ? (
              <span className="clg-spin" aria-hidden>
                <Icon name="refresh" size={22} />
              </span>
            ) : (
              <Icon name="play" size={22} />
            )}
          </button>
        )}
      </div>
      {!err && playable && (
        <span className="clg-player-dur mono">{fmtDuration(clip.duration_seconds)}</span>
      )}
    </div>
  );
}
