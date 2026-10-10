// Topbar bell — unread count badge + dropdown panel listing the
// last 20. Click a row to mark it read and follow ``link_url``.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { RelativeTime } from "../components/RelativeTime";
import { Icon } from "../shell/Icon";
import {
  useMarkAllRead,
  useMarkRead,
  useNotifications,
} from "./hooks";
import { type NotificationItem } from "./types";
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
  const items = list.data?.items ?? [];

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
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => markAll.mutate()}
              disabled={unread === 0 || markAll.isPending}
            >
              <Icon name="check" size={11} /> {t("notifications.bell.markAllRead")}
            </button>
          </header>

          {items.length === 0 ? (
            <div className="wf-bell-empty">{t("notifications.bell.empty")}</div>
          ) : (
            <ul className="wf-notif-list wf-bell-list">
              {items.map((n) => (
                <li key={n.id}>
                  <RowAction
                    notification={n}
                    onClick={() => onItemClick(n)}
                  />
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
  const inner = (
    <>
      <span className="wf-notif-dot" aria-hidden />
      <div className="wf-notif-main">
        <div className="wf-notif-meta">
          <span className="text-xs" style={{ fontWeight: 600, color: "var(--text-secondary)" }}>
            {t(`notifications.categories.${notification.category}`, {
              defaultValue: notification.category,
            })}
          </span>
          <span className="wf-notif-time">
            <RelativeTime iso={notification.created_at} />
          </span>
        </div>
        <div className="wf-notif-subject" style={{ fontSize: 13 }}>
          {notification.subject}
        </div>
        {notification.body && (
          <div className="wf-notif-body wf-clamp-2">{notification.body}</div>
        )}
      </div>
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
