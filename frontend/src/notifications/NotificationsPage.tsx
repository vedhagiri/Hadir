// Full notifications history page at /notifications.

import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { useMarkAllRead, useMarkRead, useNotifications } from "./hooks";


export function NotificationsPage() {
  const { t } = useTranslation();
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
            {t("notifications.title")}
          </h1>
          <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 13 }}>
            <Trans
              i18nKey="notifications.page.subtitle"
              components={{
                1: (
                  <Link
                    to="/settings/notifications"
                    style={{
                      color: "var(--accent)",
                      textDecoration: "underline",
                    }}
                  />
                ),
              }}
              values={{ settingsLink: t("notifications.page.settingsLink") }}
            />
          </p>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => markAll.mutate()}
          disabled={(list.data?.unread_count ?? 0) === 0 || markAll.isPending}
        >
          {t("notifications.bell.markAllRead")}
        </button>
      </header>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 200 }}>{t("myRequests.columns.submitted")}</th>
              <th style={{ width: 180 }}>
                {t("notifications.preferences.category")}
              </th>
              <th>{t("approvals.columns.reason")}</th>
              <th style={{ width: 80 }}></th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading ? (
              <tr>
                <td colSpan={4} className="text-sm text-dim">
                  {t("common.loading")}
                </td>
              </tr>
            ) : (list.data?.items ?? []).length === 0 ? (
              <tr>
                <td colSpan={4} className="text-sm text-dim">
                  {t("notifications.bell.empty")}
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
                    {t(`notifications.categories.${n.category}`, {
                      defaultValue: n.category,
                    })}
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
                  <td style={{ textAlign: "end" }}>
                    {n.read_at == null && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => markRead.mutate(n.id)}
                      >
                        {t("notifications.bell.markOneRead")}
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
