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
import { Icon } from "../../shell/Icon";

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

  const onExport = () => {
    window.location.assign(
      `/api/reports/former-employees-seen?from=${fromDate}&to=${toDate}&format=xlsx`,
    );
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
          <button className="btn" onClick={onExport}>
            <Icon name="download" size={12} />
            {t("formerEmployees.exportXlsx") as string}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3 className="card-title">
            {t("formerEmployees.detections") as string}
            {data.data ? ` · ${data.data.total}` : ""}
          </h3>
          <div className="flex gap-2" style={{ alignItems: "center" }}>
            <label className="text-xs text-dim">
              {t("formerEmployees.from") as string}
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                style={selectStyle}
              />
            </label>
            <label className="text-xs text-dim">
              {t("formerEmployees.to") as string}
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                style={selectStyle}
              />
            </label>
          </div>
        </div>

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
              <tr>
                <td colSpan={7} className="text-sm text-dim" style={{ padding: 16 }}>
                  {t("common.loading") as string}
                </td>
              </tr>
            )}
            {data.isError && (
              <tr>
                <td
                  colSpan={7}
                  className="text-sm"
                  style={{ padding: 16, color: "var(--danger-text)" }}
                >
                  {t("formerEmployees.loadFailed") as string}
                </td>
              </tr>
            )}
            {data.data && data.data.items.length === 0 && (
              <tr>
                <td colSpan={7} className="text-sm text-dim" style={{ padding: 16 }}>
                  {t("formerEmployees.empty") as string}
                </td>
              </tr>
            )}
            {data.data?.items.map((row) => (
              <tr key={row.detection_event_id}>
                <td className="mono text-sm">
                  {new Date(row.captured_at).toLocaleString()}
                </td>
                <td className="text-sm">{row.camera_name ?? "—"}</td>
                <td className="mono text-sm">
                  {row.former_employee_code ?? "—"}
                </td>
                <td className="text-sm">{row.former_employee_name ?? "—"}</td>
                <td className="mono text-sm">
                  {row.confidence !== null
                    ? `${(row.confidence * 100).toFixed(0)}%`
                    : "—"}
                </td>
                <td className="text-sm text-dim">
                  {row.deactivation_reason ?? "—"}
                </td>
                <td className="text-sm text-dim">
                  {row.deactivated_at
                    ? new Date(row.deactivated_at).toLocaleDateString()
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

const selectStyle = {
  padding: "4px 8px",
  marginInlineStart: 6,
  fontSize: 12.5,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--bg-elev)",
  color: "var(--text)",
} as const;
