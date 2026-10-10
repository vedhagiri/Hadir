// Shared reference-photo gallery viewer + gallery card.
//
// Used by /my-profile (own photos) and /photo-approvals (Admin/HR
// review queue). The viewer is a centred dialog: the large photo on a
// dark stage (prev/next + "n of N") and an info rail on the end side
// (caller-rendered facts, an all-photos grid, optional actions).
// Esc closes, ←/→ navigate (flipped in RTL), body scroll is locked
// while open, focus returns to the element that opened it.
//
// Styling: people.css, prefix ``pp-pv-``.

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { Icon } from "../../shell/Icon";

export interface PhotoViewerProps<P> {
  photos: P[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  /** Rail heading, e.g. "Reference photos" or the employee's name. */
  title: ReactNode;
  getKey: (p: P) => number | string;
  /** Full-size image URL for the stage. */
  getSrc: (p: P) => string;
  /** Small image URL for the all-photos grid (defaults to getSrc). */
  getThumbSrc?: (p: P) => string;
  getAlt: (p: P) => string;
  /** Accessible label for a grid item ("Open Front photo"). */
  getLabel: (p: P) => string;
  /** Status modifier for the grid item dot: "approved" | "pending" | … */
  getStatus?: (p: P) => string;
  /** Side-panel facts for the current photo. */
  renderInfo: (p: P) => ReactNode;
  /** Optional footer actions for the current photo. */
  actions?: (p: P) => ReactNode;
}

export function PhotoViewer<P>({
  photos,
  index,
  onIndex,
  onClose,
  title,
  getKey,
  getSrc,
  getThumbSrc,
  getAlt,
  getLabel,
  getStatus,
  renderInfo,
  actions,
}: PhotoViewerProps<P>) {
  const { t } = useTranslation();
  const count = photos.length;
  const photo = photos[Math.min(Math.max(index, 0), count - 1)];
  const go = (delta: number) => onIndex((index + delta + count) % count);
  const goRef = useRef(go);
  goRef.current = go;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const rtl = document.documentElement.dir === "rtl";
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const target = e.target as HTMLElement | null;
        if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
        e.preventDefault();
        const forward = (e.key === "ArrowRight") !== rtl;
        goRef.current(forward ? 1 : -1);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
      opener?.focus?.();
    };
  }, []);

  if (photo === undefined) return null;
  const thumb = getThumbSrc ?? getSrc;
  const footer = actions?.(photo);

  return createPortal(
    <div
      className="pp-pv"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="pp-pv-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("employees.photos.preview", { defaultValue: "Photo preview" }) as string}
      >
        <div className="pp-pv-stage">
          <img key={getKey(photo)} className="pp-pv-img" src={getSrc(photo)} alt={getAlt(photo)} />
          {count > 1 && (
            <>
              <button
                type="button"
                className="pp-pv-nav is-prev"
                onClick={() => go(-1)}
                aria-label={t("myProfile.viewer.prev", { defaultValue: "Previous photo" }) as string}
              >
                <Icon name="chevronLeft" size={20} />
              </button>
              <button
                type="button"
                className="pp-pv-nav is-next"
                onClick={() => go(1)}
                aria-label={t("myProfile.viewer.next", { defaultValue: "Next photo" }) as string}
              >
                <Icon name="chevronRight" size={20} />
              </button>
            </>
          )}
          <span className="pp-pv-count">
            {t("myProfile.viewer.counter", {
              defaultValue: "{{n}} of {{total}}",
              n: index + 1,
              total: count,
            }) as string}
          </span>
        </div>

        <aside className="pp-pv-rail">
          <div className="pp-pv-rail-head">
            <h2 className="pp-pv-title">{title}</h2>
            <button
              type="button"
              className="icon-btn"
              onClick={onClose}
              aria-label={t("common.close", { defaultValue: "Close" }) as string}
              title={(t("common.close", { defaultValue: "Close" }) as string) + " (Esc)"}
              autoFocus
            >
              <Icon name="x" size={16} />
            </button>
          </div>

          <div className="pp-pv-info">{renderInfo(photo)}</div>

          {count > 1 && (
            <>
              <span className="pp-pv-label">
                {t("myProfile.viewer.all", { defaultValue: "All photos" }) as string}
              </span>
              <div className="pp-pv-grid">
                {photos.map((p, i) => (
                  <button
                    key={getKey(p)}
                    type="button"
                    className={`pp-pv-grid-item${getStatus ? ` is-${getStatus(p)}` : ""}${i === index ? " is-active" : ""}`}
                    onClick={() => onIndex(i)}
                    aria-label={getLabel(p)}
                    aria-current={i === index}
                  >
                    <img src={thumb(p)} alt="" loading="lazy" />
                  </button>
                ))}
              </div>
            </>
          )}

          {footer && <div className="pp-pv-actions">{footer}</div>}
        </aside>
      </div>
    </div>,
    document.body,
  );
}

/** One label/value row in the viewer's info panel. */
export function PhotoViewerFact({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="pp-pv-fact" title={title}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Gallery card: fixed-aspect photo (opens the viewer), status pill
 *  top-start, hover "View", caption + optional trailing/footer slots. */
export function PhotoCard({
  src,
  alt,
  openLabel,
  onOpen,
  status,
  statusPill,
  title,
  meta,
  trailing,
  footer,
}: {
  src: string;
  alt: string;
  openLabel: string;
  onOpen: () => void;
  /** Modifier for the card border: "approved" | "pending" | "rejected". */
  status: string;
  statusPill: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  /** Small control at the end of the caption row (e.g. delete). */
  trailing?: ReactNode;
  /** Full-width row under the caption (e.g. Approve / Reject). */
  footer?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <li className={`pp-pv-card is-${status}`}>
      <button type="button" className="pp-pv-card-open" onClick={onOpen} aria-label={openLabel}>
        <img src={src} alt={alt} loading="lazy" />
        <span className="pp-pv-card-hover" aria-hidden>
          <Icon name="eye" size={18} />
          {t("myProfile.viewer.view", { defaultValue: "View" }) as string}
        </span>
      </button>
      <span className="pp-pv-card-status">{statusPill}</span>
      <div className="pp-pv-card-cap">
        <div className="pp-pv-card-text">
          <span className="pp-pv-card-title">{title}</span>
          {meta && <span className="pp-pv-card-meta">{meta}</span>}
        </div>
        {trailing}
      </div>
      {footer && <div className="pp-pv-card-foot">{footer}</div>}
    </li>
  );
}
