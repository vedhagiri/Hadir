// Admin Audit Log page (P11). Read-only by design — no edit, no delete
// buttons even on the UI side. (The DB grant rejects UPDATE/DELETE
// from the app role anyway; this is belt-and-braces.)

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "../../shell/Icon";
import { useTenantDateTime } from "../../util/datetime";
import { useAuditLog } from "./hooks";
import type { AuditFilters } from "./types";

const PAGE_SIZE = 100;

export function AuditLogPage() {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<AuditFilters>({
    actor_user_id: null,
    action: null,
    entity_type: null,
    start: null,
    end: null,
    page: 1,
    page_size: PAGE_SIZE,
  });
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const dt = useTenantDateTime();

  const audit = useAuditLog(filters);

  const totalPages = useMemo(() => {
    if (!audit.data) return 1;
    return Math.max(1, Math.ceil(audit.data.total / audit.data.page_size));
  }, [audit.data]);

  const update = (patch: Partial<AuditFilters>) =>
    setFilters((prev) => ({ ...prev, page: 1, ...patch }));

  const toggleRow = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("auditLog.title")}</h1>
          <p className="page-sub">
            {audit.data
              ? t("auditLog.sub", { total: audit.data.total })
              : t("auditLog.subEmpty")}
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3 className="card-title">{t("auditLog.cardTitle")}</h3>
          <div className="flex gap-2" style={{ alignItems: "center", flexWrap: "wrap" }}>
            <input
              type="number"
              placeholder={t("auditLog.actorPlaceholder")}
              value={filters.actor_user_id ?? ""}
              onChange={(e) =>
                update({
                  actor_user_id:
                    e.target.value === "" ? null : Number(e.target.value),
                })
              }
              style={{ ...selectStyle, width: 140 }}
            />
            <select
              value={filters.action ?? ""}
              onChange={(e) => update({ action: e.target.value || null })}
              style={selectStyle}
            >
              <option value="">{t("auditLog.allActions")}</option>
              {audit.data?.distinct_actions.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <select
              value={filters.entity_type ?? ""}
              onChange={(e) => update({ entity_type: e.target.value || null })}
              style={selectStyle}
            >
              <option value="">{t("auditLog.allEntityTypes")}</option>
              {audit.data?.distinct_entity_types.map((et) => (
                <option key={et} value={et}>
                  {et}
                </option>
              ))}
            </select>
            <input
              type="datetime-local"
              value={filters.start ?? ""}
              onChange={(e) => update({ start: e.target.value || null })}
              style={selectStyle}
              title={t("auditLog.fromTitle")}
            />
            <input
              type="datetime-local"
              value={filters.end ?? ""}
              onChange={(e) => update({ end: e.target.value || null })}
              style={selectStyle}
              title={t("auditLog.toTitle")}
            />
          </div>
        </div>

        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 38 }}></th>
              <th style={{ width: 64 }}>{t("auditLog.colId")}</th>
              <th>{t("auditLog.colTime")}</th>
              <th>{t("auditLog.colActor")}</th>
              <th>{t("auditLog.colAction")}</th>
              <th>{t("auditLog.colEntity")}</th>
            </tr>
          </thead>
          <tbody>
            {audit.isLoading && (
              <tr>
                <td colSpan={6} className="text-sm text-dim" style={{ padding: 16 }}>
                  {t("auditLog.loading")}
                </td>
              </tr>
            )}
            {audit.data?.items.map((row) => {
              const isOpen = expanded.has(row.id);
              return (
                <>
                  <tr
                    key={row.id}
                    onClick={() => toggleRow(row.id)}
                    style={{ cursor: "pointer" }}
                  >
                    <td>
                      <Icon
                        name={isOpen ? "chevronDown" : "chevronRight"}
                        size={11}
                      />
                    </td>
                    <td className="mono text-sm">{row.id}</td>
                    <td className="mono text-xs text-dim">
                      {dt.formatDateTime(row.created_at)}
                    </td>
                    <td className="text-sm">
                      {row.actor_email ? (
                        <>
                          <div>{row.actor_email}</div>
                          <div className="mono text-xs text-dim">
                            uid={row.actor_user_id}
                          </div>
                        </>
                      ) : (
                        <span className="text-dim">{t("auditLog.system")}</span>
                      )}
                    </td>
                    <td className="text-sm">
                      <span className="pill pill-neutral">{row.action}</span>
                    </td>
                    <td className="text-sm">
                      <span className="mono text-xs">
                        {row.entity_type}
                        {row.entity_id ? `:${row.entity_id}` : ""}
                      </span>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr key={`${row.id}-detail`}>
                      <td></td>
                      <td colSpan={5} style={{ background: "var(--bg-sunken)" }}>
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "1fr 1fr",
                            gap: 12,
                            padding: 12,
                          }}
                        >
                          <JsonBlock label={t("auditLog.before")} data={row.before} />
                          <JsonBlock label={t("auditLog.after")} data={row.after} />
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
            {audit.data && audit.data.items.length === 0 && !audit.isLoading && (
              <tr>
                <td colSpan={6} className="text-sm text-dim" style={{ padding: 16 }}>
                  {t("auditLog.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "10px 14px",
            borderTop: "1px solid var(--border)",
            fontSize: 12,
          }}
        >
          <span className="text-dim">
            {t("auditLog.page", { page: filters.page, total: totalPages })}
          </span>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              className="btn btn-sm"
              disabled={filters.page <= 1}
              onClick={() =>
                setFilters((prev) => ({ ...prev, page: prev.page - 1 }))
              }
            >
              <Icon name="chevronLeft" size={11} />
              {t("auditLog.prev")}
            </button>
            <button
              className="btn btn-sm"
              disabled={filters.page >= totalPages}
              onClick={() =>
                setFilters((prev) => ({ ...prev, page: prev.page + 1 }))
              }
            >
              {t("auditLog.next")}
              <Icon name="chevronRight" size={11} />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function JsonBlock({
  label,
  data,
}: {
  label: string;
  data: Record<string, unknown> | null;
}) {
  return (
    <div>
      <div
        className="text-xs text-dim"
        style={{
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          fontWeight: 500,
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <pre
        className="mono"
        style={{
          margin: 0,
          padding: "8px 10px",
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          fontSize: 11.5,
          maxHeight: 220,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {data === null ? "—" : JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}

const selectStyle = {
  padding: "6px 10px",
  fontSize: 12.5,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--bg-elev)",
  color: "var(--text)",
  fontFamily: "var(--font-sans)",
  outline: "none",
} as const;
