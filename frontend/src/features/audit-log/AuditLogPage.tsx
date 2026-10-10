// Admin Audit Log page (P11). Read-only by design — no edit, no delete
// buttons even on the UI side. (The DB grant rejects UPDATE/DELETE
// from the app role anyway; this is belt-and-braces.)

import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "../../shell/Icon";
import { useTenantDateTime } from "../../util/datetime";
import { useAuditLog } from "./hooks";
import type { AuditFilters } from "./types";
import { SkeletonRows } from "../../components/Skeleton";
import { EmptyPanel, FilterSelect, ResetButton, SearchField, Toolbar } from "../../components/ListPageUi";
import { SoftPill, type PillTone } from "../system/opsUi";

const PAGE_SIZE = 100;

const EMPTY_FILTERS: Partial<AuditFilters> = { actor_user_id: null, action: null, entity_type: null, start: null, end: null };

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
  const filtersActive =
    filters.actor_user_id !== null ||
    !!filters.action ||
    !!filters.entity_type ||
    !!filters.start ||
    !!filters.end;

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

  const isEmpty = !!audit.data && audit.data.items.length === 0 && !audit.isLoading;
  const noRecordsAtAll = isEmpty && !filtersActive;

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

      {audit.isError && (
        <div className="card">
          <EmptyPanel
            tone="danger"
            icon={<Icon name="info" size={30} />}
            title={t("auditLog.loadFailedTitle", { defaultValue: "Couldn't load the audit log" })}
            body={t("auditLog.loadFailedBody", { defaultValue: "The audit log request failed. Check the API and try again." })}
            actions={
              <button type="button" className="btn" onClick={() => void audit.refetch()}>
                <Icon name="refresh" size={12} />
                {t("common.retry", { defaultValue: "Retry" })}
              </button>
            }
          />
        </div>
      )}

      {!audit.isError && noRecordsAtAll && (
        <div className="card">
          <EmptyPanel
            tone="accent"
            icon={<Icon name="shield" size={30} />}
            title={t("auditLog.emptyTitle", { defaultValue: "No audit entries yet" })}
            body={t("auditLog.emptyBody", {
              defaultValue: "Every change made in the app is recorded here as soon as it happens.",
            })}
          />
        </div>
      )}

      {!audit.isError && !noRecordsAtAll && (
        <>
          <Toolbar>
            <div className="ops-search-slot">
            <SearchField
              value={filters.actor_user_id === null ? "" : String(filters.actor_user_id)}
              onChange={(v) => {
                const digits = v.replace(/[^0-9]/g, "");
                update({ actor_user_id: digits === "" ? null : Number(digits) });
              }}
              placeholder={t("auditLog.actorPlaceholder")}
              clearLabel={t("auditLog.clearActor", { defaultValue: "Clear actor" })}
            />
            </div>
            <FilterSelect
              label={t("auditLog.colAction")}
              value={filters.action ?? ""}
              onChange={(v) => update({ action: v || null })}
              options={[
                ["", t("auditLog.allActions")],
                ...(audit.data?.distinct_actions ?? []).map((a) => [a, a] as [string, string]),
              ]}
            />
            <FilterSelect
              label={t("auditLog.colEntity")}
              value={filters.entity_type ?? ""}
              onChange={(v) => update({ entity_type: v || null })}
              options={[
                ["", t("auditLog.allEntityTypes")],
                ...(audit.data?.distinct_entity_types ?? []).map((et) => [et, et] as [string, string]),
              ]}
            />
            <DateField label={t("auditLog.fromTitle")} value={filters.start} onChange={(v) => update({ start: v })} />
            <DateField label={t("auditLog.toTitle")} value={filters.end} onChange={(v) => update({ end: v })} />
            <ResetButton
              active={filtersActive}
              label={t("auditLog.reset", { defaultValue: "Reset" })}
              onClick={() => update(EMPTY_FILTERS)}
            />
          </Toolbar>

          <div className="card ops-card-flush">
            {isEmpty ? (
              <EmptyPanel
                tone="neutral"
                icon={<Icon name="filter" size={30} />}
                title={t("auditLog.emptyFilteredTitle", { defaultValue: "No entries match these filters" })}
                body={t("auditLog.empty")}
                actions={
                  <button type="button" className="btn" onClick={() => update(EMPTY_FILTERS)}>
                    {t("auditLog.clearFilters", { defaultValue: "Clear filters" })}
                  </button>
                }
              />
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 38 }} aria-label={t("auditLog.colDetails", { defaultValue: "Details" })}></th>
                      <th style={{ width: 64 }}>{t("auditLog.colId")}</th>
                      <th>{t("auditLog.colTime")}</th>
                      <th>{t("auditLog.colActor")}</th>
                      <th>{t("auditLog.colAction")}</th>
                      <th>{t("auditLog.colEntity")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.isLoading && <SkeletonRows cols={6} rows={8} />}
                    {audit.data?.items.map((row) => {
                      const isOpen = expanded.has(row.id);
                      return (
                        <Fragment key={row.id}>
                          <tr aria-expanded={isOpen} onClick={() => toggleRow(row.id)} className="ops-row-click">
                            <td>
                              <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={11} />
                            </td>
                            <td className="mono text-sm" style={{ whiteSpace: "nowrap" }}>{row.id}</td>
                            <td className="mono text-xs text-dim" style={{ whiteSpace: "nowrap" }}>
                              {dt.formatDateTime(row.created_at)}
                            </td>
                            <td className="text-sm">
                              {row.actor_email ? (
                                <>
                                  <div>{row.actor_email}</div>
                                  <div className="mono text-xs text-dim">uid={row.actor_user_id}</div>
                                </>
                              ) : (
                                <span className="text-dim">{t("auditLog.system")}</span>
                              )}
                            </td>
                            <td className="text-sm">
                              <ActionPill action={row.action} />
                            </td>
                            <td className="text-sm">
                              <span className="mono text-xs" style={{ whiteSpace: "nowrap" }}>
                                {row.entity_type}
                                {row.entity_id ? `:${row.entity_id}` : ""}
                              </span>
                            </td>
                          </tr>
                          {isOpen && (
                            <tr className="ops-expand-row">
                              <td></td>
                              <td colSpan={5}>
                                <div className="ops-json-grid">
                                  <JsonBlock label={t("auditLog.before")} data={row.before} />
                                  <JsonBlock label={t("auditLog.after")} data={row.after} />
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {!isEmpty && (
              <div className="ops-pager">
                <span>{t("auditLog.page", { page: filters.page, total: totalPages })}</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={filters.page <= 1}
                    onClick={() => setFilters((prev) => ({ ...prev, page: prev.page - 1 }))}
                  >
                    <Icon name="chevronLeft" size={11} />
                    {t("auditLog.prev")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={filters.page >= totalPages}
                    onClick={() => setFilters((prev) => ({ ...prev, page: prev.page + 1 }))}
                  >
                    {t("auditLog.next")}
                    <Icon name="chevronRight" size={11} />
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}

function JsonBlock({ label, data }: { label: string; data: Record<string, unknown> | null }) {
  return (
    <div>
      <div className="ops-section-label">{label}</div>
      <pre className="ops-json">{data === null ? "—" : JSON.stringify(data, null, 2)}</pre>
    </div>
  );
}

/** Labelled datetime-local input sized to match the toolbar fields. */
function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <label className={`ops-date${value ? " is-active" : ""}`}>
      <span className="ops-date-label">{label}:</span>
      <input
        type="datetime-local"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        aria-label={label}
        title={label}
      />
    </label>
  );
}

/** Pill for an audit action, tinted by the verb at the end of the
 *  dotted name (created / updated / deleted / failure …). */
function ActionPill({ action }: { action: string }) {
  const verb = action.split(".").pop() ?? "";
  const tone: PillTone = /delet|reject|fail|denied|rate_limited|expired|suspend/.test(verb)
    ? "danger"
    : /creat|approv|success|ingest|enabled|start/.test(verb)
      ? "success"
      : /updat|set|rotat|switch|overrid|restart/.test(verb)
        ? "info"
        : "neutral";
  return (
    <SoftPill tone={tone} mono>
      {action}
    </SoftPill>
  );
}
