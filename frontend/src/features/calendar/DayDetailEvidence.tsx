// Evidence gallery for the Day detail panel: face crops from the
// existing crop endpoint, click-to-preview lightbox (← → / Esc), and
// the "flash" highlight the timeline triggers when a dot is clicked.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { Icon } from "../../shell/Icon";
import { useTenantDateTime } from "../../util/datetime";
import type { EvidenceCrop } from "./types";

function confTone(c: number | null | undefined): "high" | "mid" | "low" | "unknown" {
  if (c == null) return "unknown";
  return c >= 0.75 ? "high" : c >= 0.5 ? "mid" : "low";
}

export function bestConfidence(evidence: EvidenceCrop[]): number | null {
  return evidence.reduce<number | null>((acc, e) => {
    if (e.confidence == null) return acc;
    return acc == null || e.confidence > acc ? e.confidence : acc;
  }, null);
}

export function EvidenceGallery({
  evidence,
  highlightedEventId,
  registerRef,
  isoDate,
}: {
  evidence: EvidenceCrop[];
  highlightedEventId: number | null;
  registerRef?: (eventId: number, el: HTMLDivElement | null) => void;
  isoDate: string;
}) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  return (
    <>
      <div className="dd-ev-grid">
        {evidence.map((ev, idx) => (
          <EvidenceCard
            key={ev.detection_event_id}
            item={ev}
            flashing={ev.detection_event_id === highlightedEventId}
            registerRef={(el) => registerRef?.(ev.detection_event_id, el)}
            onOpen={() => setLightboxIndex(idx)}
          />
        ))}
      </div>
      {lightboxIndex != null && (
        <EvidenceLightbox
          evidence={evidence}
          initialIndex={lightboxIndex}
          isoDate={isoDate}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </>
  );
}

function EvidenceCard({
  item,
  flashing,
  registerRef,
  onOpen,
}: {
  item: EvidenceCrop;
  flashing: boolean;
  registerRef?: (el: HTMLDivElement | null) => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const [img, setImg] = useState<"loading" | "loaded" | "broken">("loading");
  return (
    <div
      ref={registerRef}
      data-event-id={item.detection_event_id}
      className={`dd-ev-card${flashing ? " is-flash" : ""}`}
    >
      <button
        type="button"
        className="dd-ev-btn"
        onClick={onOpen}
        aria-label={`${t("calendar.openEvidence", { defaultValue: "Open larger view" }) as string} — ${item.captured_at.slice(0, 5)} ${item.camera_code}`}
      >
        {img !== "broken" && (
          <img
            src={item.crop_url}
            alt={`${item.captured_at} ${item.camera_code}`}
            loading="lazy"
            onLoad={() => setImg("loaded")}
            onError={() => setImg("broken")}
            className={img === "loaded" ? "is-loaded" : undefined}
          />
        )}
        {img === "loading" && <span aria-hidden className="dd-ev-shimmer" />}
        {img === "broken" && (
          <span className="dd-ev-broken">
            <Icon name="info" size={16} />
            {t("calendar.evidenceUnavailable", { defaultValue: "Crop unavailable" }) as string}
          </span>
        )}
        {item.confidence != null && (
          <span className={`dd-ev-conf conf-${confTone(item.confidence)}`}>
            {(item.confidence * 100).toFixed(0)}%
          </span>
        )}
        <span aria-hidden className="dd-ev-zoom">
          <Icon name="search" size={14} />
        </span>
      </button>
      <div className="dd-ev-meta">
        <span className="dd-ev-time mono">{dt.formatLocalTime(item.captured_at)}</span>
        <span className="dd-ev-cam" title={item.camera_code}>
          <Icon name="camera" size={10} />
          {item.camera_code}
        </span>
      </div>
    </div>
  );
}

// Split-panel lightbox. Portals out of .drawer to escape its fixed
// containing block.
function EvidenceLightbox({
  evidence,
  initialIndex,
  isoDate,
  onClose,
}: {
  evidence: EvidenceCrop[];
  initialIndex: number;
  isoDate: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const [idx, setIdx] = useState(initialIndex);
  const total = evidence.length;
  const item = evidence[idx]!;

  const prev = () => setIdx((i) => (i - 1 + total) % total);
  const next = () => setIdx((i) => (i + 1) % total);

  // Mount-only key handler; the ref keeps prev/next/onClose current.
  const handlers = useRef({ prev, next, onClose });
  handlers.current = { prev, next, onClose };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const h = handlers.current;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); h.onClose(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); h.prev(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); h.next(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  const timeStr = item.captured_at.length >= 8 ? item.captured_at.slice(0, 8) : item.captured_at;
  const confPct = item.confidence != null ? `${(item.confidence * 100).toFixed(1)}%` : null;

  const target = typeof document !== "undefined"
    ? (document.getElementById("drawer-root") ?? document.body)
    : null;

  const modal = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("calendar.lightboxAria", { defaultValue: "Face crop preview" }) as string}
      className="dd-lb"
      onClick={onClose}
    >
      <div className="dd-lb-card" onClick={(e) => e.stopPropagation()}>
        <div className="dd-lb-stage">
          <div className="dd-lb-img">
            <img key={item.detection_event_id} src={item.crop_url} alt={`${timeStr} ${item.camera_code}`} />
          </div>
          {total > 1 && (
            <>
              <button type="button" className="dd-lb-nav is-prev" onClick={prev} aria-label={t("calendar.lightboxPrev", { defaultValue: "Previous" }) as string}>
                <Icon name="chevronLeft" size={18} />
              </button>
              <button type="button" className="dd-lb-nav is-next" onClick={next} aria-label={t("calendar.lightboxNext", { defaultValue: "Next" }) as string}>
                <Icon name="chevronRight" size={18} />
              </button>
            </>
          )}
          <div className="dd-lb-count mono">{idx + 1} / {total}</div>
          {total > 1 && (
            <div className="dd-lb-strip">
              {evidence.map((ev, i) => (
                <button
                  key={ev.detection_event_id}
                  type="button"
                  className={i === idx ? "is-active" : undefined}
                  onClick={() => setIdx(i)}
                  aria-label={`Crop ${i + 1}`}
                  aria-pressed={i === idx}
                >
                  <img src={ev.crop_url} alt="" />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="dd-lb-side">
          <div className="dd-lb-head">
            <span className="pill pill-neutral dd-lb-cam">
              <Icon name="camera" size={10} /> {item.camera_code}
            </span>
            <button type="button" className="icon-btn" onClick={onClose} aria-label={t("calendar.lightboxClose", { defaultValue: "Close preview" }) as string}>
              <Icon name="x" size={13} />
            </button>
          </div>
          <div className="dd-lb-time">
            <div className="dd-label">{t("calendar.captureTime", { defaultValue: "Capture time" }) as string}</div>
            <div className="dd-lb-time-value mono">{dt.formatLocalTime(item.captured_at)}</div>
            <div className="dd-lb-date">{dt.formatLocalDate(isoDate) || isoDate}</div>
          </div>
          {item.confidence != null && (
            <div className="dd-lb-conf">
              <div className="dd-lb-conf-row">
                <span>{t("calendar.matchConfidence", { defaultValue: "Match confidence" }) as string}</span>
                <b className="mono">{confPct}</b>
              </div>
              <div className={`dd-bar conf-${confTone(item.confidence)}`}>
                <span style={{ width: `${Math.min(100, item.confidence * 100)}%` }} />
              </div>
            </div>
          )}
          <dl className="dd-lb-meta">
            <div><dt>{t("calendar.meta.camera", { defaultValue: "Camera" }) as string}</dt><dd>{item.camera_code}</dd></div>
            <div><dt>{t("calendar.meta.eventId", { defaultValue: "Event ID" }) as string}</dt><dd className="mono">#{item.detection_event_id}</dd></div>
            <div><dt>{t("calendar.meta.seconds", { defaultValue: "Full time" }) as string}</dt><dd className="mono">{timeStr}</dd></div>
            <div><dt>{t("calendar.meta.confidence", { defaultValue: "Confidence" }) as string}</dt><dd className="mono">{confPct ?? "—"}</dd></div>
          </dl>
          <div className="dd-lb-hint">
            {t("calendar.lightboxHint", { defaultValue: "← → to navigate · Esc to close" }) as string}
          </div>
        </div>
      </div>
    </div>
  );

  return target ? createPortal(modal, target) : modal;
}
