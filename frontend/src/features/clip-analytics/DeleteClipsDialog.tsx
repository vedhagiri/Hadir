// Delete-clips confirmation (single + bulk) for Clip Analytics.
//
// Every sentence here mirrors what the backend really does
// (``DELETE /api/person-clips/{id}`` + ``POST /api/person-clips/bulk-delete``
// in maugood/person_clips/router.py):
//   * removes the MP4 + its ``.thumb.jpg`` from disk (when the clip
//     still has one), the ``person_clips`` row and — by FK cascade — its
//     per-use-case ``clip_processing_results`` + chunk rows;
//   * clips still ``recording`` / ``finalizing`` are skipped (bulk) or
//     refused with 409 (single);
//   * writes one ``person_clip.deleted`` audit row per deleted clip;
//   * does NOT touch ``detection_events`` (the Camera Logs sightings the
//     pipeline emitted from the clip, incl. their face-photo files) or
//     ``attendance_records`` — attendance stays as computed.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ModalShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import { toast } from "../../shell/Toaster";
import "../person-clips/clips.css";
import { isVideoDeleted } from "../person-clips/deletedVideo";
import type { PersonClipOut } from "../person-clips/types";

export interface DeleteClipsResult {
  deleted: number;
  skipped: number;
}

function fmtBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function inFlight(c: PersonClipOut): boolean {
  return c.recording_status === "recording" || c.recording_status === "finalizing";
}

