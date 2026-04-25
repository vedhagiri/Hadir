// Full notifications history page at /notifications.

import { Link } from "react-router-dom";

import { useMarkAllRead, useMarkRead, useNotifications } from "./hooks";
import { CATEGORY_LABELS } from "./types";


export function NotificationsPage() {
  const list = useNotifications(100);
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
        }}
      >
        <div>
          <h1
            style={{
              fontFamily: "var(--font-display)",
              fontSize: 28,
              margin: "0 0 4px 0",
              fontWeight: 400,
            }}
          >
            Notifications
          </h1>
          <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 13 }}>
            Recent activity targeted at you. Adjust which categories
            land here from{" "}
            <Link
              to="/settings/notifications"
              style={{ color: "var(--accent)", textDecoration: "underline" }}
            >
              Settings → Notifications
            </Link>
            .
          </p>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => markAll.mutate()}
          disabled={(list.data?.unread_count ?? 0) === 0 || markAll.isPending}
        >
          Mark all read
        </button>
      </header>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 200 }}>When</th>
              <th style={{ width: 180 }}>Category</th>
              <th>Subject</th>
              <th style={{ width: 80 }}></th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading ? (
              <tr>
                <td colSpan={4} className="text-sm text-dim">
                  Loading…
                </td>
              </tr>
            ) : (list.data?.items ?? []).length === 0 ? (
              <tr>
                <td colSpan={4} className="text-sm text-dim">
                  Nothing here yet.
                </td>
              </tr>
            ) : (
              list.data!.items.map((n) => (
                <tr
                  key={n.id}
                  style={{
                    background:
                      n.read_at == null ? "var(--bg-sunken)" : "transparent",
                  }}
                >
                  <td className="mono text-xs">
                    {new Date(n.created_at).toLocaleString()}
                  </td>
                  <td className="text-xs">
                    {CATEGORY_LABELS[n.category] ?? n.category}
                  </td>
                  <td>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: n.read_at == null ? 600 : 400,
                      }}
                    >
                      {n.link_url ? (
                        <Link
                          to={n.link_url}
                          onClick={() => {
                            if (n.read_at == null) markRead.mutate(n.id);
                          }}
                          style={{
                            color: "inherit",
                            textDecoration: "none",
                          }}
                        >
                          {n.subject}
                        </Link>
                      ) : (
                        n.subject
                      )}
                    </div>
                    {n.body && (
                      <div
                        className="text-xs text-dim"
                        style={{ marginTop: 2 }}
                      >
                        {n.body}
                      </div>
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {n.read_at == null && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => markRead.mutate(n.id)}
                      >
                        Read
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
