// Admin Audit Log page. Read-only by design — there is no edit or
// delete affordance anywhere (the DB grant rejects UPDATE/DELETE from
// the app role anyway; this is belt-and-braces).
//
// Answers "who did what, when, to what, and was it risky?":
//   * summary tiles for the selected range (clickable filters)
//   * toolbar: search · actor · date presets · hide routine views · reset
//   * category chips with counts
//   * a day-grouped timeline where runs of identical events by the same
//     actor collapse into one row ("Viewed 9 face crops")
//   * a detail drawer with a before/after diff
//   * CSV export of the current filtered view
// Every filter lives in the URL so a view can be bookmarked or shared.

import { Fragment, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";

import { DatePicker } from "../../components/DatePicker";
import { EmptyPanel, FilterSelect, ResetButton, SearchField, StatCard, StatGrid, Toolbar } from "../../components/ListPageUi";
import { Pagination } from "../../components/Pagination";
import { SkeletonCards, SkeletonLine } from "../../components/Skeleton";
import { useConfidentialDownload } from "../../components/useConfidentialDownload";
import { Icon } from "../../shell/Icon";
import { useTenantDateTime } from "../../util/datetime";
import { addDaysIso, tenantBound, tenantDayKey, useDayGrouping } from "../camera-logs/clUi";
import { AuditDetailDrawer } from "./AuditDetailDrawer";
import { ActorCell } from "./auditUi";
import { ACTION_TEXT, CATEGORY_ORDER, actionText, categoryText, entityHref, entityText, groupText, severityText } from "./catalog";
import { downloadAuditCsv, useAuditActors, useAuditLog, useAuditSummary } from "./hooks";
import type { AuditEntry, AuditKind, AuditQuery } from "./types";

import "./audit-log.css";

const PAGE_SIZE = 100;
const GROUP_GAP_MS = 15 * 60 * 1000;

type RangePreset = "today" | "yesterday" | "7d" | "30d" | "all" | "custom";
const RANGES: RangePreset[] = ["today", "yesterday", "7d", "30d", "all", "custom"];
const KINDS: AuditKind[] = ["security", "failures", "changes", "system"];
const DEFAULT_RANGE: RangePreset = "7d";

/** A run of consecutive identical events by the same actor. */
interface Run {
  key: number;
  items: AuditEntry[];
}

function groupRuns(items: AuditEntry[], tz: string): Run[] {
  const out: Run[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    const prev = last?.items[last.items.length - 1];
    if (
      last &&
      prev &&
      prev.action === it.action &&
      prev.actor_user_id === it.actor_user_id &&
      prev.actor_label === it.actor_label &&
      Math.abs(new Date(prev.created_at).getTime() - new Date(it.created_at).getTime()) <= GROUP_GAP_MS &&
      tenantDayKey(tz, new Date(prev.created_at)) === tenantDayKey(tz, new Date(it.created_at))
    ) {
      last.items.push(it);
    } else {
      out.push({ key: it.id, items: [it] });
    }
  }
  return out;
}


const SEV_TONE: Record<string, "danger" | "warning" | "neutral"> = { high: "danger", warning: "warning", info: "neutral" };

export function AuditLogPage() {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const tz = dt.timezone;
  const [params, setParams] = useSearchParams();

  // ── URL state ────────────────────────────────────────────────────
  const qParam = params.get("q") ?? "";
  const cats = (params.get("cat") ?? "").split(",").filter((c) => (CATEGORY_ORDER as readonly string[]).includes(c));
  const actor = params.get("actor") ?? "";
  const rangeRaw = params.get("range") as RangePreset | null;
  const range: RangePreset = rangeRaw && RANGES.includes(rangeRaw) ? rangeRaw : DEFAULT_RANGE;
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const hideRoutine = params.get("routine") !== "show";
  const kindRaw = params.get("kind") as AuditKind | null;
  const kind = kindRaw && KINDS.includes(kindRaw) ? kindRaw : null;
  const page = Math.max(1, Number(params.get("page") ?? "1") || 1);

  const patch = (next: Record<string, string | null>, keepPage = false) => {
    setParams(
      (cur) => {
        const p = new URLSearchParams(cur);
        for (const [k, v] of Object.entries(next)) {
          if (v === null || v === "") p.delete(k);
          else p.set(k, v);
        }
        if (!keepPage) p.delete("page");
        return p;
      },
      { replace: true },
    );
  };

  // Debounced search box → URL.
  const [qInput, setQInput] = useState(qParam);
  useEffect(() => setQInput(qParam), [qParam]);
  useEffect(() => {
    if (qInput === qParam) return;
    const id = window.setTimeout(() => patch({ q: qInput.trim() || null }), 300);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput]);

  // ── Date range → tenant-local bounds ─────────────────────────────
  const todayKey = tenantDayKey(tz, new Date());
  const span = useMemo((): { from: string; to: string } | null => {
    switch (range) {
      case "today":
        return { from: todayKey, to: todayKey };
      case "yesterday": {
        const y = addDaysIso(todayKey, -1);
        return { from: y, to: y };
      }
      case "7d":
        return { from: addDaysIso(todayKey, -6), to: todayKey };
      case "30d":
        return { from: addDaysIso(todayKey, -29), to: todayKey };
      case "custom": {
        const f = from || addDaysIso(todayKey, -6);
        const tt = to || todayKey;
        return { from: f, to: tt < f ? f : tt };
      }
      default:
        return null;
    }
  }, [range, from, to, todayKey]);

  // Plain-language search: also match the sentence text of known actions.
  const qActions = useMemo(() => {
    const needle = qParam.trim().toLowerCase();
    if (needle.length < 2) return [];
    return Object.keys(ACTION_TEXT)
      .filter((a) => actionText(t, a).toLowerCase().includes(needle))
      .slice(0, 300);
  }, [qParam, t]);

  const query: AuditQuery = {
    q: qParam,
    q_action: qActions,
    categories: cats,
    actor,
    start: span ? tenantBound(span.from, "00:00:00", tz) : null,
    end: span ? tenantBound(span.to, "23:59:59", tz) : null,
    hide_routine: hideRoutine,
    kind,
  };

  const list = useAuditLog(query, page, PAGE_SIZE);
  const summary = useAuditSummary(query);
  const actors = useAuditActors();
  const { gate, modal } = useConfidentialDownload();
  const [exportNote, setExportNote] = useState<{ tone: "ok" | "warn" | "err"; text: string } | null>(null);

  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const runs = useMemo(() => groupRuns(items, tz), [items, tz]);
  const groupByDay = useDayGrouping();
  const days = useMemo(() => groupByDay(runs, (r) => r.items[0]!.created_at), [groupByDay, runs]);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [selected, setSelected] = useState<AuditEntry | null>(null);

  const filtersActive = !!qParam || cats.length > 0 || !!actor || range !== DEFAULT_RANGE || !hideRoutine || !!kind;
  const resetAll = () => {
    setQInput("");
    setParams(new URLSearchParams(), { replace: true });
  };

  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const firstShown = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastShown = Math.min(total, page * PAGE_SIZE);
  const isFirstLoad = list.isLoading && !list.data;
  const showEmpty = !!list.data && items.length === 0 && !list.isFetching;

  const toggleCat = (c: string) => {
    const next = cats.includes(c) ? cats.filter((x) => x !== c) : [...cats, c];
    patch({ cat: next.length ? next.join(",") : null });
  };
  const toggleKind = (k: AuditKind | null) => patch({ kind: k === null || kind === k ? null : k });

  const rangeLabel = (r: RangePreset) =>
    ({
      today: t("auditLog.range.today", { defaultValue: "Today" }),
      yesterday: t("auditLog.range.yesterday", { defaultValue: "Yesterday" }),
      "7d": t("auditLog.range.last7", { defaultValue: "7 days" }),
      "30d": t("auditLog.range.last30", { defaultValue: "30 days" }),
      all: t("auditLog.range.all", { defaultValue: "All time" }),
      custom: t("auditLog.range.custom", { defaultValue: "Custom" }),
    })[r];

  const actorOptions: Array<[string, string]> = [
    ["", t("auditLog.actor.all", { defaultValue: "Everyone" })],
    ["system", t("auditLog.actor.system", { defaultValue: "System (automated)" })],
    ...(actors.data?.items ?? []).map((a) => [String(a.id), a.full_name ? `${a.full_name} · ${a.email}` : a.email] as [string, string]),
  ];

  const runExport = () =>
    gate({
      reportName: t("auditLog.export.name", {
        range: rangeLabel(range),
        defaultValue: "Audit log — {{range}}",
      }),
      format: "csv",
      action: async () => {
        try {
          const res = await downloadAuditCsv(query);
          setExportNote(
            res.truncated
              ? { tone: "warn", text: t("auditLog.export.truncated", { n: res.rows.toLocaleString(), defaultValue: "Exported the newest {{n}} rows — narrow the filters to export the rest." }) }
              : { tone: "ok", text: t("auditLog.export.done", { n: res.rows.toLocaleString(), defaultValue: "Exported {{n}} rows to CSV." }) },
          );
        } catch {
          setExportNote({ tone: "err", text: t("auditLog.export.failed", { defaultValue: "The export failed. Try again." }) });
        }
      },
    });

  const s = summary.data;
  const sub = (n: number) => t("auditLog.tiles.ofTotal", { pct: s && s.total ? Math.round((n / s.total) * 100) : 0, defaultValue: "{{pct}}% of events" });

  const openOnKey = (ev: AuditEntry) => (e: ReactKeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setSelected(ev);
    }
  };

  const selIndex = selected ? items.findIndex((e) => e.id === selected.id) : -1;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("auditLog.title")}</h1>
          <p className="page-sub">
            {t("auditLog.subtitle", { defaultValue: "Who did what, when, and to what — every sign-in, change and export, kept append-only." })}
          </p>
        </div>
        <div className="al-head-actions">
          <button type="button" className="btn" onClick={runExport} disabled={!list.data || total === 0}>
            <Icon name="download" size={13} />
            {t("auditLog.export.button", { defaultValue: "Export CSV" })}
          </button>
        </div>
      </div>

      {exportNote && (
        <div className={`al-note is-${exportNote.tone}`} role="status">
          <Icon name={exportNote.tone === "ok" ? "check" : "info"} size={14} />
          <span>{exportNote.text}</span>
          <button type="button" className="al-note-x" onClick={() => setExportNote(null)} aria-label={t("common.close", { defaultValue: "Close" })}>
            <Icon name="x" size={12} />
          </button>
        </div>
      )}

      {/* Summary tiles */}
      {!s && summary.isLoading ? (
        <div className="al-stats-sk">
          <SkeletonCards count={4} minWidth={210} />
        </div>
      ) : s ? (
        <StatGrid>
          <StatCard
            tone="info"
            icon={<path d="M4 6h16M4 12h16M4 18h10" />}
            label={t("auditLog.tiles.total", { defaultValue: "Events" })}
            value={s.total}
            sub={
              hideRoutine && s.routine_hidden > 0
                ? t("auditLog.tiles.totalSubHidden", { range: rangeLabel(range), n: s.routine_hidden.toLocaleString(), defaultValue: "{{range}} · {{n}} routine hidden" })
                : rangeLabel(range)
            }
            active={kind === null}
            onClick={() => toggleKind(null)}
          />
          <StatCard
            tone={s.failures > 0 ? "warning" : "success"}
            icon={<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z" />}
            label={t("auditLog.tiles.security", { defaultValue: "Security events" })}
            value={s.security}
            sub={t("auditLog.tiles.failures", { n: s.failures.toLocaleString(), defaultValue: "{{n}} failed sign-ins" })}
            active={kind === "security"}
            onClick={() => toggleKind("security")}
          />
          <StatCard
            tone="neutral"
            icon={<path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" />}
            label={t("auditLog.tiles.changes", { defaultValue: "Data changes" })}
            value={s.changes}
            sub={t("auditLog.tiles.changesSub", { defaultValue: "Creates, updates and deletes" })}
            active={kind === "changes"}
            onClick={() => toggleKind("changes")}
          />
          <StatCard
            tone="neutral"
            icon={
              <>
                <rect x="4" y="4" width="16" height="16" rx="3" />
                <path d="M9 9h6v6H9z" />
              </>
            }
            label={t("auditLog.tiles.system", { defaultValue: "System / automated" })}
            value={s.system}
            sub={sub(s.system)}
            active={kind === "system"}
            onClick={() => toggleKind("system")}
          />
        </StatGrid>
      ) : null}

      <Toolbar>
        <div className="al-search-slot">
          <SearchField
            value={qInput}
            onChange={setQInput}
            placeholder={t("auditLog.searchPlaceholder", { defaultValue: "Search people, actions or records" })}
            clearLabel={t("auditLog.clearSearch", { defaultValue: "Clear search" })}
          />
        </div>
        <FilterSelect label={t("auditLog.actor.label", { defaultValue: "Actor" })} value={actor} onChange={(v) => patch({ actor: v || null })} options={actorOptions} />
        <div className="seg al-seg" role="group" aria-label={t("auditLog.range.label", { defaultValue: "Date range" })}>
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={range === r}
              className={`seg-btn${range === r ? " active" : ""}`}
              onClick={() =>
                r === "custom"
                  ? patch({ range: "custom", from: span?.from ?? addDaysIso(todayKey, -6), to: span?.to ?? todayKey })
                  : patch({ range: r === DEFAULT_RANGE ? null : r, from: null, to: null })
              }
            >
              {rangeLabel(r)}
            </button>
          ))}
        </div>
        {range === "custom" && span && (
          <div className="al-custom">
            <DatePicker
              value={span.from}
              max={span.to || todayKey}
              onChange={(v) => patch({ from: v })}
              ariaLabel={t("auditLog.fromTitle")}
              triggerStyle={{ height: "var(--control-h)" }}
            />
            <span className="al-dim" aria-hidden>
              →
            </span>
            <DatePicker
              value={span.to}
              min={span.from}
              max={todayKey}
              onChange={(v) => patch({ to: v })}
              ariaLabel={t("auditLog.toTitle")}
              triggerStyle={{ height: "var(--control-h)" }}
            />
          </div>
        )}
        <button
          type="button"
          className={`mg-control al-toggle${hideRoutine ? " is-active" : ""}`}
          aria-pressed={hideRoutine}
          onClick={() => patch({ routine: hideRoutine ? "show" : null })}
          title={t("auditLog.routine.hint", { defaultValue: "Hides high-volume views (face crops, photos, live streams) and start-up housekeeping." })}
        >
          <span className={`al-switch${hideRoutine ? " is-on" : ""}`} aria-hidden>
            <span />
          </span>
          {t("auditLog.routine.label", { defaultValue: "Hide routine views" })}
        </button>
        <ResetButton active={filtersActive} label={t("auditLog.reset", { defaultValue: "Reset" })} onClick={resetAll} />
      </Toolbar>

      {list.isError ? (
        <div className="card">
          <EmptyPanel
            tone="danger"
            icon={<Icon name="info" size={30} />}
            title={t("auditLog.loadFailedTitle", { defaultValue: "Couldn't load the audit log" })}
            body={t("auditLog.loadFailedBody", { defaultValue: "The audit log request failed. Check the API and try again." })}
            actions={
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void list.refetch();
                  void summary.refetch();
                }}
              >
                <Icon name="refresh" size={12} />
                {t("common.retry", { defaultValue: "Retry" })}
              </button>
            }
          />
        </div>
      ) : (
        <div className="card al-card">
          <div className="al-card-head">
            <div className="al-chips" role="group" aria-label={t("auditLog.cat.label", { defaultValue: "Category" })}>
              <button type="button" className={`al-chip${cats.length === 0 ? " is-on" : ""}`} aria-pressed={cats.length === 0} onClick={() => patch({ cat: null })}>
                {t("auditLog.cat.all", { defaultValue: "All categories" })}
              </button>
              {CATEGORY_ORDER.filter((c) => c !== "other" || (s?.by_category[c] ?? 0) > 0 || cats.includes(c)).map((c) => {
                const n = s?.by_category[c];
                const on = cats.includes(c);
                return (
                  <button key={c} type="button" className={`al-chip cat-${c}${on ? " is-on" : ""}`} aria-pressed={on} onClick={() => toggleCat(c)}>
                    <span className="al-chip-dot" aria-hidden />
                    {categoryText(t, c)}
                    {n !== undefined && <span className="al-chip-n">{n.toLocaleString()}</span>}
                  </button>
                );
              })}
            </div>
            <span className="al-count" aria-live="polite">
              {list.isFetching && !isFirstLoad && <span className="al-spin" aria-hidden />}
              {list.data && total > 0
                ? t("auditLog.showing", {
                    from: firstShown.toLocaleString(),
                    to: lastShown.toLocaleString(),
                    total: total.toLocaleString(),
                    defaultValue: "Showing {{from}}–{{to}} of {{total}}",
                  })
                : ""}
            </span>
          </div>

          {isFirstLoad ? (
            <div className="al-sk" role="status" aria-label={t("auditLog.loading")}>
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="al-sk-row" style={{ opacity: Math.max(0.2, 1 - i * 0.1) }}>
                  <SkeletonLine width={64} />
                  <SkeletonLine width={140} />
                  <SkeletonLine width={`${60 - (i % 3) * 10}%`} />
                  <SkeletonLine width={90} height={18} radius={999} />
                </div>
              ))}
            </div>
          ) : showEmpty ? (
            filtersActive ? (
              <EmptyPanel
                tone="neutral"
                icon={<Icon name="filter" size={30} />}
                title={t("auditLog.emptyFilteredTitle", { defaultValue: "No entries match these filters" })}
                body={t("auditLog.emptyFilteredBody", { defaultValue: "Try a wider date range, another category, or show routine views." })}
                actions={
                  <>
                    {range !== "all" && (
                      <button type="button" className="btn" onClick={() => patch({ range: "all", from: null, to: null })}>
                        {t("auditLog.showAllTime", { defaultValue: "Search all time" })}
                      </button>
                    )}
                    <button type="button" className="btn" onClick={resetAll}>
                      {t("auditLog.clearFilters", { defaultValue: "Clear filters" })}
                    </button>
                  </>
                }
              />
            ) : (
              <EmptyPanel
                tone="accent"
                icon={<Icon name="shield" size={30} />}
                title={t("auditLog.emptyRangeTitle", { defaultValue: "Nothing recorded in this period" })}
                body={t("auditLog.emptyBody", { defaultValue: "Every change made in the app is recorded here as soon as it happens." })}
              />
            )
          ) : (
            <div className={`al-list${list.isFetching ? " is-stale" : ""}`}>
              {days.map((d) => (
                <section key={d.key} className="al-day" aria-label={d.label}>
                  <h4 className="al-day-head">
                    <span className="al-day-label">{d.label}</span>
                    {d.key !== "unknown" && <span className="al-day-date">{dt.formatLocalDate(d.key)}</span>}
                  </h4>
                  <ul className="al-rows">
                    {d.items.map((run) => {
                      const head = run.items[0]!;
                      const n = run.items.length;
                      const isGroup = n > 1;
                      const open = expanded.has(run.key);
                      const toggle = () =>
                        setExpanded((cur) => {
                          const next = new Set(cur);
                          if (next.has(run.key)) next.delete(run.key);
                          else next.add(run.key);
                          return next;
                        });
                      return (
                        <Fragment key={run.key}>
                          <li>
                            <AuditRow
                              entry={head}
                              text={isGroup ? groupText(t, head.action, n) : actionText(t, head.action)}
                              timeSub={
                                isGroup && dt.formatTime(run.items[n - 1]!.created_at) !== dt.formatTime(head.created_at)
                                  ? t("auditLog.groupSince", { time: dt.formatTime(run.items[n - 1]!.created_at), defaultValue: "from {{time}}" })
                                  : null
                              }
                              entity={isGroup ? null : head}
                              onOpen={() => (isGroup ? toggle() : setSelected(head))}
                              onKey={isGroup ? undefined : openOnKey(head)}
                              groupToggle={
                                isGroup ? (
                                  <span className={`al-expand${open ? " is-open" : ""}`} aria-hidden>
                                    {n}
                                    <Icon name="chevronDown" size={11} />
                                  </span>
                                ) : null
                              }
                              expanded={isGroup ? open : undefined}
                              groupLabel={isGroup ? t("auditLog.groupToggle", { n, defaultValue: "Show {{n}} events" }) : undefined}
                            />
                          </li>
                          {isGroup && open && (
                            <li>
                              <ul className="al-children">
                                {run.items.map((child) => (
                                  <li key={child.id}>
                                    <AuditRow
                                      entry={child}
                                      text={actionText(t, child.action)}
                                      timeSub={null}
                                      entity={child}
                                      child
                                      onOpen={() => setSelected(child)}
                                      onKey={openOnKey(child)}
                                    />
                                  </li>
                                ))}
                              </ul>
                            </li>
                          )}
                        </Fragment>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}

          {!!list.data && total > 0 && (
            <div className="al-foot">
              <Pagination
                page={page}
                totalPages={totalPages}
                disabled={list.isFetching}
                onPageChange={(p) => {
                  patch({ page: p > 1 ? String(p) : null }, true);
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
                summary={t("auditLog.showing", {
                  from: firstShown.toLocaleString(),
                  to: lastShown.toLocaleString(),
                  total: total.toLocaleString(),
                  defaultValue: "Showing {{from}}–{{to}} of {{total}}",
                })}
              />
            </div>
          )}
        </div>
      )}

      <p className="al-footnote">
        <Icon name="shield" size={12} />
        {t("auditLog.appendOnly", { defaultValue: "The audit log is append-only: entries can't be edited or deleted, by anyone." })}
      </p>

      {selected && (
        <AuditDetailDrawer
          entry={selected}
          onClose={() => setSelected(null)}
          onPrev={selIndex > 0 ? () => setSelected(items[selIndex - 1]!) : null}
          onNext={selIndex >= 0 && selIndex < items.length - 1 ? () => setSelected(items[selIndex + 1]!) : null}
        />
      )}
      {modal}
    </>
  );
}

// ── Row ──────────────────────────────────────────────────────────────

function AuditRow({
  entry,
  text,
  timeSub,
  entity,
  child = false,
  onOpen,
  onKey,
  groupToggle,
  expanded,
  groupLabel,
}: {
  entry: AuditEntry;
  text: string;
  timeSub: string | null;
  entity: AuditEntry | null;
  child?: boolean;
  onOpen: () => void;
  onKey?: ((e: ReactKeyboardEvent) => void) | undefined;
  groupToggle?: React.ReactNode;
  expanded?: boolean | undefined;
  groupLabel?: string | undefined;
}) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const href = entity ? entityHref(entity) : null;
  const sevTone = SEV_TONE[entry.severity] ?? "neutral";
  return (
    <div
      className={`al-row sev-${entry.severity}${child ? " is-child" : ""}`}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-label={groupLabel}
      onClick={onOpen}
      onKeyDown={
        onKey ??
        ((e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        })
      }
    >
      <span className="al-time">
        <span className="al-time-main">{dt.formatTime(entry.created_at)}</span>
        {timeSub && <span className="al-time-sub">{timeSub}</span>}
      </span>
      <ActorCell entry={entry} />
      <span className="al-what">
        <span className="al-sentence">{text}</span>
        {entity && (
          <span className="al-entity">
            {href ? (
              <Link to={href} onClick={(e) => e.stopPropagation()} className="al-entity-link">
                {entityText(t, entity)}
              </Link>
            ) : (
              entityText(t, entity)
            )}
          </span>
        )}
      </span>
      <span className="al-pills">
        {entry.severity !== "info" && (
          <span className={`pill pill-${sevTone} al-pill`}>
            <span aria-hidden className="pill-dot" />
            {severityText(t, entry.severity)}
          </span>
        )}
        <span className={`al-cat cat-${entry.category}`}>{categoryText(t, entry.category)}</span>
      </span>
      <span className="al-end">{groupToggle ?? <Icon name="chevronRight" size={13} />}</span>
    </div>
  );
}
