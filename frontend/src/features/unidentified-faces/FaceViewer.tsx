// Face viewer — centred dialog with a large crop on a dark stage
// (prev/next + "n / N"), a side panel on the end side (caller-rendered
// facts + actions) and an optional thumbnail strip.
//
// Esc closes, ←/→ navigate (flipped in RTL, ignored while typing in a
// field), body scroll is locked while open and focus returns to the
// element that opened it. Rendered through a portal so ancestor
// overflow / transforms never clip it.

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { Icon } from "../../shell/Icon";
import { FaceImg } from "./ufUi";

export interface FaceViewerProps<T> {
  items: T[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  getId: (item: T) => number;
  hasCrop?: (item: T) => boolean;
  /** Accessible dialog name. */
  label: string;
  /** Panel header: eyebrow chip row + title. */
  renderHeader: (item: T) => ReactNode;
  /** Panel body — facts, map flow, actions. */
  renderPanel: (item: T) => ReactNode;
  /** Optional per-thumbnail badge (e.g. "mapped" tick). */
  thumbBadge?: (item: T) => ReactNode;
  /** zIndex layer — the cluster drawer needs the viewer above it. */
  layer?: number;
}

export function FaceViewer<T>({
  items,
  index,
  onIndex,
  onClose,
  getId,
  hasCrop,
  label,
  renderHeader,
  renderPanel,
  thumbBadge,
  layer = 700,
}: FaceViewerProps<T>) {
  const { t } = useTranslation();
  const count = items.length;
  const safe = Math.min(Math.max(index, 0), Math.max(0, count - 1));
  const item = items[safe];
  const canPrev = safe > 0;
  const canNext = safe < count - 1;

  const stateRef = useRef({ safe, count, onIndex, onClose });
  stateRef.current = { safe, count, onIndex, onClose };
  const activeThumbRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      const s = stateRef.current;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        s.onClose();
        return;
      }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      e.preventDefault();
      const rtl = document.documentElement.dir === "rtl";
      const forward = (e.key === "ArrowRight") !== rtl;
      const next = forward ? Math.min(s.count - 1, s.safe + 1) : Math.max(0, s.safe - 1);
      if (next !== s.safe) s.onIndex(next);
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
      opener?.focus?.({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    activeThumbRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [safe]);

  if (!item) return null;
  const id = getId(item);

  return createPortal(
    <div className="unid-viewer-scrim" style={{ zIndex: layer }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={label} className="unid-viewer">
        <div className="unid-viewer-stage">
          <div className="unid-viewer-img" key={id}>
            <FaceImg id={id} hasCrop={hasCrop ? hasCrop(item) : true} alt={t("unidentifiedFaces.faceAlt", "Unknown face") as string} eager />
          </div>
          {count > 1 && (
            <>
              <button
                type="button"
                className="unid-viewer-nav is-prev"
                onClick={() => onIndex(safe - 1)}
                disabled={!canPrev}
                aria-label={t("common.previous", "Previous") as string}
              >
                <Icon name="chevronLeft" size={18} />
              </button>
              <button
                type="button"
                className="unid-viewer-nav is-next"
                onClick={() => onIndex(safe + 1)}
                disabled={!canNext}
                aria-label={t("common.next", "Next") as string}
              >
                <Icon name="chevronRight" size={18} />
              </button>
            </>
          )}
          <span className="unid-viewer-count" aria-live="polite">
            {safe + 1} / {count}
          </span>
        </div>

        <aside className="unid-viewer-panel">
          <div className="unid-viewer-head">
            <div className="unid-viewer-head-main">{renderHeader(item)}</div>
            <button
              ref={closeRef}
              type="button"
              className="btn btn-sm btn-ghost unid-icon-btn"
              onClick={onClose}
              aria-label={t("common.close", "Close") as string}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
          <div className="unid-viewer-body">{renderPanel(item)}</div>
          {count > 1 && (
            <div className="unid-viewer-keys" aria-hidden>
              {t("unidentifiedFaces.viewerKeys", { defaultValue: "← → to browse · Esc to close" }) as string}
            </div>
          )}
        </aside>

        {count > 1 && (
          <div className="unid-viewer-strip" role="tablist" aria-label={t("unidentifiedFaces.thumbStrip", "Face thumbnails") as string}>
            {items.map((it, i) => {
              const active = i === safe;
              const itId = getId(it);
              return (
                <button
                  key={itId}
                  ref={active ? activeThumbRef : null}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-label={t("unidentifiedFaces.faceN", "Face {{n}}", { n: i + 1 }) as string}
                  className={`unid-viewer-thumb${active ? " is-active" : ""}`}
                  onClick={() => onIndex(i)}
                >
                  <FaceImg id={itId} hasCrop={hasCrop ? hasCrop(it) : true} />
                  {thumbBadge?.(it)}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
