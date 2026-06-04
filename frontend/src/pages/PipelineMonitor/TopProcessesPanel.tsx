// P29 — Resources tab "Top processes" panel.
//
// Shows which processes on the host are using CPU, memory, and swap.
// One table with a sort-by selector (CPU% / Memory MB / Swap MB). The
// backend hands back the same 15 rows regardless of sort tab — the
// frontend re-sorts client-side so flipping tabs is instant.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { ApiError, api } from "../../api/client";

const POLL_INTERVAL_MS = 10000;

type SortKey = "cpu" | "memory" | "swap";

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
}

interface ProcessesResponse {
  processes: ProcessRow[];
  generated_at: string;
  swap_supported: boolean;
}

function useProcesses(enabled: boolean) {
  return useQuery({
    queryKey: ["operations", "resources", "processes"],
    queryFn: () =>
      api<ProcessesResponse>("/api/operations/resources/processes?limit=15"),
    enabled,
    refetchInterval: POLL_INTERVAL_MS,
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

function fmtAge(createTime: number): string {
  if (createTime <= 0) return "—";
  const ageSec = Date.now() / 1000 - createTime;
  if (ageSec < 60) return `${Math.round(ageSec)}s`;
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m`;
  if (ageSec < 86400) return `${Math.round(ageSec / 3600)}h`;
  return `${Math.round(ageSec / 86400)}d`;
}

const cellStyle: React.CSSProperties = {
  textAlign: "start",
  padding: "8px 12px",
  borderBottom: "1px solid var(--border-soft, #f3f4f6)",
};
const numCellStyle: React.CSSProperties = {
  ...cellStyle,
  fontVariantNumeric: "tabular-nums",
  textAlign: "end",
};

export function TopProcessesPanel({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation();
  const [sortBy, setSortBy] = useState<SortKey>("cpu");
  const q = useProcesses(isAdmin);

  const rows = useMemo(() => {
    const data = q.data?.processes ?? [];
    const sorted = [...data].sort((a, b) => {
      if (sortBy === "cpu") return b.cpu_percent - a.cpu_percent;
      if (sortBy === "memory") return b.memory_mb - a.memory_mb;
      // swap: rows with null swap go last.
      const av = a.swap_mb ?? -1;
      const bv = b.swap_mb ?? -1;
      return bv - av;
    });
    return sorted;
  }, [q.data?.processes, sortBy]);

  const swapSupported = q.data?.swap_supported ?? false;
  const colSpan = swapSupported ? 8 : 7;
  const tabs: { key: SortKey; label: string; disabled?: boolean }[] = [
    { key: "cpu", label: t("resources.processes.tabCpu") },
    { key: "memory", label: t("resources.processes.tabMemory") },
    {
      key: "swap",
      label: t("resources.processes.tabSwap"),
      disabled: q.data ? !swapSupported : false,
    },
  ];

  return (
    <div className="card" style={{ padding: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: "1px solid var(--border, #e5e7eb)",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
            {t("resources.processes.title")}
          </h3>
          <p
            className="text-dim"
            style={{ margin: "4px 0 0", fontSize: 11 }}
          >
            {t("resources.processes.note")}
          </p>
        </div>
        <div style={{ display: "flex", gap: 4 }} role="tablist">
          {tabs.map((tab) => {
            const selected = sortBy === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={selected}
                disabled={tab.disabled}
                onClick={() => setSortBy(tab.key)}
                style={{
                  padding: "5px 12px",
                  fontSize: 12,
                  fontWeight: selected ? 600 : 500,
                  border: "1px solid var(--border, #e5e7eb)",
                  borderRadius: 6,
                  cursor: tab.disabled ? "not-allowed" : "pointer",
                  background: selected
                    ? "var(--accent, #0ea5e9)"
                    : "transparent",
                  color: selected
                    ? "var(--accent-fg, #ffffff)"
                    : "var(--text-secondary, #374151)",
                  opacity: tab.disabled ? 0.4 : 1,
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 12,
          }}
        >
          <thead>
            <tr style={{ background: "var(--bg-sunken, #f9fafb)" }}>
              <th style={cellStyle}>{t("resources.processes.col.process")}</th>
              <th style={{ ...cellStyle, textAlign: "end" }}>
                {t("resources.processes.col.pid")}
              </th>
              <th style={{ ...cellStyle, textAlign: "end" }}>
                {t("resources.processes.col.cpu")}
              </th>
              <th style={{ ...cellStyle, textAlign: "end" }}>
                {t("resources.processes.col.memMb")}
              </th>
              <th style={{ ...cellStyle, textAlign: "end" }}>
                {t("resources.processes.col.memPct")}
              </th>
              {swapSupported && (
                <th style={{ ...cellStyle, textAlign: "end" }}>
                  {t("resources.processes.col.swap")}
                </th>
              )}
              <th style={{ ...cellStyle, textAlign: "end" }}>
                {t("resources.processes.col.threads")}
              </th>
              <th style={{ ...cellStyle, textAlign: "end" }}>
                {t("resources.processes.col.age")}
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
            {rows.map((row) => {
              const isBackend = /uvicorn|maugood|python/i.test(row.name);
              return (
                <tr key={row.pid}>
                  <td style={cellStyle}>
                    <div style={{ fontWeight: isBackend ? 600 : 500 }}>
                      {row.name}
                    </div>
                    {row.cmdline_short && (
                      <div
                        className="text-dim"
                        style={{
                          fontSize: 10,
                          maxWidth: 400,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={row.cmdline_short}
                      >
                        {row.cmdline_short}
                      </div>
                    )}
                  </td>
                  <td style={numCellStyle}>{row.pid}</td>
                  <td
                    style={{
                      ...numCellStyle,
                      color:
                        row.cpu_percent >= 40
                          ? "var(--danger-text, #ef4444)"
                          : row.cpu_percent >= 15
                          ? "var(--warning-text, #f59e0b)"
                          : "inherit",
                      fontWeight: row.cpu_percent >= 15 ? 600 : 400,
                    }}
                  >
                    {row.cpu_percent.toFixed(1)}%
                  </td>
                  <td
                    style={{
                      ...numCellStyle,
                      fontWeight: row.memory_mb >= 500 ? 600 : 400,
                    }}
                  >
                    {row.memory_mb.toFixed(0)}
                  </td>
                  <td style={numCellStyle}>
                    {row.memory_percent.toFixed(1)}%
                  </td>
                  {swapSupported && (
                    <td
                      style={{
                        ...numCellStyle,
                        color:
                          (row.swap_mb ?? 0) > 0
                            ? "var(--warning-text, #f59e0b)"
                            : "inherit",
                        fontWeight: (row.swap_mb ?? 0) > 0 ? 600 : 400,
                      }}
                    >
                      {row.swap_mb === null
                        ? "—"
                        : row.swap_mb === 0
                        ? "0"
                        : row.swap_mb.toFixed(1)}
                    </td>
                  )}
                  <td style={numCellStyle}>{row.threads}</td>
                  <td style={numCellStyle}>{fmtAge(row.create_time)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
