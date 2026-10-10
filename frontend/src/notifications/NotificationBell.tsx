// Topbar bell — unread count badge + dropdown panel listing the
// last 20. Click a row to mark it read and follow ``link_url``.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { RelativeTime } from "../components/RelativeTime";
import { Icon, type IconName } from "../shell/Icon";
import {
  useMarkAllRead,
  useMarkRead,
  useNotifications,
} from "./hooks";
import { type NotificationItem } from "./types";
import { animateRowOut, animateRowsOut } from "./rowExit";
import "../requests/workflow.css";

export function NotificationBell() {
  const { t } = useTranslation();
  const list = useNotifications(20);
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Click outside to close.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (
        ref.current &&
        !ref.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const unread = list.data?.unread_count ?? 0;
  // The bell lists UNREAD notifications only: reading one (click, its ×,
  // or "Mark all read") moves it out of the bell. The full history — and
  // the Clear all option — live on the Notifications page.
  const allItems = list.data?.items ?? [];
  const items = allItems.filter((n) => n.read_at == null);

  const onItemClick = (n: NotificationItem) => {
    if (n.read_at == null) markRead.mutate(n.id);
    setOpen(false);
  };

  return (
    <div ref={ref} className="wf-bell-wrap">
      <button
        type="button"
        className="icon-btn"
        aria-label={t("notifications.bell.label")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{ position: "relative" }}
      >
        <Icon name="bell" size={14} />
        {unread > 0 && (
          <span className="wf-bell-badge" aria-label={t("notifications.bell.unreadAria", { count: unread })}>
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div role="dialog" aria-label={t("notifications.bell.title")} className="wf-bell-panel">
          <header className="wf-bell-head">
            <span className="wf-bell-title">{t("notifications.bell.title")}</span>
            <span className="wf-bell-head-actions">
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={async () => {
                  await animateRowsOut(Array.from(document.querySelectorAll<HTMLElement>(".wf-bell-list > .wf-bell-li")));
                  markAll.mutate();
                }}
                disabled={unread === 0 || markAll.isPending}
              >
                <Icon name="check" size={11} /> {t("notifications.bell.markAllRead")}
              </button>
            </span>
          </header>

          {items.length === 0 ? (
            <div className="wf-bell-empty">
              {allItems.length > 0
                ? t("notifications.bell.allRead", { defaultValue: "You're all caught up — no unread notifications." })
                : t("notifications.bell.empty")}
            </div>
          ) : (
            <ul className="wf-notif-list wf-bell-list">
              {items.map((n) => (
                <li key={n.id} className="wf-bell-li">
                  <RowAction
                    notification={n}
                    onClick={() => onItemClick(n)}
                  />
                  <button
                    type="button"
                    className="wf-bell-clear"
                    aria-label={t("notifications.markReadClear", { defaultValue: "Mark as read" })}
                    title={t("notifications.markReadClear", { defaultValue: "Mark as read" })}
                    onClick={async (e) => {
                      // Fade the row out of the bell first, then mark it read
                      // (which removes it from the unread-only list).
                      await animateRowOut((e.currentTarget as HTMLElement).closest<HTMLElement>(".wf-bell-li"));
                      markRead.mutate(n.id);
                    }}
                  >
                    <Icon name="x" size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <footer className="wf-bell-foot">
            <Link to="/notifications" onClick={() => setOpen(false)}>
              {t("notifications.bell.seeAll")}
            </Link>
          </footer>
        </div>
      )}
    </div>
  );
}

/** Swap the hyphens inside ISO dates for non-breaking hyphens so a wrapped
 *  title never splits "2026-10-11" across two lines. */
function keepDatesTogether(text: string): string {
  return text.replace(/(\d{4})-(\d{2})-(\d{2})/g, "$1\u2011$2\u2011$3");
}

const CATEGORY_ICON: Record<string, IconName> = {
  approval_assigned: "inbox",
  approval_decided: "check",
  overtime_flagged: "clock",
  camera_unreachable: "camera",
  report_ready: "fileText",
  admin_override: "shield",
};
const CATEGORY_TONE: Record<string, "accent" | "success" | "warning" | "danger" | "info" | "neutral"> = {
  approval_assigned: "accent",
  approval_decided: "success",
  overtime_flagged: "warning",
  camera_unreachable: "danger",
  report_ready: "info",
  admin_override: "warning",
};

function RowAction({
  notification,
  onClick,
}: {
  notification: NotificationItem;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const unread = notification.read_at == null;
  const cls = `wf-bell-item${unread ? " is-unread" : ""}`;
  const category = t(`notifications.categories.${notification.category}`, {
    defaultValue: notification.category,
  });
  // One compact row: category icon · subject (one line, full text in the
  // tooltip) · category + time. The body is left to the Notifications
  // page — repeating it here made every item three or four lines long.
  const inner = (
    <>
      <span className={`wf-bell-icon tone-${CATEGORY_TONE[notification.category] ?? "neutral"}`} aria-hidden>
        <Icon name={CATEGORY_ICON[notification.category] ?? "bell"} size={14} />
      </span>
      <span className="wf-bell-text">
        <span className="wf-bell-subject" title={notification.body ? `${notification.subject}\n${notification.body}` : notification.subject}>
          {keepDatesTogether(notification.subject)}
        </span>
        <span className="wf-bell-meta">
          {category}
          <span aria-hidden> · </span>
          <RelativeTime iso={notification.created_at} />
        </span>
      </span>
      <span className="wf-notif-dot" aria-hidden />
    </>
  );
  if (notification.link_url) {
    return (
      <Link to={notification.link_url} onClick={onClick} className={cls}>
        {inner}
      </Link>
    );
  }
  return (
    <div onClick={onClick} role="button" tabIndex={0} className={cls} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onClick(); }}>
      {inner}
    </div>
  );
}
