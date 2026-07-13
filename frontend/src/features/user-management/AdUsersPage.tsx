// Settings → Users → AD Users tab. The directory synced from Microsoft
// Entra. Sync button + filter/search + per-user access toggle + role
// management via the details drawer. The page chrome (settings tabs,
// title, sub-tab switcher) lives in UsersPage — this is just the view.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "../../api/client";
import { RelativeTime } from "../../components/RelativeTime";
import { Icon } from "../../shell/Icon";
import { EmployeeDrawer } from "../employees/EmployeeDrawer";
import { GroupRoleMappingModal } from "./GroupRoleMappingModal";
import { SyncConfirmModal } from "./SyncConfirmModal";
import { UserDetailsDrawer } from "./UserDetailsDrawer";
import { AccessToggle, RoleBadges, avatarInitials, avatarColor } from "./shared";
import { useAdUsers, usePatchUser, useSyncUsers } from "./hooks";
import type { AdUser } from "./types";

type Filter = "all" | "enabled" | "disabled";

export function AdUsersView() {
  const { t } = useTranslation();
  const list = useAdUsers();
  const sync = useSyncUsers();
  const patch = usePatchUser();

  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<number | null>(null);
  // When a user has a linked employee record, clicking the row opens the
  // employee edit drawer instead of the user-details drawer.
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<number | null>(null);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const items = list.data?.items ?? [];
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((u) => {
      if (filter === "enabled" && !u.is_active) return false;
      if (filter === "disabled" && u.is_active) return false;
      if (!needle) return true;
      return (
        u.full_name.toLowerCase().includes(needle) ||
        u.email.toLowerCase().includes(needle) ||
        (u.department ?? "").toLowerCase().includes(needle)
      );
    });
  }, [items, q, filter]);

  const onSync = async (defaultRole: string | null, createEmployees: boolean) => {
    setError(null);
    setToast(null);
    try {
      const r = await sync.mutateAsync({
        default_role: defaultRole,
        create_employees: createEmployees,
      });
      setSyncOpen(false);
      const parts = [
        t("userManagement.syncResult", {
          added: r.added,
          updated: r.updated,
          failed: r.failed,
        }),
      ];
      if (r.default_role_assigned > 0) {
        parts.push(
          t("userManagement.syncRoleAssigned", { n: r.default_role_assigned }),
        );
      }
      if (r.employees_created > 0) {
        parts.push(
          t("userManagement.syncEmployeesCreated", { n: r.employees_created }),
        );
      }
      setToast(parts.join(" · "));
    } catch (err) {
      setSyncOpen(false);
      setError(
        err instanceof ApiError && typeof (err.body as { detail?: unknown })?.detail === "string"
          ? String((err.body as { detail?: unknown }).detail)
          : t("userManagement.syncFailed"),
      );
    }
  };

  const onToggleAccess = async (u: AdUser) => {
    setError(null);
    try {
      await patch.mutateAsync({ userId: u.id, is_active: !u.is_active });
    } catch {
      setError(t("userManagement.updateFailed"));
    }
  };

  const selectedUser = items.find((u) => u.id === selected) ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {toast && !error && (
        <div
          role="status"
          style={{
            background: "color-mix(in srgb, #0a8a52 8%, var(--bg))",
            border: "1px solid var(--success-border)",
            padding: "10px 14px",
            borderRadius: 10,
            fontSize: 13,
            display: "flex",
            gap: 8,
            alignItems: "center",
            color: "var(--success-text)",
            fontWeight: 500,
          }}
        >
          <Icon name="check" size={14} />
          {toast}
        </div>
      )}
      {error && (
        <div
          role="alert"
          style={{
            background: "var(--danger-soft)",
            color: "var(--danger-text)",
            border: "1px solid var(--danger-border)",
            padding: "10px 14px",
            borderRadius: 10,
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ position: "relative", flex: "1 1 260px", minWidth: 220 }}>
          <span
            style={{
              position: "absolute",
              insetInlineStart: 10,
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--text-tertiary)",
              display: "flex",
            }}
          >
            <Icon name="search" size={14} />
          </span>
          <input
            className="input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("userManagement.searchPlaceholder")}
            style={{ paddingInlineStart: 30 }}
          />
        </div>

        <div className="seg" role="group" aria-label={t("userManagement.filter")}>
          {(["all", "enabled", "disabled"] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={`seg-btn${filter === f ? " active" : ""}`}
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
            >
              {t(`userManagement.filter_${f}`)}
            </button>
          ))}
        </div>

        <div style={{ fontSize: 12.5, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
          <strong>{list.data?.total ?? 0}</strong> {t("userManagement.total")} ·{" "}
          <span style={{ color: "var(--success-text)" }}>{list.data?.enabled ?? 0}</span>{" "}
          {t("userManagement.enabled")} ·{" "}
          <span style={{ color: "var(--text-tertiary)" }}>{list.data?.disabled ?? 0}</span>{" "}
          {t("userManagement.disabled")}
        </div>

        <div style={{ marginInlineStart: "auto", display: "flex", gap: 8 }}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setMappingOpen(true)}
          >
            <Icon name="settings" size={13} />
            {t("userManagement.configureRoles")}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => {
              setError(null);
              setSyncOpen(true);
            }}
            disabled={sync.isPending}
          >
            <Icon name="refresh" size={13} />
            {sync.isPending ? t("userManagement.syncing") : t("userManagement.sync")}
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="card" style={{ overflow: "hidden" }}>
        {list.isLoading ? (
          <div style={{ padding: 22, color: "var(--text-tertiary)", fontSize: 13 }}>
            {t("common.loading")}…
          </div>
        ) : list.error ? (
          <div style={{ padding: 22, color: "var(--danger-text)", fontSize: 13 }}>
            {t("userManagement.loadFailed")}
          </div>
        ) : filtered.length === 0 ? (
          <div
            style={{
              padding: "36px 20px",
              textAlign: "center",
              color: "var(--text-secondary)",
              fontSize: 13,
            }}
          >
            {items.length === 0
              ? t("userManagement.empty")
              : t("userManagement.noMatch")}
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "start", color: "var(--text-tertiary)" }}>
                <Th>{t("userManagement.colUser")}</Th>
                <Th>{t("userManagement.colDepartment")}</Th>
                <Th>{t("userManagement.colRole")}</Th>
                <Th>{t("userManagement.colAccess")}</Th>
                <Th align="end">{t("userManagement.colLastLogin")}</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <tr
                  key={u.id}
                  onClick={() =>
                    u.employee_id != null
                      ? setSelectedEmployeeId(u.employee_id)
                      : setSelected(u.id)
                  }
                  style={{
                    borderTop: "1px solid var(--border)",
                    cursor: "pointer",
                  }}
                >
                  <td style={tdStyle}>
                    <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                      <Avatar name={u.full_name} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>{u.full_name}</div>
                        <div
                          style={{
                            color: "var(--text-secondary)",
                            fontSize: 12,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            maxWidth: 320,
                          }}
                        >
                          {u.email}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td style={tdStyle}>
                    {u.department ? (
                      <span className="pill pill-neutral">{u.department}</span>
                    ) : (
                      <span style={{ color: "var(--text-tertiary)" }}>—</span>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <RoleBadges codes={u.role_codes} />
                  </td>
                  <td style={tdStyle} onClick={(e) => e.stopPropagation()}>
                    <AccessToggle
                      checked={u.is_active}
                      onChange={() => void onToggleAccess(u)}
                      disabled={patch.isPending}
                    />
                  </td>
                  <td style={{ ...tdStyle, textAlign: "end", color: "var(--text-secondary)" }}>
                    {u.last_login_at ? (
                      <RelativeTime iso={u.last_login_at} />
                    ) : (
                      <span style={{ color: "var(--text-tertiary)" }}>
                        {t("userManagement.never")}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selectedUser && (
        <UserDetailsDrawer
          user={selectedUser}
          onClose={() => setSelected(null)}
        />
      )}
      {selectedEmployeeId != null && (
        <EmployeeDrawer
          employeeId={selectedEmployeeId}
          onClose={() => setSelectedEmployeeId(null)}
          onSaved={() => void list.refetch()}
        />
      )}
      {mappingOpen && (
        <GroupRoleMappingModal onClose={() => setMappingOpen(false)} />
      )}
      {syncOpen && (
        <SyncConfirmModal
          onClose={() => setSyncOpen(false)}
          onConfirm={(defaultRole, createEmployees) =>
            void onSync(defaultRole, createEmployees)
          }
          pending={sync.isPending}
        />
      )}
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "end" }) {
  return (
    <th
      style={{
        padding: "10px 14px",
        fontSize: 10.5,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        textAlign: align === "end" ? "end" : "start",
        borderBottom: "1px solid var(--border)",
      }}
    >
      {children}
    </th>
  );
}

const tdStyle: React.CSSProperties = { padding: "11px 14px", verticalAlign: "middle" };

function Avatar({ name }: { name: string }) {
  return (
    <span
      style={{
        width: 34,
        height: 34,
        borderRadius: "50%",
        background: avatarColor(name),
        color: "#fff",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 12,
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      {avatarInitials(name)}
    </span>
  );
}
