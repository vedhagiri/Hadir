// Manager dashboard — scoped to the manager's own department(s).
// Backend already enforces the scope: GET /api/attendance returns rows
// only for departments the user is a member of (P3's
// require_department + P10 router). Frontend never widens.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { useMe } from "../../auth/AuthProvider";
import { useAttendance } from "../attendance/hooks";
import type { AttendanceItem } from "../attendance/types";
import { StatusBreakdown } from "./StatusBreakdown";
import { FlagPills } from "../attendance/DailyAttendancePage";
import { SkeletonCards, SkeletonRows } from "../../components/Skeleton";
import { Panel, PanelEmpty, PanelError, Tile, TileGrid, clockTime, firstName, nowrap } from "./DashUi";

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type Filter = "" | "onTime" | "late" | "absent" | "overtime";

const MATCH: Record<Exclude<Filter, "">, (it: AttendanceItem) => boolean> = {
  onTime: (it) => !it.absent && !it.late && !it.early_out && !it.short_hours,
  late: (it) => it.late && !it.absent,
  absent: (it) => it.absent,
  overtime: (it) => it.overtime_minutes > 0,
};

export function ManagerDashboard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const me = useMe();
  // Backend auto-scopes: passing no department_id makes the union of
  // the manager's assigned departments. Trying to widen to a
  // department they don't belong to returns 403.
  const today = useAttendance(todayIso(), null);
  const [filter, setFilter] = useState<Filter>("");

  const summary = useMemo(() => {
    const items = today.data?.items ?? [];
    return {
      total: items.length,
      onTime: items.filter(MATCH.onTime).length,
      late: items.filter(MATCH.late).length,
      absent: items.filter(MATCH.absent).length,
      overtime: items.filter(MATCH.overtime).length,
    };
  }, [today.data]);

  const rows = useMemo(() => {
    const items = today.data?.items ?? [];
    return filter ? items.filter(MATCH[filter]) : items;
  }, [today.data, filter]);

  const noDepartments =
    me.data !== null && me.data !== undefined && me.data.departments.length === 0;

  const toggle = (f: Filter) => setFilter((cur) => (cur === f ? "" : f));
  const sliceLabels: Record<Exclude<Filter, "">, string> = {
    onTime: t("dashboard.manager.stats.onTime"),
    late: t("dashboard.manager.stats.late"),
    absent: t("dashboard.manager.stats.absent"),
    overtime: t("dashboard.manager.stats.overtime"),
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {me.data
              ? t("dashboard.manager.greeting", { name: firstName(me.data.full_name) })
              : t("dashboard.manager.title")}
          </h1>
          <p className="page-sub">
            {t("dashboard.manager.subtitle")}
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => navigate("/team-attendance")}>
            {t("dashboard.manager.openTeamAttendance", { defaultValue: "Team attendance" })}
          </button>
        </div>
      </div>

      {noDepartments && (
        <div className="card dsh-notice" role="status">
          {t("dashboard.manager.noDepartments")}
        </div>
      )}

      {today.isLoading ? (
        <div style={{ marginBottom: 20 }}>
          <SkeletonCards count={4} />
        </div>
      ) : (
        <TileGrid>
          <Tile
            tone="info"
            icon="users"
            label={t("dashboard.manager.stats.records")}
            value={summary.total}
            sub={t("dashboard.manager.stats.showAll", { defaultValue: "Show everyone" })}
            onClick={() => setFilter("")}
            active={filter === ""}
          />
          <Tile
            tone="success"
            icon="check"
            label={t("dashboard.manager.stats.onTime")}
            value={summary.onTime}
            sub={t("dashboard.manager.stats.ofTeam", { defaultValue: "of {{total}} today", total: summary.total })}
            onClick={() => toggle("onTime")}
            active={filter === "onTime"}
          />
          <Tile
            tone="warning"
            icon="clock"
            label={t("dashboard.manager.stats.late")}
            value={summary.late}
            sub={t("dashboard.manager.stats.ofTeam", { defaultValue: "of {{total}} today", total: summary.total })}
            onClick={() => toggle("late")}
            active={filter === "late"}
          />
          <Tile
            tone="danger"
            icon="user"
            label={t("dashboard.manager.stats.absent")}
            value={summary.absent}
            sub={t("dashboard.manager.stats.ofTeam", { defaultValue: "of {{total}} today", total: summary.total })}
            onClick={() => toggle("absent")}
            active={filter === "absent"}
          />
        </TileGrid>
      )}

      <div className="dsh-row-2 dsh-row-rev">
        <StatusBreakdown
          title={t("dashboard.manager.breakdownTitle")}
          caption={today.data?.date ?? ""}
          selected={filter ? sliceLabels[filter] : null}
          onSelect={(label) => {
            const hit = (Object.keys(sliceLabels) as Array<Exclude<Filter, "">>).find(
              (k) => sliceLabels[k] === label,
            );
            if (hit) toggle(hit);
          }}
          slices={[
            { label: sliceLabels.onTime, value: summary.onTime, tone: "success" },
            { label: sliceLabels.late, value: summary.late, tone: "warning" },
            { label: sliceLabels.absent, value: summary.absent, tone: "danger" },
            { label: sliceLabels.overtime, value: summary.overtime, tone: "accent" },
          ]}
        />

        <Panel
          title={t("dashboard.manager.rosterTitle")}
          sub={
            today.data
              ? filter
                ? t("dashboard.manager.filteredCount", {
                    defaultValue: "{{shown}} of {{total}} · {{filter}}",
                    shown: rows.length,
                    total: today.data.items.length,
                    filter: sliceLabels[filter],
                  })
                : t("dashboard.manager.recordCount", { count: today.data.items.length })
              : ""
          }
          bodyPadding={0}
          actions={
            filter ? (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFilter("")}>
                {t("dashboard.manager.clearFilter", { defaultValue: "Clear filter" })}
              </button>
            ) : undefined
          }
        >
          {today.isError ? (
            <PanelError
              title={t("dashboard.manager.loadFailed", { defaultValue: "Couldn't load today's attendance" })}
              body={t("dashboard.common.loadFailedBody", { defaultValue: "The API did not respond. Try again in a moment." })}
              retryLabel={t("dashboard.common.retry", { defaultValue: "Retry" })}
              onRetry={() => void today.refetch()}
            />
          ) : today.data && rows.length === 0 ? (
            filter ? (
              <PanelEmpty
                icon="filter"
                title={t("dashboard.manager.noMatchTitle", { defaultValue: "Nobody in this group" })}
                body={t("dashboard.manager.noMatchBody", {
                  defaultValue: "No team member is marked “{{filter}}” today.",
                  filter: sliceLabels[filter],
                })}
                action={
                  <button type="button" className="btn btn-sm" onClick={() => setFilter("")}>
                    {t("dashboard.manager.clearFilter", { defaultValue: "Clear filter" })}
                  </button>
                }
              />
            ) : (
              <PanelEmpty
                tone="accent"
                icon="users"
                title={t("dashboard.manager.emptyTitle", { defaultValue: "No records yet today" })}
                body={t("dashboard.manager.empty")}
              />
            )
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t("dashboard.manager.cols.employee")}</th>
                  <th>{t("dashboard.manager.cols.in")}</th>
                  <th>{t("dashboard.manager.cols.out")}</th>
                  <th>{t("dashboard.manager.cols.flags")}</th>
                </tr>
              </thead>
              <tbody>
                {today.isLoading && <SkeletonRows cols={4} rows={5} />}
                {rows.map((it) => (
                  <tr key={`${it.employee_id}-${it.date}`}>
                    <td>
                      <div className="dsh-person-name">{it.full_name}</div>
                      <div className="mono text-xs text-dim" style={nowrap}>
                        {it.employee_code}
                      </div>
                    </td>
                    <td className="mono text-sm" style={nowrap}>{clockTime(it.in_time)}</td>
                    <td className="mono text-sm" style={nowrap}>{clockTime(it.out_time)}</td>
                    <td>
                      <FlagPills item={it} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </>
  );
}
