// Full notifications history page at /notifications.

import { useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";

import {
  EmptyPanel,
  FilterSelect,
  ResetButton,
  SearchField,
  StatCard,
  StatGrid,
  Toolbar,
} from "../components/ListPageUi";
import { RelativeTime } from "../components/RelativeTime";
import { SkeletonCards, SkeletonTable } from "../components/Skeleton";
import { Icon } from "../shell/Icon";
import { SoftPill, WF_ICON, WfSvg, errorDetail } from "../requests/workflowUi";
import type { SoftTone } from "../requests/workflowUi";
import { useMarkAllRead, useMarkRead, useNotifications } from "./hooks";
import { useBellCleared } from "./bellCleared";
import { animateRowOut, animateRowsOut } from "./rowExit";
import { useMe } from "../auth/AuthProvider";
import { ALL_CATEGORIES } from "./types";
import type { NotificationCategory } from "./types";

type ReadFilter = "" | "unread" | "read";

const CATEGORY_TONE: Record<NotificationCategory, SoftTone> = {
  approval_assigned: "warning",
  approval_decided: "success",
  overtime_flagged: "info",
  camera_unreachable: "danger",
  report_ready: "accent",
  admin_override: "danger",
};

export function NotificationsPage() {
  const { t } = useTranslation();
  const list = useNotifications(100);
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();
  const navigate = useNavigate();
  // Clear hides items on this page only (nothing is deleted); "Show
  // cleared" brings them back. Clearing also marks them read.
  const me = useMe();
  const pageCleared = useBellCleared(me.data?.id, "page");
  const [showCleared, setShowCleared] = useState(false);
  const clearOneLocal = async (n: { id: number; read_at: string | null }, row?: HTMLElement | null) => {
    if (n.read_at == null) markRead.mutate(n.id);
    await animateRowOut(row ?? null);
    pageCleared.clearOne(n.id);
  };
  const clearAllLocal = async () => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".wf-notif-list > .wf-notif"));
    await animateRowsOut(rows);
    if ((list.data?.unread_count ?? 0) > 0) markAll.mutate();
    const all = list.data?.items ?? [];
    const newest = all.reduce<string | undefined>(
      (m, n) => (m == null || Date.parse(n.created_at) > Date.parse(m) ? n.created_at : m),
      undefined,
    );
    pageCleared.clearAll(newest);
    setShowCleared(false);
  };

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [readFilter, setReadFilter] = useState<ReadFilter>("");

  const allRaw = list.data?.items ?? [];
  // Hidden by "Clear" on this page unless "Show cleared" is on.
  const clearedCount = allRaw.filter((n) => pageCleared.isCleared(n)).length;
  const all = showCleared ? allRaw : allRaw.filter((n) => !pageCleared.isCleared(n));
  const unreadCount = all.filter((n) => n.read_at == null).length;

  const q = search.trim().toLowerCase();
  const items = useMemo(
    () =>
      all.filter((n) => {
        if (category && n.category !== category) return false;
        if (readFilter === "unread" && n.read_at != null) return false;
        if (readFilter === "read" && n.read_at == null) return false;
        if (!q) return true;
        return (
          n.subject.toLowerCase().includes(q) ||
          (n.body ?? "").toLowerCase().includes(q)
        );
      }),
    [all, category, readFilter, q],
  );
  const filtersActive = q !== "" || category !== "" || readFilter !== "";
  const resetFilters = () => {
    setSearch("");
    setCategory("");
    setReadFilter("");
  };

  const catLabel = (c: string) => t(`notifications.categories.${c}`, { defaultValue: c });

  return (
    <div className="wf-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("notifications.title")}</h1>
          <p className="page-sub">
            <Trans
              i18nKey="notifications.page.subtitle"
              components={{
                1: <Link to="/settings/notifications" className="wf-link-btn" />,
              }}
              values={{ settingsLink: t("notifications.page.settingsLink") }}
            />
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => markAll.mutate()}
            disabled={(list.data?.unread_count ?? 0) === 0 || markAll.isPending}
          >
            <Icon name="check" size={12} /> {t("notifications.bell.markAllRead")}
          </button>
          {clearedCount > 0 && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setShowCleared((v) => !v)}
              aria-pressed={showCleared}
            >
              <Icon name="eye" size={12} />
              {showCleared
                ? t("notifications.hideCleared", { defaultValue: "Hide cleared" })
                : t("notifications.showCleared", { defaultValue: "Show cleared ({{n}})", n: clearedCount })}
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void clearAllLocal()}
            disabled={all.length === 0}
            title={t("notifications.clearAllPageHint", { defaultValue: "Hides these notifications and marks them read. Nothing is deleted — use Show cleared to see them again." })}
          >
            <Icon name="x" size={12} /> {t("notifications.clearAll", { defaultValue: "Clear all" })}
          </button>
        </div>
      </div>

      {list.isLoading ? (
        <>
          <SkeletonCards count={3} />
          <SkeletonTable rows={6} cols={3} />
        </>
      ) : list.error ? (
        <div className="card">
          <EmptyPanel
            tone="danger"
            icon={<WfSvg>{WF_ICON.alert}</WfSvg>}
            title={t("notifications.loadError.title", { defaultValue: "Couldn't load notifications" })}
            body={errorDetail(list.error, t("common.errorGeneric"))}
            actions={
              <button type="button" className="btn" onClick={() => void list.refetch()}>
                <Icon name="refresh" size={12} /> {t("common.retry", { defaultValue: "Retry" })}
              </button>
            }
          />
        </div>
      ) : all.length === 0 ? (
        <div className="card">
          <EmptyPanel
            tone="accent"
            icon={<WfSvg>{WF_ICON.bell}</WfSvg>}
            title={t("notifications.emptyAll.title", { defaultValue: "You're all caught up" })}
            body={t("notifications.bell.empty")}
          />
        </div>
      ) : (
        <>
          <StatGrid>
            <StatCard
              tone="info"
              icon={WF_ICON.bell}
              label={t("notifications.stats.all", { defaultValue: "All notifications" })}
              value={all.length}
              sub={t("notifications.stats.allSub", { defaultValue: "Most recent 100" })}
              active={readFilter === ""}
              onClick={() => setReadFilter("")}
            />
            <StatCard
              tone="warning"
              icon={<><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" fill="currentColor" /></>}
              label={t("notifications.stats.unread", { defaultValue: "Unread" })}
              value={unreadCount}
              sub={t("notifications.stats.unreadSub", { defaultValue: "Not opened yet" })}
              active={readFilter === "unread"}
              onClick={() => setReadFilter(readFilter === "unread" ? "" : "unread")}
            />
            <StatCard
              tone="success"
              icon={WF_ICON.check}
              label={t("notifications.stats.read", { defaultValue: "Read" })}
              value={all.length - unreadCount}
              sub={t("notifications.stats.readSub", { defaultValue: "Already seen" })}
              active={readFilter === "read"}
              onClick={() => setReadFilter(readFilter === "read" ? "" : "read")}
            />
          </StatGrid>
          <Toolbar>
            <SearchField
              value={search}
              onChange={setSearch}
              placeholder={t("notifications.searchPlaceholder", { defaultValue: "Search notifications" })}
              clearLabel={t("notifications.clearSearch", { defaultValue: "Clear search" })}
            />
            <FilterSelect
              label={t("notifications.preferences.category")}
              value={category}
              onChange={setCategory}
              options={[
                ["", t("notifications.filters.allCategories", { defaultValue: "All categories" })],
                ...ALL_CATEGORIES.map((c): [string, string] => [c, catLabel(c)]),
              ]}
            />
            <ResetButton
              active={filtersActive}
              label={t("notifications.filters.reset", { defaultValue: "Reset" })}
              onClick={resetFilters}
            />
          </Toolbar>

          <div className="card">
            {items.length === 0 ? (
              <EmptyPanel
                tone="neutral"
                icon={<WfSvg>{WF_ICON.search}</WfSvg>}
                title={t("notifications.emptyFiltered.title", { defaultValue: "No notifications match" })}
                body={t("notifications.emptyFiltered.body", { defaultValue: "Try a different search or clear the filters." })}
                actions={
                  <button type="button" className="btn" onClick={resetFilters}>
                    {t("notifications.filters.clear", { defaultValue: "Clear filters" })}
                  </button>
                }
              />
            ) : (
              <ul className="wf-notif-list">
                {items.map((n) => {
                  const unread = n.read_at == null;
                  return (
                    <li
                      key={n.id}
                      className={`wf-notif${unread ? " is-unread" : ""}${n.link_url ? " is-link" : ""}`}
                      // The whole card opens the notification (and marks it
                      // read); buttons inside stop the click themselves.
                      role={n.link_url ? "link" : undefined}
                      tabIndex={n.link_url ? 0 : undefined}
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest("button, a")) return;
                        if (unread) markRead.mutate(n.id);
                        if (n.link_url) navigate(n.link_url);
                      }}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget || !n.link_url) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          if (unread) markRead.mutate(n.id);
                          navigate(n.link_url);
                        }
                      }}
                    >
                      <span className="wf-notif-dot" aria-hidden />
                      <div className="wf-notif-main">
                        <div className="wf-notif-meta">
                          <SoftPill tone={CATEGORY_TONE[n.category] ?? "neutral"} dot={false}>
                            {catLabel(n.category)}
                          </SoftPill>
                          <span className="wf-notif-time">
                            <RelativeTime iso={n.created_at} />
                          </span>
                          {unread && (
                            <span className="text-xs" style={{ color: "var(--accent-text)", fontWeight: 600 }}>
                              {t("notifications.unreadLabel", { defaultValue: "New" })}
                            </span>
                          )}
                        </div>
                        <div className="wf-notif-subject">
                          {n.subject}
                        </div>
                        {n.body && <div className="wf-notif-body">{n.body}</div>}
                      </div>
                      <div className="wf-notif-actions">
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={t("notifications.clear", { defaultValue: "Clear notification" })}
                          title={t("notifications.clear", { defaultValue: "Clear notification" })}
                          onClick={(e) => void clearOneLocal(n, (e.currentTarget as HTMLElement).closest<HTMLElement>(".wf-notif"))}
                        >
                          <Icon name="x" size={14} />
                        </button>
                        {unread && (
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => markRead.mutate(n.id)}>
                            {t("notifications.bell.markOneRead")}
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