export function DeleteClipsDialog({
  count,
  clips,
  onCancel,
  onDelete,
  onDone,
  extraNotice,
}: {
  /** Number of clip ids the request will send — the one number shown. */
  count: number;
  /** The rows we have details for (fewer than ``count`` when the
   *  selection spans pages). */
  clips: PersonClipOut[];
  onCancel: () => void;
  /** Performs the delete; resolves with what the server reported. */
  onDelete: () => Promise<DeleteClipsResult>;
  onDone: () => void;
  extraNotice?: string | null;
}) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const single = count === 1;

  // Focus starts on Cancel (the safe choice). The shell auto-focuses
  // the first focusable element first, so defer one tick.
  useEffect(() => {
    const id = window.setTimeout(() => cancelRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, []);

  // ModalShell ignores Escape; for a confirm dialog Esc = Cancel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  const sum = useMemo(() => {
    const cams = Array.from(new Set(clips.map((c) => c.camera_name || "—")));
    let first: Date | null = null;
    let last: Date | null = null;
    let bytes = 0;
    let alreadyDeleted = 0;
    let skipped = 0;
    for (const c of clips) {
      const s = new Date(c.clip_start);
      const e = new Date(c.clip_end);
      if (!first || s < first) first = s;
      if (!last || e > last) last = e;
      if (inFlight(c)) skipped += 1;
      else if (isVideoDeleted(c)) alreadyDeleted += 1;
      else bytes += Math.max(0, c.filesize_bytes || 0);
    }
    return { cams, first, last, bytes, alreadyDeleted, skipped };
  }, [clips]);

  const offPage = Math.max(0, count - clips.length);
  const blocked = single && sum.skipped === 1;

  // Subtitle: "Inaisys Office · 9–14 Oct 2026" (bulk) or
  // "Inaisys Office · 9 Oct 2026, 01:56 PM" (single).
  const camText =
    sum.cams.length === 0
      ? ""
      : sum.cams.length <= 2
        ? sum.cams.join(", ")
        : t("clipDelete.camerasMore", {
            defaultValue: "{{names}} +{{n}} more",
            names: sum.cams.slice(0, 2).join(", "),
            n: sum.cams.length - 2,
          });
  const lang = i18n.language;
  let when = "";
  if (sum.first && sum.last) {
    if (single) {
      when = sum.first.toLocaleString(lang, {
        day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
      });
    } else {
      const d = (x: Date, o: Intl.DateTimeFormatOptions) => x.toLocaleDateString(lang, o);
      const sameDay = sum.first.toDateString() === sum.last.toDateString();
      const sameMonth =
        sum.first.getMonth() === sum.last.getMonth() &&
        sum.first.getFullYear() === sum.last.getFullYear();
      when = sameDay
        ? d(sum.first, { day: "numeric", month: "short", year: "numeric" })
        : sameMonth
          ? `${sum.first.getDate()}–${d(sum.last, { day: "numeric", month: "short", year: "numeric" })}`
          : `${d(sum.first, { day: "numeric", month: "short" })} – ${d(sum.last, { day: "numeric", month: "short", year: "numeric" })}`;
    }
  }
  const subtitle = [camText, when].filter(Boolean).join(" · ");

  // One slim stats line (bulk only).
  const stats: string[] = [];
  if (!single) {
    stats.push(
      offPage > 0
        ? t("clipDelete.statClipsOffPage", {
            defaultValue: "{{count}} clips ({{n}} not shown on this page)",
            count,
            n: offPage,
          })
        : t("clipDelete.statClips", { defaultValue: "{{count}} clips", count }),
    );
    if (sum.alreadyDeleted > 0)
      stats.push(
        t("clipDelete.statAlreadyDeleted", {
          defaultValue: "{{n}} videos already deleted",
          n: sum.alreadyDeleted,
        }),
      );
    if (sum.bytes > 0)
      stats.push(t("clipDelete.statFrees", { defaultValue: "frees {{size}}", size: fmtBytes(sum.bytes) }));
    if (sum.skipped > 0)
      stats.push(
        t("clipDelete.statSkipped", {
          defaultValue: "{{n}} still recording — skipped",
          n: sum.skipped,
        }),
      );
  }

  const confirm = async () => {
    if (busy || blocked) return;
    setBusy(true);
    setError(null);
    try {
      const res = await onDelete();
      if (res.skipped > 0) {
        toast.warning(
          t("clipDelete.resultSkipped", {
            defaultValue: "Deleted {{deleted}} clip(s) · {{skipped}} skipped (still recording or already gone)",
            deleted: res.deleted,
            skipped: res.skipped,
          }),
          6000,
        );
      } else {
        toast.success(
          t("clipDelete.resultOk", { defaultValue: "Deleted {{deleted}} clip(s)", deleted: res.deleted }),
        );
      }
      onDone();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("clipDelete.errCouldNot", { defaultValue: "Could not delete. Please try again." }),
      );
      setBusy(false);
    }
  };

  const clip0 = single ? clips[0] : undefined;
  // Skip the "videos" line when every clip's video is already gone.
  const anyVideo = offPage > 0 || clips.some((c) => !isVideoDeleted(c) && c.recording_mode !== "logs_only");
  const removed = [
    ...(anyVideo
      ? [
          single
            ? t("clipDelete.removedVideoOne", { defaultValue: "Video and preview image" })
            : t("clipDelete.removedVideo", { defaultValue: "Videos and preview images" }),
        ]
      : []),
    single
      ? t("clipDelete.removedRecordOne", { defaultValue: "Clip entry" })
      : t("clipDelete.removedRecord", { defaultValue: "Clip entries" }),
    t("clipDelete.removedResults", { defaultValue: "Face-identification results" }),
  ];
  const kept = [
    t("clipDelete.keptAttendance", { defaultValue: "Attendance already calculated" }),
    t("clipDelete.keptSightings", { defaultValue: "Camera Logs sightings and their face photos" }),
    t("clipDelete.keptAudit", { defaultValue: "Audit record of this deletion" }),
  ];

  return (
    <ModalShell onClose={() => { if (!busy) onCancel(); }}>
      <div className="cl-del-host">
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="cl-del-title"
          aria-describedby="cl-del-desc"
          className="modal cl-del"
        >
          <div className="cl-del-head">
            <span className="cl-del-icon" aria-hidden>
              <Icon name="trash" size={18} />
            </span>
            <div style={{ minWidth: 0 }}>
              <h2 id="cl-del-title" className="cl-del-title">
                {single
                  ? t("clipDelete.titleOne", {
                      defaultValue: "Delete clip #{{id}}?",
                      id: clip0?.id ?? "",
                    })
                  : t("clipDelete.titleMany", { defaultValue: "Delete {{count}} clips?", count })}
              </h2>
              {subtitle && (
                <p id="cl-del-desc" className="cl-del-sub">
                  {subtitle}
                </p>
              )}
            </div>
          </div>

          {stats.length > 0 && <p className="cl-del-stats">{stats.join(" · ")}</p>}

          <div className="cl-del-what">
            <div className="cl-del-group">
              <span className="cl-del-label">{t("clipDelete.removedTitle", { defaultValue: "Removed" })}</span>
              <ul>
                {removed.map((x) => (
                  <li key={x}>
                    <span className="cl-del-mark is-remove" aria-hidden>
                      <Icon name="x" size={11} />
                    </span>
                    {x}
                  </li>
                ))}
              </ul>
            </div>
            <div className="cl-del-group">
              <span className="cl-del-label">{t("clipDelete.keptTitle", { defaultValue: "Kept" })}</span>
              <ul>
                {kept.map((x) => (
                  <li key={x}>
                    <span className="cl-del-mark is-keep" aria-hidden>
                      <Icon name="check" size={11} />
                    </span>
                    {x}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {blocked && (
            <p className="cl-del-note is-warning" role="status">
              {t("clipDelete.skippedOne", {
                defaultValue: "This clip is still recording or being saved — try again once it has finished.",
              })}
            </p>
          )}
          {extraNotice && (
            <p className="cl-del-note is-warning" role="status">
              {extraNotice}
            </p>
          )}
          {error && (
            <p className="cl-del-note is-danger" role="alert">
              {error}
            </p>
          )}

          <div className="cl-del-foot">
            <span className="cl-del-final">
              {t("clipDelete.cannotUndo", { defaultValue: "This can't be undone." })}
            </span>
            <button ref={cancelRef} type="button" className="btn" onClick={onCancel} disabled={busy}>
              {t("common.cancel", { defaultValue: "Cancel" })}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => void confirm()}
              disabled={busy || blocked}
            >
              {busy
                ? t("clipDelete.deleting", { defaultValue: "Deleting…" })
                : single
                  ? t("clipDelete.confirmOne", { defaultValue: "Delete clip" })
                  : t("clipDelete.confirmMany", { defaultValue: "Delete {{count}} clips", count })}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
