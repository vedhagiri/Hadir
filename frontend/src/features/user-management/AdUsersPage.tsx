// Settings → Users → AD Users tab. The directory synced from Microsoft
// Entra. Sync button + filter/search + per-user access toggle + role
// management via the details drawer. Renders the full page including
// the page header (its actions need this component's state).

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "../../api/client";
import { RelativeTime } from "../../components/RelativeTime";
import { Icon } from "../../shell/Icon";
import { EmployeeDrawer } from "../employees/EmployeeDrawer";
import { GroupRoleMappingModal } from "./GroupRoleMappingModal";
import { SyncConfirmModal } from "./SyncConfirmModal";
import { UserDetailsDrawer } from "./UserDetailsDrawer";
import { AccessToggle, ROLE_ORDER, RoleBadges, avatarInitials, avatarColor } from "./shared";
import { useAdUsers, usePatchUser, useSyncUsers } from "./hooks";
import type { AdUser } from "./types";
import { SkeletonCards, SkeletonRows } from "../../components/Skeleton";
import {
  EmptyPanel,
  FilterSelect,
  ResetButton,
  SearchField,
  StatCard,
  StatGrid,
  Toolbar,
  pct,
} from "../../components/ListPageUi";
import { Banner, DotPill, LoadErrorPanel, PEOPLE_ICON } from "../employees/peopleUi";

type Filter = "all" | "enabled" | "disabled";

