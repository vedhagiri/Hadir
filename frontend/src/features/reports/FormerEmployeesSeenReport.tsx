// P28.7 — "Former employees seen on premises" report.
//
// Date range picker + JSON table view + XLSX export. Backend endpoint:
// GET /api/reports/former-employees-seen?from=&to=&format=
//
// HR + Admin only. The list filters out unknown / active matches and
// joins to the snapshot of who that employee was when they matched.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";

import { api } from "../../api/client";
import { DatePicker, todayIso } from "../../components/DatePicker";
import { useConfidentialDownload } from "../../components/useConfidentialDownload";
import { Icon } from "../../shell/Icon";
import { SkeletonRows } from "../../components/Skeleton";
import { EmptyPanel, ResetButton, SearchField, Toolbar } from "../../components/ListPageUi";
import { ATT_ICON, FieldGroup, StrokeIcon, fieldDateStyle } from "../attendance/attendanceUi";
import { useTenantDateTime } from "../../util/datetime";

import "./reports.css";

interface Sighting {
  detection_event_id: number;
  captured_at: string;
  camera_id: number | null;
  camera_name: string | null;
  former_employee_id: number | null;
  former_employee_code: string | null;
  former_employee_name: string | null;
  confidence: number | null;
  deactivation_reason: string | null;
  deactivated_at: string | null;
}

interface SightingsResponse {
  items: Sighting[];
  total: number;
  from_date: string;
  to_date: string;
}

function isoToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function FormerEmployeesSeenReport() {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const [fromDate, setFromDate] = useState<string>(isoDaysAgo(7));
  const [toDate, setToDate] = useState<string>(isoToday());

  const path = useMemo(
    () =>
      `/api/reports/former-employees-seen?from=${fromDate}&to=${toDate}&format=json`,
    [fromDate, toDate],
  );

  const data = useQuery({
    queryKey: ["reports", "former-employees-seen", fromDate, toDate],
    queryFn: () => api<SightingsResponse>(path),
    staleTime: 30 * 1000,
  });

  const { gate: gateDownload, modal: confidentialModal } =
    useConfidentialDownload();

  // Client-side narrowing of the rows already loaded for the range.
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const items = data.data?.items ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((r) =>
      [r.former_employee_name, r.former_employee_code, r.camera_name]
        .some((v) => (v ?? "").toLowerCase().includes(needle)),
    );
  }, [data.data, q]);
  const defaultFrom = isoDaysAgo(7);
  const defaultTo = isoToday();
  const filtersActive = !!q || fromDate !== defaultFrom || toDate !== defaultTo;
  const resetFilters = () => {
    setQ("");
    setFromDate(defaultFrom);
    setToDate(defaultTo);
  };

  const onExport = () => {
    gateDownload({
      format: "xlsx",
      reportName: `Former employees seen — ${fromDate} → ${toDate}`,
      action: () => {
        window.location.assign(
          `/api/reports/former-employees-seen?from=${fromDate}&to=${toDate}&format=xlsx`,
        );
      },
    });
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {t("formerEmployees.title") as string}
          </h1>
          <p className="page-sub">{t("formerEmployees.subtitle") as string}</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-primary" onClick={onExport} disabled={!data.data || data.data.total === 0}>
            <Icon name="download" size={12} />
            {t("formerEmployees.exportXlsx") as string}
          </button>
        </div>
      </div>

      <Toolbar>
        <FieldGroup label={t("formerEmployees.from") as string}>
          <DatePicker
            value={fromDate}
            onChange={setFromDate}
            max={todayIso()}
            ariaLabel={t("formerEmployees.from") as string}
            triggerStyle={fieldDateStyle}
          />
        </FieldGroup>
        <FieldGroup label={t("formerEmployees.to") as string}>
          <DatePicker
            value={toDate}
            onChange={setToDate}
            min={fromDate}
            max={todayIso()}
            ariaLabel={t("formerEmployees.to") as string}
            triggerStyle={fieldDateStyle}
          />
        </FieldGroup>
        <SearchField
          value={q}
          onChange={setQ}
          placeholder={t("formerEmployees.search", { defaultValue: "Search name, code or camera…" })}
          clearLabel={t("formerEmployees.clearSearch", { defaultValue: "Clear search" })}
        />
        <ResetButton
          active={filtersActive}
          label={t("formerEmployees.reset", { defaultValue: "Reset" })}
          onClick={resetFilters}
        />
      </Toolbar>

      <div className="card">
        <div className="at-card-head">
          <div>
            <h3 className="card-title">{t("formerEmployees.detections") as string}</h3>
            <div className="card-sub">
              {data.data
                ? q
                  ? t("formerEmployees.matching", { defaultValue: "{{count}} matching", count: rows.length })
                  : t("formerEmployees.totalInRange", { defaultValue: "{{count}} sightings in range", count: data.data.total })
                : t("formerEmployees.rangeSub", { defaultValue: "{{from}} → {{to}}", from: fromDate, to: toDate })}
            </div>
          </div>
        </div>

        {data.isError ? (
          <EmptyPanel
            tone="danger"
            icon={<StrokeIcon>{ATT_ICON.alert}</StrokeIcon>}
            title={t("formerEmployees.errorTitle", { defaultValue: "Couldn't load the report" })}
            body={data.error instanceof Error ? data.error.message : (t("formerEmployees.loadFailed") as string)}
            actions={
              <button type="button" className="btn" onClick={() => void data.refetch()}>
                <Icon name="refresh" size={12} />
                {t("formerEmployees.retry", { defaultValue: "Retry" })}
              </button>
            }
          />
        ) : data.data && data.data.items.length === 0 ? (
          <EmptyPanel
            tone="success"
            icon={<StrokeIcon>{ATT_ICON.shield}</StrokeIcon>}
            title={t("formerEmployees.emptyTitle", { defaultValue: "No former employees seen" })}
            body={t("formerEmployees.empty") as string}
            actions={
              fromDate !== isoDaysAgo(30) ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setFromDate(isoDaysAgo(30));
                    setToDate(isoToday());
                  }}
                >
                  <Icon name="calendar" size={12} />
                  {t("formerEmployees.widen30", { defaultValue: "Check the last 30 days" })}
                </button>
              ) : undefined
            }
          />
        ) : data.data && rows.length === 0 ? (
          <EmptyPanel
            tone="neutral"
            icon={<Icon name="search" size={28} />}
            title={t("formerEmployees.emptySearchTitle", { defaultValue: "No sightings match \"{{q}}\"", q })}
            body={t("formerEmployees.emptySearchBody", { defaultValue: "Try a different name, code or camera." })}
            actions={
              <button type="button" className="btn" onClick={() => setQ("")}>
                <Icon name="refresh" size={12} />
                {t("formerEmployees.clearSearch", { defaultValue: "Clear search" })}
              </button>
            }
          />
        ) : (
        <div className="at-scroll-x">
        <table className="table">
          <thead>
            <tr>
              <th>{t("formerEmployees.col.captured") as string}</th>
              <th>{t("formerEmployees.col.camera") as string}</th>
              <th>{t("formerEmployees.col.code") as string}</th>
              <th>{t("formerEmployees.col.name") as string}</th>
              <th>{t("formerEmployees.col.confidence") as string}</th>
              <th>{t("formerEmployees.col.reason") as string}</th>
              <th>{t("formerEmployees.col.deactivatedAt") as string}</th>
            </tr>
          </thead>
          <tbody>
            {data.isLoading && (
              <SkeletonRows cols={7} />
            )}
            {rows.map((row) => (
              <tr key={row.detection_event_id}>
                <td className="mono text-sm at-nowrap">
                  {dt.formatDateTime(row.captured_at) || row.captured_at}
                </td>
                <td className="text-sm at-nowrap">{row.camera_name ?? "—"}</td>
                <td className="mono text-sm at-nowrap">
                  {row.former_employee_code ?? "—"}
                </td>
                <td className="text-sm at-nowrap row-person-name">{row.former_employee_name ?? "—"}</td>
                <td className="mono text-sm">
                  {row.confidence !== null
                    ? `${(row.confidence * 100).toFixed(0)}%`
                    : "—"}
                </td>
                <td className="text-sm text-dim">
                  {row.deactivation_reason ?? "—"}
                </td>
                <td className="text-sm text-dim at-nowrap">
                  {row.deactivated_at
                    ? dt.formatLocalDate(row.deactivated_at.slice(0, 10)) || row.deactivated_at
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        )}
      </div>
      {confidentialModal}
    </>
  );
}

