// Shared pagination control used by every paginated table (Employees,
// Camera Logs, Clip Logs, Clip Analytics). Renders an optional localised
// summary on the start side and the nav on the end:
//
//     [ summary ]                    ‹ Prev  1 … 4 [5] 6 … 20  Next ›
//
// Behaviour:
//   * Previous is disabled on the first page; Next on the last page.
//   * Page numbers are windowed — first + last are always shown, the
//     current page ±1 around it, and an ellipsis fills the gaps — so the
//     control stays compact no matter how large the record count is.
//   * The active page is highlighted with the accent colour.
//   * ``flex-wrap`` keeps it tidy on narrow viewports.
//
// Configurable for any page size / record count: pass ``totalPages``
// directly, or pass ``total`` + ``pageSize`` and let the component derive
// the page count.

import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "../shell/Icon";

interface PaginationProps {
  /** 1-based current page. */
  page: number;
  /** Called with the next 1-based page (already clamped to range). */
  onPageChange: (page: number) => void;
  /** Total page count. If omitted, derived from ``total`` / ``pageSize``. */
  totalPages?: number;
  /** Total record count — used to derive ``totalPages`` when not given. */
  total?: number;
  /** Page size — used with ``total`` to derive the page count. Default 50. */
  pageSize?: number;
  /** Disable every control (e.g. while a fetch is in flight). */
  disabled?: boolean;
  /** Localised summary node rendered on the start side. */
  summary?: ReactNode;
}

// Windowed page list: 1 … (cur-1) cur (cur+1) … last. Shows every page
// when the count is small enough to fit without ellipses.
function buildPages(current: number, total: number): (number | "ellipsis")[] {
  const MAX_PLAIN = 7;
  if (total <= MAX_PLAIN) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const out: (number | "ellipsis")[] = [1];
  const left = Math.max(2, current - 1);
  const right = Math.min(total - 1, current + 1);
  if (left > 2) out.push("ellipsis");
  for (let i = left; i <= right; i += 1) out.push(i);
  if (right < total - 1) out.push("ellipsis");
  out.push(total);
  return out;
}

const WRAP: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
  padding: "10px 14px",
  borderTop: "1px solid var(--border)",
  fontSize: 12,
};

const NAV: CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "center",
  flexWrap: "wrap",
};

const PAGE_PLAIN: CSSProperties = {
  minWidth: 32,
  justifyContent: "center",
};

const PAGE_ACTIVE: CSSProperties = {
  minWidth: 32,
  justifyContent: "center",
  background: "var(--accent)",
  color: "white",
  borderColor: "var(--accent)",
  fontWeight: 600,
};

const ELLIPSIS: CSSProperties = {
  padding: "0 4px",
  color: "var(--text-tertiary)",
  userSelect: "none",
};

export function Pagination({
  page,
  onPageChange,
  totalPages,
  total,
  pageSize = 50,
  disabled = false,
  summary,
}: PaginationProps) {
  const { t } = useTranslation();

  const pages = Math.max(
    1,
    totalPages ?? Math.ceil((total ?? 0) / Math.max(1, pageSize)),
  );
  const current = Math.min(Math.max(1, page), pages);
  const atFirst = current <= 1;
  const atLast = current >= pages;

  function go(next: number) {
    if (disabled) return;
    const clamped = Math.min(Math.max(1, next), pages);
    if (clamped !== current) onPageChange(clamped);
  }

  return (
    <div style={WRAP}>
      <span className="text-dim">{summary}</span>
      <div style={NAV}>
        {/* Previous is hidden entirely on the first page (not just
            disabled) so the control reads cleaner at the extremes. */}
        {!atFirst && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={disabled}
            onClick={() => go(current - 1)}
            aria-label={t("common.previous")}
          >
            <Icon name="chevronLeft" size={11} />
            {t("common.previous")}
          </button>
        )}

        {buildPages(current, pages).map((p, idx) =>
          p === "ellipsis" ? (
            <span key={`ellipsis-${idx}`} style={ELLIPSIS} aria-hidden="true">
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              className="btn btn-sm"
              disabled={disabled}
              onClick={() => go(p)}
              aria-label={t("common.goToPage", { page: p })}
              aria-current={p === current ? "page" : undefined}
              style={p === current ? PAGE_ACTIVE : PAGE_PLAIN}
            >
              {p}
            </button>
          ),
        )}

        {/* Next is hidden entirely on the last page. */}
        {!atLast && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={disabled}
            onClick={() => go(current + 1)}
            aria-label={t("common.next")}
          >
            {t("common.next")}
            <Icon name="chevronRight" size={11} />
          </button>
        )}
      </div>
    </div>
  );
}