export function AdUsersView() {
  const { t } = useTranslation();
  const list = useAdUsers();
  const sync = useSyncUsers();
  const patch = usePatchUser();

  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [roleF, setRoleF] = useState("");
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
      if (roleF === "__none" && u.role_codes.length > 0) return false;
      if (roleF && roleF !== "__none" && !u.role_codes.includes(roleF)) return false;
      if (!needle) return true;
      return (
        u.full_name.toLowerCase().includes(needle) ||
        u.email.toLowerCase().includes(needle) ||
        (u.department ?? "").toLowerCase().includes(needle)
      );
    });
  }, [items, q, filter, roleF]);

  const noRoleCount = items.filter((u) => u.role_codes.length === 0).length;
  const filtersActive = q.trim() !== "" || filter !== "all" || roleF !== "";
  const resetFilters = () => {
    setQ("");
    setFilter("all");
    setRoleF("");
  };

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

  // Five-state rendering: loading / error / nothing synced yet / filters
  // match nothing / data. Stats + toolbar only make sense once there is
  // at least one synced user.
  const noRecords = !list.isLoading && !list.error && items.length === 0;
  const showStats = !list.error && !noRecords;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("userManagement.title")}</h1>
          <p className="page-sub">{t("userManagement.subtitle")}</p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn"
            onClick={() => setMappingOpen(true)}
          >
            <Icon name="settings" size={12} />
            {t("userManagement.configureRoles")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setError(null);
              setSyncOpen(true);
            }}
            disabled={sync.isPending}
          >
            <Icon name="refresh" size={12} />
            {sync.isPending ? t("userManagement.syncing") : t("userManagement.sync")}
          </button>
        </div>
      </div>

      {toast && !error && (
        <Banner tone="success" role="status" title={toast} />
      )}
      {error && <Banner tone="danger" role="alert" title={error} />}

      {list.isLoading ? (
        <SkeletonCards count={4} minWidth={220} />
      ) : showStats ? (
        <StatGrid>
          <StatCard
            tone="info"
            icon={PEOPLE_ICON.people}
            label={t("userManagement.stats.total", { defaultValue: "All users" })}
            value={list.data?.total ?? 0}
            sub={t("userManagement.stats.totalSub", { defaultValue: "From Microsoft Entra" })}
            active={filter === "all"}
            onClick={() => setFilter("all")}
          />
          <StatCard
            tone="success"
            icon={PEOPLE_ICON.key}
            label={t("userManagement.stats.enabled", { defaultValue: "Access enabled" })}
            value={list.data?.enabled ?? 0}
            sub={t("userManagement.stats.pctSub", {
              defaultValue: "{{pct}}% can sign in",
              pct: pct(list.data?.enabled ?? 0, list.data?.total ?? 0),
            })}
            active={filter === "enabled"}
            onClick={() => setFilter("enabled")}
          />
          <StatCard
            tone="neutral"
            icon={PEOPLE_ICON.x}
            label={t("userManagement.stats.disabled", { defaultValue: "Access disabled" })}
            value={list.data?.disabled ?? 0}
            sub={t("userManagement.stats.disabledSub", { defaultValue: "Can’t sign in" })}
            active={filter === "disabled"}
            onClick={() => setFilter("disabled")}
          />
          <StatCard
            tone="warning"
            icon={PEOPLE_ICON.star}
            label={t("userManagement.stats.noRole", { defaultValue: "No role assigned" })}
            value={noRoleCount}
            sub={t("userManagement.stats.noRoleSub", { defaultValue: "Assign one in the user drawer" })}
            active={roleF === "__none"}
            onClick={() => setRoleF(roleF === "__none" ? "" : "__none")}
          />
        </StatGrid>
      ) : null}

      {showStats && !list.isLoading && (
      <Toolbar>
        <SearchField
          value={q}
          onChange={setQ}
          placeholder={t("userManagement.searchPlaceholder")}
          clearLabel={t("userManagement.clearSearch", { defaultValue: "Clear search" })}
        />
        <FilterSelect
          label={t("userManagement.colAccess")}
          value={filter === "all" ? "" : filter}
          onChange={(v) => setFilter(v === "" ? "all" : (v as Filter))}
          options={[
            ["", t("userManagement.filter_all")],
            ["enabled", t("userManagement.filter_enabled")],
            ["disabled", t("userManagement.filter_disabled")],
          ]}
        />
        <FilterSelect
          label={t("userManagement.colRole")}
          value={roleF}
          onChange={setRoleF}
          options={[
            ["", t("userManagement.allRoles", { defaultValue: "All roles" })],
            ...ROLE_ORDER.map((r) => [r, t(`role.${r}`, { defaultValue: r })] as [string, string]),
            ["__none", t("userManagement.noRole")],
          ]}
        />
        <span className="pp-count">
          {filtered.length} / {items.length}
        </span>
        <ResetButton
          active={filtersActive}
          label={t("userManagement.reset", { defaultValue: "Reset" })}
          onClick={resetFilters}
        />
      </Toolbar>
      )}

      {/* Table */}
      <div className="card">
        {list.error ? (
          <LoadErrorPanel
            title={t("userManagement.loadFailed")}
            onRetry={() => void list.refetch()}
          />
        ) : !list.isLoading && filtered.length === 0 ? (
          items.length === 0 ? (
            <EmptyPanel
              tone="accent"
              icon={<Icon name="users" size={30} />}
              title={t("userManagement.emptyTitle", { defaultValue: "No users synced yet" })}
              body={t("userManagement.empty")}
              actions={
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setError(null);
                    setSyncOpen(true);
                  }}
                  disabled={sync.isPending}
                >
                  <Icon name="refresh" size={12} />
                  {t("userManagement.sync")}
                </button>
              }
            />
          ) : (
            <EmptyPanel
              icon={<Icon name={q.trim() ? "search" : "filter"} size={28} />}
              title={t("userManagement.noMatch")}
              body={t("userManagement.noMatchBody", {
                defaultValue: "Try a different name or email, or clear the filters to see everyone.",
              })}
              actions={
                <button type="button" className="btn" onClick={resetFilters}>
                  <Icon name="refresh" size={12} />
                  {t("userManagement.clearFilters", { defaultValue: "Clear filters" })}
                </button>
              }
            />
          )
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t("userManagement.colUser")}</th>
                <th>{t("userManagement.colDepartment")}</th>
                <th>{t("userManagement.colRole")}</th>
                <th>{t("userManagement.colAccess")}</th>
                <th className="pp-th-end">{t("userManagement.colLastLogin")}</th>
              </tr>
            </thead>
            <tbody>
              {list.isLoading && <SkeletonRows cols={5} />}
              {filtered.map((u) => (
                <tr
                  key={u.id}
                  className="pp-row-link"
                  onClick={() =>
                    u.employee_id != null
                      ? setSelectedEmployeeId(u.employee_id)
                      : setSelected(u.id)
                  }
                >
                  <td>
                    <div className="pp-person">
                      <Avatar name={u.full_name} />
                      <div style={{ minWidth: 0 }}>
                        <div className="pp-person-name">{u.full_name}</div>
                        <span className="pp-truncate text-xs text-dim" title={u.email} style={{ maxWidth: 320 }}>
                          {u.email}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td>
                    {u.department ? (
                      <span className="pill pill-neutral pp-nowrap">{u.department}</span>
                    ) : (
                      <span className="text-xs text-dim">—</span>
                    )}
                  </td>
                  <td>
                    <RoleBadges codes={u.role_codes} />
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <span className="pp-access-row">
                      <AccessToggle
                        checked={u.is_active}
                        onChange={() => void onToggleAccess(u)}
                        disabled={patch.isPending}
                        label={t("userManagement.colAccess")}
                      />
                      <DotPill tone={u.is_active ? "success" : "neutral"}>
                        {u.is_active ? t("userManagement.filter_enabled") : t("userManagement.filter_disabled")}
                      </DotPill>
                    </span>
                  </td>
                  <td className="pp-th-end pp-nowrap text-dim">
                    {u.last_login_at ? (
                      <RelativeTime iso={u.last_login_at} />
                    ) : (
                      <span className="text-xs text-dim">
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

function Avatar({ name }: { name: string }) {
  return (
    <span className="avatar pp-avatar" aria-hidden style={{ background: avatarColor(name) }}>
      {avatarInitials(name)}
    </span>
  );
}
