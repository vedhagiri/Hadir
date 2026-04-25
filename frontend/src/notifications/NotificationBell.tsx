// Topbar bell — unread count badge + dropdown panel listing the
// last 20. Click a row to mark it read and follow ``link_url``.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Icon } from "../shell/Icon";
import {
  useMarkAllRead,
  useMarkRead,
  useNotifications,
} from "./hooks";
import { type NotificationItem } from "./types";


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
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        className="icon-btn"
        aria-label={t("notifications.bell.label")}
        onClick={() => setOpen((o) => !o)}
        style={{ position: "relative" }}
      >
        <Icon name="bell" size={14} />
        {unread > 0 && (
          <span
            aria-label={t("notifications.bell.unreadAria", { count: unread })}
            style={{
              position: "absolute",
              top: -2,
              insetInlineEnd: -2,
              background: "var(--danger-bg, #b91c1c)",
              color: "white",
              fontSize: 9,
              fontWeight: 700,
              borderRadius: 8,
              padding: "1px 5px",
              minWidth: 14,
              textAlign: "center",
              border: "1px solid var(--bg)",
            }}
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t("notifications.bell.title")}
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            insetInlineEnd: 0,
            width: 360,
            maxHeight: 480,
            overflow: "auto",
            background: "var(--bg)",
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--radius)",
            boxShadow: "var(--shadow-lg)",
            zIndex: 60,
          }}
        >
          <header
            style={{
              padding: "10px 12px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <strong style={{ fontSize: 13 }}>
              {t("notifications.bell.title")}
            </strong>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => markAll.mutate()}
              disabled={unread === 0 || markAll.isPending}
            >
              {t("notifications.bell.markAllRead")}
            </button>
          </header>

          {items.length === 0 ? (
            <div
              style={{
                padding: 16,
                color: "var(--text-secondary)",
                fontSize: 13,
                textAlign: "center",
              }}
            >
              {t("notifications.bell.empty")}
            </div>
          ) : (
            <ul
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
              }}
            >
              {items.map((n) => (
                <li
                  key={n.id}
                  style={{
                    borderBottom: "1px solid var(--border)",
                    background:
                      n.read_at == null ? "var(--bg-sunken)" : "transparent",
                  }}
                >
                  <RowAction
                    notification={n}
                    onClick={() => onItemClick(n)}
                  />
                </li>
              ))}
            </ul>
          )}

          <footer
            style={{
              padding: "8px 12px",
              borderTop: "1px solid var(--border)",
              textAlign: "center",
            }}
          >
            <Link
              to="/notifications"
              onClick={() => setOpen(false)}
              style={{
                fontSize: 12.5,
                color: "var(--accent)",
                textDecoration: "none",
              }}
            >
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
  const inner = (
    <div
      style={{
        padding: "10px 12px",
        cursor: notification.link_url ? "pointer" : "default",
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <div className="text-xs text-dim" style={{ fontWeight: 500 }}>
        {t(`notifications.categories.${notification.category}`, {
          defaultValue: notification.category,
        })}
        <span style={{ marginInlineStart: 8 }}>
          {new Date(notification.created_at).toLocaleString()}
        </span>
      </div>
      <div
        style={{
          fontSize: 13,
          fontWeight: notification.read_at == null ? 600 : 400,
        }}
      >
        {notification.subject}
      </div>
      {notification.body && (
        <div
          className="text-xs text-dim"
          style={{
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {notification.body}
        </div>
      )}
    </div>
  );
  if (notification.link_url) {
    return (
      <Link
        to={notification.link_url}
        onClick={onClick}
        style={{
          display: "block",
          color: "inherit",
          textDecoration: "none",
        }}
      >
        {inner}
      </Link>
    );
  }
  return (
    <div onClick={onClick} role="button">
      {inner}
    </div>
  );
}
