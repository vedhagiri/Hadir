// Shared bits for clips whose video file was deleted to save space
// (migration 0069 / 0097). The row, face crops and attendance results
// stay; only the MP4 is gone. ``filesize_bytes`` is 0 on such rows, so
// the UI reads ``deleted_filesize_bytes`` / ``deleted_file_name`` to keep
// showing what the file was. Used by Clip Analytics, Clip Logs and
// Person Clips.

import { useTranslation } from "react-i18next";

import { Icon } from "../../shell/Icon";
import "./clips.css";
import type { PersonClipOut } from "./types";

export function isVideoDeleted(c: PersonClipOut): boolean {
  return !!c.file_deleted_at;
}

/** Size to display: the live file size, or the size the file had
 *  before it was deleted. 0 when unknown. */
export function displaySizeBytes(c: PersonClipOut): number {
  if (isVideoDeleted(c)) return Math.max(0, c.deleted_filesize_bytes ?? 0);
  return Math.max(0, c.filesize_bytes || 0);
}

/** True when the original file name/size were not kept — clips cleared
 *  before migration 0097 by the Storage Analytics clean-up, whose audit
 *  row is a per-batch summary without per-clip file names. */
export function originalNotRecorded(c: PersonClipOut): boolean {
  return isVideoDeleted(c) && !c.deleted_file_name;
}

/** Tooltip copy: "Deleted after processing · 14 Oct, 12:39" etc.
 *  Appends "Original name and size not recorded" when they are unknown. */
export function useDeletedVideoTitle(): (c: PersonClipOut) => string {
  const { t } = useTranslation();
  const base = useDeletedVideoReason();
  return (c) =>
    originalNotRecorded(c)
      ? `${base(c)} · ${t("clipVideo.deleted.notRecorded", {
          defaultValue: "Original name and size not recorded",
        })}`
      : base(c);
}

function useDeletedVideoReason(): (c: PersonClipOut) => string {
  const { t } = useTranslation();
  return (c) => {
    const when = c.file_deleted_at
      ? new Date(c.file_deleted_at).toLocaleString(undefined, {
          day: "numeric",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";
    switch (c.file_deleted_reason) {
      case "auto_after_processing":
        return t("clipVideo.deleted.tooltipAuto", {
          defaultValue: "Deleted after processing · {{when}}",
          when,
        });
      case "cleanup":
        return t("clipVideo.deleted.tooltipCleanup", {
          defaultValue: "Removed by storage clean-up · {{when}}",
          when,
        });
      case "daily_cleanup":
        return t("clipVideo.deleted.tooltipDaily", {
          defaultValue: "Removed by the daily clean-up · {{when}}",
          when,
        });
      default:
        return t("clipVideo.deleted.tooltipGeneric", {
          defaultValue: "Video deleted to save space · {{when}}",
          when,
        });
    }
  };
}

/** Muted "Video deleted" pill with an explanatory tooltip. */
export function DeletedVideoPill({ clip, compact = false }: { clip: PersonClipOut; compact?: boolean }) {
  const { t } = useTranslation();
  const titleFor = useDeletedVideoTitle();
  const label = t("clipVideo.deleted.pill", { defaultValue: "Video deleted" });
  // ``compact``: icon-only chip for dense tables — same tooltip, and the
  // label stays available to screen readers.
  return (
    <span
      className={`pill pill-neutral${compact ? " cl-deleted-chip" : ""}`}
      title={compact ? `${label} · ${titleFor(clip)}` : titleFor(clip)}
      aria-label={compact ? label : undefined}
      role={compact ? "img" : undefined}
      style={{ whiteSpace: "nowrap" }}
    >
      <Icon name="trash" size={compact ? 11 : 10} />
      {!compact && label}
    </span>
  );
}

/** One-line drawer explanation for a deleted video. */
export function useDeletedVideoExplanation(): string {
  const { t } = useTranslation();
  return t("clipVideo.deleted.explain", {
    defaultValue:
      "The video was deleted to save space. Face photos and attendance results are kept.",
  });
}

/** Drawer notice shown in place of the player for a deleted video. */
export function DeletedVideoNotice({ clip }: { clip: PersonClipOut }) {
  const titleFor = useDeletedVideoTitle();
  const explain = useDeletedVideoExplanation();
  return (
    <div className="cl-deleted-notice" role="note">
      <Icon name="trash" size={16} />
      <span>
        <strong>{titleFor(clip)}</strong>
        <br />
        {explain}
      </span>
    </div>
  );
}

/** Table cell content: original file name (muted) + "Video deleted"
 *  pill. ``name`` is whatever the caller would otherwise display. */
export function DeletedClipName({ clip, name }: { clip: PersonClipOut; name: string }) {
  const { t } = useTranslation();
  // Unknown original name: the generated ``clip-<start>`` stamp is
  // shown muted + italic so it doesn't read as a real file name.
  const unknown = originalNotRecorded(clip);
  return (
    <span className="cl-deleted-name">
      <span
        className={`cl-deleted-text${unknown ? " is-unknown" : ""}`}
        title={
          unknown
            ? t("clipVideo.deleted.nameNotRecorded", {
                defaultValue: "Original file name not recorded",
              })
            : name
        }
      >
        {name}
      </span>
      <DeletedVideoPill clip={clip} compact />
    </span>
  );
}

/** Tooltip for the size cell of a deleted clip. */
export function useDeletedSizeTitle(): (c: PersonClipOut) => string {
  const { t } = useTranslation();
  const explain = useDeletedVideoExplanation();
  return (c) =>
    originalNotRecorded(c)
      ? t("clipVideo.deleted.sizeNotRecorded", {
          defaultValue: "Original size not recorded",
        })
      : explain;
}
