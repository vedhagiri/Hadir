// P29 — Resources tab "Running Processes" panel.
//
// One table: the top 20 host processes by memory. Columns PID /
// Process / User / CPU / Memory / Status. The backend's own process
// is tagged "this app" and its row is highlighted. Refreshes every
// 10 s; sorted client-side by memory so the list is stable.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { ApiError, api } from "../../api/client";

const LIMIT = 20;

interface ProcessRow {
  pid: number;
  name: string;
  cmdline_short: string;
  user: string;
  cpu_percent: number;
  memory_mb: number;
  memory_percent: number;
  swap_mb: number | null;
  threads: number;
  create_time: number;
  status: string;
  is_self: boolean;
}

interface ProcessesResponse {
  processes: ProcessRow[];
  generated_at: string;
  swap_supported: boolean;
}

function useProcesses(enabled: boolean) {
  return useQuery({
    queryKey: ["operations", "resources", "processes", LIMIT],
    queryFn: () =>
      api<ProcessesResponse>(
        `/api/operations/resources/processes?limit=${LIMIT}`,
      ),
    enabled,
    refetchInterval: false,
    refetchIntervalInBackground: false,
    retry: (failureCount, error) => {
      if (
        error instanceof ApiError &&
        (error.status === 401 || error.status === 403)
      ) {
        return false;
      }
      return failureCount < 2;
    },
  });
}

const cellStyle: React.CSSProperties = {
  textAlign: "start",
  padding: "8px 16px",
  borderBottom: "1px solid var(--border-soft, #f3f4f6)",
};
const headStyle: React.CSSProperties = {
  ...cellStyle,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--text-secondary, #6b7280)",
};

export function TopProcessesPanel({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation();
  const q = useProcesses(isAdmin);

  // Top-N by memory — the backend hands back a combined-cost sort, so
  // we re-rank by memory client-side to match the panel's contract.
  const rows = useMemo(() => {
    const data = q.data?.processes ?? [];
    return [...data].sort((a, b) => b.memory_mb - a.memory_mb).slice(0, LIMIT);
  }, [q.data?.processes]);

  const stamp = q.data?.generated_at
    ? new Date(q.data.generated_at).toLocaleTimeString()
    : "";
  const colSpan = 6;

  return (
    <div className="card" style={{ padding: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: "1px solid var(--border, #e5e7eb)",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
          {t("resources.processes.title")}{" "}
          <span className="text-dim" style={{ fontWeight: 400 }}>
            — {t("resources.processes.note")}
          </span>
        </h3>
        {stamp && (
          <span
            className="text-dim mono"
            style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}
          >
            {stamp}
          </span>
        )}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 13,
          }}
        >
          <thead>
            <tr>
              <th style={{ ...headStyle, width: 90 }}>
                {t("resources.processes.col.pid")}
              </th>
              <th style={headStyle}>{t("resources.processes.col.process")}</th>
              <th style={headStyle}>{t("resources.processes.col.user")}</th>
              <th style={{ ...headStyle, width: 80 }}>
                {t("resources.processes.col.cpu")}
              </th>
              <th style={headStyle}>{t("resources.processes.col.memory")}</th>
              <th style={{ ...headStyle, width: 110 }}>
                {t("resources.processes.col.status")}
              </th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading && (
              <tr>
                <td
                  style={{ ...cellStyle, textAlign: "center" }}
                  colSpan={colSpan}
                >
                  {t("resources.processes.loading")}
                </td>
              </tr>
            )}
            {!q.isLoading && rows.length === 0 && (
              <tr>
                <td
                  style={{ ...cellStyle, textAlign: "center" }}
                  colSpan={colSpan}
                >
                  {t("resources.processes.empty")}
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr
                key={row.pid}
                style={
                  row.is_self
                    ? { background: "var(--bg-sunken, rgba(14,165,233,0.08))" }
                    : undefined
                }
                title={row.cmdline_short || undefined}
              >
                <td
                  style={{
                    ...cellStyle,
                    fontVariantNumeric: "tabular-nums",
                    color: "var(--accent, #818cf8)",
                  }}
                  className="mono"
                >
                  {row.pid}
                </td>
                <td style={cellStyle}>
                  <span style={{ fontWeight: row.is_self ? 600 : 500 }}>
                    {row.name}
                  </span>
                  {row.is_self && (
                    <span
                      style={{
                        marginInlineStart: 8,
                        fontSize: 10,
                        fontWeight: 600,
                        padding: "1px 7px",
                        borderRadius: 10,
                        background: "var(--accent, #2563eb)",
                        color: "var(--accent-fg, #ffffff)",
                        verticalAlign: "middle",
                      }}
                    >
                      {t("resources.processes.thisApp")}
                    </span>
                  )}
                </td>
                <td style={{ ...cellStyle }} className="text-dim">
                  {row.user || "—"}
                </td>
                <td
                  style={{
                    ...cellStyle,
                    fontVariantNumeric: "tabular-nums",
                    color:
                      row.cpu_percent >= 40
                        ? "var(--danger-text, #ef4444)"
                        : row.cpu_percent >= 15
                        ? "var(--warning-text, #f59e0b)"
                        : "inherit",
                    fontWeight: row.cpu_percent >= 15 ? 600 : 400,
                  }}
                >
                  {row.cpu_percent.toFixed(0)}%
                </td>
                <td
                  style={{ ...cellStyle, fontVariantNumeric: "tabular-nums" }}
                >
                  <span style={{ fontWeight: 600 }}>
                    {row.memory_mb.toFixed(1)} MB
                  </span>{" "}
                  <span className="text-dim" style={{ fontSize: 11 }}>
                    {row.memory_percent.toFixed(1)}%
                  </span>
                </td>
                <td style={{ ...cellStyle }} className="text-dim">
                  {row.status || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
