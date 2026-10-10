// /photo-approvals — Admin/HR queue for Employee self-uploaded
// reference photos. Two tabs:
//
// * Pending — tiles with Approve / Reject actions on each.
// * Approved — read-only audit view of who approved what + when.
//
// Backend:
// * GET    /api/employees/photos/pending           — list pending
// * GET    /api/employees/photos/approved          — list approved + approver
// * POST   /api/employees/photos/{id}/approve      — flip to approved
// * POST   /api/employees/photos/{id}/reject       — drop file + row

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../api/client";
import { Icon } from "../../shell/Icon";
import { toast } from "../../shell/Toaster";
import { SkeletonCards, SkeletonGrid } from "../../components/Skeleton";
import {
  EmptyPanel,
  FilterSelect,
  ResetButton,
  SearchField,
  StatGrid,
  Toolbar,
} from "../../components/ListPageUi";
import { DotPill, LoadErrorPanel, PEOPLE_ICON, StatTile } from "./peopleUi";
import { avatarBg, employeeThumbUrl, initials, rolePillClass } from "./EmployeesPage";
import { useTenantDateTime } from "../../util/datetime";
import { PhotoViewer, PhotoViewerFact } from "./PhotoViewer";

interface PendingPhoto {
  photo_id: number;
  employee_id: number;
  employee_code: string;
  employee_full_name: string;
  angle: "front" | "left" | "right" | "other";
  uploaded_by_user_id: number | null;
  uploaded_by_email: string | null;
  uploaded_at: string;
}

interface PendingListResponse {
  items: PendingPhoto[];
}

interface ApprovedPhoto extends PendingPhoto {
  approved_by_user_id: number | null;
  approved_by_email: string | null;
  approved_by_role: string | null;
  approved_at: string | null;
}

interface ApprovedListResponse {
  items: ApprovedPhoto[];
}

type Tab = "pending" | "approved";

export function PhotoApprovalsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("pending");

  const pending = useQuery({
    queryKey: ["employees", "photo-approvals", "pending"],
    queryFn: () =>
      api<PendingListResponse>("/api/employees/photos/pending"),
  });
  const approved = useQuery({
    queryKey: ["employees", "photo-approvals", "approved"],
    queryFn: () =>
      api<ApprovedListResponse>("/api/employees/photos/approved"),
    // Only fetch when the operator switches to the Approved tab —
    // pending is the hot path; the audit tab is incidental.
    enabled: tab === "approved",
  });

  const decide = useMutation({
    mutationFn: async ({ id, action }: { id: number; action: "approve" | "reject" }) => {
      await api(`/api/employees/photos/${id}/${action}`, { method: "POST" });
    },
    onSuccess: (_data, variables) => {
      // Invalidate both lists — an approved row leaves Pending and
      // joins Approved; a rejected row leaves Pending and is gone.
      qc.invalidateQueries({ queryKey: ["employees", "photo-approvals"] });
      toast.success(
        variables.action === "approve"
          ? (t("photoApprovals.approved") as string)
          : (t("photoApprovals.rejected") as string),
      );
    },
    onError: () => {
      toast.error(t("photoApprovals.actionFailed") as string);
    },
  });

  const pendingItems = pending.data?.items ?? [];
  const approvedItems = approved.data?.items ?? [];

  // Client-side search + angle filter over whichever tab is open.
  const [q, setQ] = useState("");
  const [angleF, setAngleF] = useState("");
  const filtersActive = q.trim() !== "" || angleF !== "";
  const resetFilters = () => {
    setQ("");
    setAngleF("");
  };
  const matches = (p: PendingPhoto) => {
    if (angleF && p.angle !== angleF) return false;
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return [p.employee_full_name, p.employee_code, p.uploaded_by_email ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  };
  const pendingShown = pendingItems.filter(matches);
  const approvedShown = approvedItems.filter(matches);
  const waitingPeople = new Set(pendingItems.map((p) => p.employee_id)).size;

  // Five-state rendering: stats + tabs + toolbar only once the pending
  // queue has loaded without error. An empty pending queue is a genuine
  // "all caught up" (the Approved tab can still hold history).
  const showChrome = !pending.isLoading && !pending.isError;
  // No records at all (nothing pending, nothing approved yet) → hide the
  // stat row; the tab strip stays so the Approved history is reachable.
  const showStats = showChrome && (pendingItems.length > 0 || approvedItems.length > 0);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {t("photoApprovals.title") as string}
          </h1>
          <p className="page-sub">
            {t("photoApprovals.subtitle", { count: pendingItems.length }) as string}
            {" · "}
            {t("photoApprovals.subHint", {
              defaultValue:
                "Photos employees upload themselves are only used for recognition after you approve them.",
            }) as string}
          </p>
        </div>
      </div>

      {pending.isLoading ? (
        <SkeletonCards count={3} minWidth={220} />
      ) : showStats ? (
        <StatGrid>
          <StatTile
            tone="warning"
            icon={PEOPLE_ICON.clock}
            label={t("photoApprovals.tab.pending") as string}
            value={pendingItems.length}
            sub={t("photoApprovals.stats.pendingSub", {
              defaultValue: "Waiting for your review",
            }) as string}
            active={tab === "pending"}
            onClick={() => setTab("pending")}
          />
          <StatTile
            tone="info"
            icon={PEOPLE_ICON.people}
            label={t("photoApprovals.stats.people", { defaultValue: "Employees waiting" }) as string}
            value={waitingPeople}
            sub={t("photoApprovals.stats.peopleSub", {
              defaultValue: "People with at least one pending photo",
            }) as string}
          />
          <StatTile
            tone="success"
            icon={PEOPLE_ICON.check}
            label={t("photoApprovals.tab.approved") as string}
            value={approvedItems.length}
            sub={
              approved.data
                ? (t("photoApprovals.stats.approvedSub", {
                    defaultValue: "Already in use for recognition",
                  }) as string)
                : (t("photoApprovals.stats.approvedOpen", {
                    defaultValue: "Open to load the approval history",
                  }) as string)
            }
            active={tab === "approved"}
            onClick={() => setTab("approved")}
          />
        </StatGrid>
      ) : null}

      {showChrome && (
        <>
          <div
            className="tabs"
            role="tablist"
            aria-label={t("photoApprovals.tabsLabel") as string}
            style={{ marginBottom: 12 }}
          >
            <TabButton
              active={tab === "pending"}
              count={pendingItems.length}
              onClick={() => setTab("pending")}
            >
              {t("photoApprovals.tab.pending") as string}
            </TabButton>
            <TabButton
              active={tab === "approved"}
              count={approved.data ? approvedItems.length : null}
              onClick={() => setTab("approved")}
            >
              {t("photoApprovals.tab.approved") as string}
            </TabButton>
          </div>

          <Toolbar>
            <SearchField
              value={q}
              onChange={setQ}
              placeholder={t("photoApprovals.filters.search", {
                defaultValue: "Search by employee name, ID or uploader…",
              }) as string}
              clearLabel={t("employees.filters.clearSearch", { defaultValue: "Clear search" }) as string}
            />
            <FilterSelect
              label={t("photoApprovals.filters.angle", { defaultValue: "Angle" }) as string}
              value={angleF}
              onChange={setAngleF}
              options={[
                ["", t("photoApprovals.filters.allAngles", { defaultValue: "All angles" }) as string],
                ...(["front", "left", "right", "other"] as const).map(
                  (a) => [a, t(`employees.photos.angles.${a}`) as string] as [string, string],
                ),
              ]}
            />
            <ResetButton
              active={filtersActive}
              label={t("employees.filters.reset", { defaultValue: "Reset" }) as string}
              onClick={resetFilters}
            />
          </Toolbar>
        </>
      )}

      <div className="card">
        {tab === "pending" && (
          <PendingPanel
            isLoading={pending.isLoading}
            isError={pending.isError}
            onRetry={() => void pending.refetch()}
            items={pendingShown}
            hasAny={pendingItems.length > 0}
            onClear={resetFilters}
            onDecide={(id, action, onDone) =>
              decide.mutate({ id, action }, onDone ? { onSuccess: onDone } : undefined)
            }
            decidingId={
              decide.isPending ? decide.variables?.id ?? null : null
            }
          />
        )}
        {tab === "approved" && (
          <ApprovedPanel
            isLoading={approved.isLoading}
            isError={approved.isError}
            onRetry={() => void approved.refetch()}
            items={approvedShown}
            hasAny={approvedItems.length > 0}
            onClear={resetFilters}
          />
        )}
      </div>
    </>
  );
}

function TabButton({
  active,
  count,
  onClick,
  children,
}: {
  active: boolean;
  count: number | null;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`tab${active ? " active" : ""}`}
    >
      {children}
      {count !== null && (
        <span className={`pill ${active ? "pill-accent" : "pill-neutral"}`} style={{ marginInlineStart: 6 }}>
          {count}
        </span>
      )}
    </button>
  );
}

type AnyPhoto = PendingPhoto | Partial<ApprovedPhoto>;

/** Group photos by employee, keeping first-appearance order. The flat
 *  list (group order) drives the viewer's prev/next. */
function groupByEmployee<P extends PendingPhoto>(items: P[]): { groups: { employee_id: number; items: P[] }[]; flat: P[] } {
  const map = new Map<number, P[]>();
  for (const p of items) {
    const g = map.get(p.employee_id);
    if (g) g.push(p);
    else map.set(p.employee_id, [p]);
  }
  const groups = Array.from(map, ([employee_id, list]) => ({ employee_id, items: list }));
  return { groups, flat: groups.flatMap((g) => g.items) };
}

const fullImageUrl = (p: PendingPhoto) => `/api/employees/${p.employee_id}/photos/${p.photo_id}/image`;

function PendingPanel({
  isLoading,
  isError,
  items,
  hasAny,
  onClear,
  onDecide,
  decidingId,
  onRetry,
}: {
  isLoading: boolean;
  isError: boolean;
  items: PendingPhoto[];
  hasAny: boolean;
  onClear: () => void;
  onDecide: (id: number, action: "approve" | "reject", onDone?: () => void) => void;
  decidingId: number | null;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (isLoading) {
    return (
      <SkeletonGrid count={6} minWidth={210} />
    );
  }
  if (isError) {
    return (
      <LoadErrorPanel title={t("photoApprovals.loadFailed") as string} onRetry={onRetry} />
    );
  }
  if (items.length === 0) {
    return hasAny ? (
      <NoMatch onClear={onClear} />
    ) : (
      <EmptyPanel
        tone="success"
        icon={<Icon name="check" size={30} />}
        title={t("photoApprovals.emptyState.pendingTitle", {
          defaultValue: "You're all caught up!",
        }) as string}
        body={t("photoApprovals.emptyState.pendingBody", {
          defaultValue: "No pending approvals right now.",
        }) as string}
      />
    );
  }
  return <PhotoGallery mode="pending" items={items} onDecide={onDecide} decidingId={decidingId} />;
}

function ApprovedPanel({
  isLoading,
  isError,
  items,
  hasAny,
  onClear,
  onRetry,
}: {
  isLoading: boolean;
  isError: boolean;
  items: ApprovedPhoto[];
  hasAny: boolean;
  onClear: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (isLoading) {
    return (
      <SkeletonGrid count={6} minWidth={210} />
    );
  }
  if (isError) {
    return (
      <LoadErrorPanel title={t("photoApprovals.loadFailed") as string} onRetry={onRetry} />
    );
  }
  if (items.length === 0) {
    return hasAny ? (
      <NoMatch onClear={onClear} />
    ) : (
      <EmptyPanel
        icon={<Icon name="camera" size={30} />}
        title={t("photoApprovals.emptyState.approvedTitle", {
          defaultValue: "No approvals yet",
        }) as string}
        body={t("photoApprovals.approvedEmpty") as string}
      />
    );
  }
  return <PhotoGallery mode="approved" items={items} decidingId={null} />;
}

/** Employee-grouped gallery + the shared viewer. Pending mode adds
 *  Approve / Reject to each card and to the viewer (which advances to
 *  the next photo after a successful decision). */
function PhotoGallery({
  mode,
  items,
  onDecide,
  decidingId,
}: {
  mode: "pending" | "approved";
  items: AnyPhoto[] & PendingPhoto[];
  onDecide?: (id: number, action: "approve" | "reject", onDone?: () => void) => void;
  decidingId: number | null;
}) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const { groups, flat } = useMemo(() => groupByEmployee(items), [items]);
  const [viewId, setViewId] = useState<number | null>(null);
  const viewIndex = viewId === null ? -1 : flat.findIndex((p) => p.photo_id === viewId);

  const angleLabel = (a: PendingPhoto["angle"]) => t(`employees.photos.angles.${a}`, { defaultValue: a }) as string;
  const openLabel = (p: PendingPhoto) =>
    t("photoApprovals.viewer.open", {
      defaultValue: "Open {{angle}} photo of {{name}}",
      angle: angleLabel(p.angle),
      name: p.employee_full_name,
    }) as string;

  const approvedInfo = (p: AnyPhoto) => p as Partial<ApprovedPhoto>;
  // Short card date: relative within a week, else the tenant date only.
  const shortWhen = (iso: string) =>
    Date.now() - new Date(iso).getTime() < 7 * 86_400_000 ? dt.formatRelative(iso) : dt.formatDate(iso);

  /** Short caption line + full tooltip for a card. */
  const cardMeta = (p: PendingPhoto): { text: string; title: string } => {
    const a = approvedInfo(p);
    if (mode === "approved" && a.approved_at) {
      const role = a.approved_by_role ?? (t("photoApprovals.unknownRole") as string);
      return {
        text: t("photoApprovals.card.approvedBy", {
          defaultValue: "{{role}} · {{when}}",
          role,
          when: shortWhen(a.approved_at),
        }) as string,
        title: t("photoApprovals.card.approvedTitle", {
          defaultValue: "Approved by {{who}} on {{when}}",
          who: a.approved_by_email ?? role,
          when: dt.formatDateTime(a.approved_at),
        }) as string,
      };
    }
    return {
      text: t("photoApprovals.card.uploaded", {
        defaultValue: "Uploaded {{when}}",
        when: shortWhen(p.uploaded_at),
      }) as string,
      title: t("photoApprovals.card.uploadedTitle", {
        defaultValue: "Uploaded by {{who}} on {{when}}",
        who: p.uploaded_by_email ?? "—",
        when: dt.formatDateTime(p.uploaded_at),
      }) as string,
    };
  };

  const decideButtons = (p: PendingPhoto, inViewer: boolean) => {
    if (mode !== "pending" || !onDecide) return null;
    const busy = decidingId === p.photo_id;
    const advance = () => {
      if (!inViewer) return;
      const i = flat.findIndex((x) => x.photo_id === p.photo_id);
      const next = flat[i + 1] ?? flat[i - 1] ?? null;
      setViewId(next ? next.photo_id : null);
    };
    return (
      <>
        <button
          type="button"
          className={`btn btn-sm${inViewer ? " btn-primary" : ""}`}
          onClick={() => onDecide(p.photo_id, "approve", advance)}
          disabled={busy}
        >
          <Icon name="check" size={11} /> {t("photoApprovals.approve") as string}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-danger"
          onClick={() => onDecide(p.photo_id, "reject", advance)}
          disabled={busy}
        >
          <Icon name="x" size={11} /> {t("photoApprovals.reject") as string}
        </button>
      </>
    );
  };

  const statusPill = (
    <DotPill tone={mode === "pending" ? "warning" : "success"}>
      {mode === "pending"
        ? (t("photoApprovals.pendingPill") as string)
        : (t("photoApprovals.approvedPill") as string)}
    </DotPill>
  );

  return (
    <div className="pp-pa">
      <ul className="pp-pa-grid">
        {groups.map((g) => (
          <EmployeeSlideCard
            key={g.employee_id}
            items={g.items}
            mode={mode}
            statusPill={statusPill}
            angleLabel={angleLabel}
            openLabel={openLabel}
            cardMeta={cardMeta}
            onOpen={(id) => setViewId(id)}
            decideButtons={(p) => decideButtons(p, false)}
          />
        ))}
      </ul>


      {viewIndex >= 0 && (
        <PhotoViewer
          photos={flat}
          index={viewIndex}
          onIndex={(i) => setViewId(flat[i]?.photo_id ?? null)}
          onClose={() => setViewId(null)}
          title={flat[viewIndex]!.employee_full_name}
          getKey={(p) => p.photo_id}
          getSrc={fullImageUrl}
          getThumbSrc={(p) => employeeThumbUrl(p.employee_id, p.photo_id)}
          getAlt={(p) => `${p.angle} reference for ${p.employee_full_name}`}
          getLabel={openLabel}
          getStatus={() => mode}
          renderInfo={(p) => <ViewerInfo p={p} mode={mode} angle={angleLabel(p.angle)} />}
          {...(mode === "pending" ? { actions: (p: PendingPhoto) => decideButtons(p, true) } : {})}
        />
      )}
    </div>
  );
}

/** One card per employee: a photo slider (arrows, dots, counter) over
 *  the employee's photos, then name / ID / photo count and the current
 *  photo's angle + time. Clicking the photo opens the shared viewer. */
function EmployeeSlideCard({
  items,
  mode,
  statusPill,
  angleLabel,
  openLabel,
  cardMeta,
  onOpen,
  decideButtons,
}: {
  items: PendingPhoto[];
  mode: "pending" | "approved";
  statusPill: ReactNode;
  angleLabel: (a: PendingPhoto["angle"]) => string;
  openLabel: (p: PendingPhoto) => string;
  cardMeta: (p: PendingPhoto) => { text: string; title: string };
  onOpen: (photoId: number) => void;
  decideButtons: (p: PendingPhoto) => ReactNode;
}) {
  const { t } = useTranslation();
  const [idx, setIdx] = useState(0);
  const count = items.length;
  // Keep the index valid when a photo leaves the list (approve/reject/filter).
  useEffect(() => {
    if (idx > count - 1) setIdx(Math.max(count - 1, 0));
  }, [count, idx]);
  const cur = items[Math.min(idx, count - 1)]!;
  const first = items[0]!;
  const meta = cardMeta(cur);
  const go = (d: number) => setIdx((i) => (i + d + count) % count);

  return (
    <li className={`pp-pa-card is-${mode}`}>
      <div
        className="pp-pa-slider"
        role="group"
        aria-roledescription="carousel"
        aria-label={first.employee_full_name}
        onKeyDown={(e) => {
          if (count < 2) return;
          const rtl = document.documentElement.dir === "rtl";
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault();
            go((e.key === "ArrowRight") !== rtl ? 1 : -1);
          }
        }}
      >
        <div className="pp-pa-track" style={{ ["--i" as string]: Math.min(idx, count - 1) } as React.CSSProperties}>
          {items.map((p, i) => (
            <button
              key={p.photo_id}
              type="button"
              className="pp-pa-slide"
              onClick={() => onOpen(p.photo_id)}
              aria-label={openLabel(p)}
              aria-hidden={i !== idx}
              tabIndex={i === idx ? 0 : -1}
            >
              <img src={fullImageUrl(p)} alt={`${p.angle} reference for ${p.employee_full_name}`} loading="lazy" />
            </button>
          ))}
        </div>
        <span className="pp-pa-status">{statusPill}</span>
        <span className="pp-pa-angle">{angleLabel(cur.angle)}</span>
        {count > 1 && (
          <>
            <span className="pp-pa-counter">
              {idx + 1}/{count}
            </span>
            <button
              type="button"
              className="pp-pa-arrow is-prev"
              onClick={() => go(-1)}
              aria-label={t("myProfile.viewer.prev", { defaultValue: "Previous photo" }) as string}
            >
              <Icon name="chevronLeft" size={16} />
            </button>
            <button
              type="button"
              className="pp-pa-arrow is-next"
              onClick={() => go(1)}
              aria-label={t("myProfile.viewer.next", { defaultValue: "Next photo" }) as string}
            >
              <Icon name="chevronRight" size={16} />
            </button>
            <div className="pp-pa-dots">
              {items.map((p, i) => (
                <button
                  key={p.photo_id}
                  type="button"
                  className={`pp-pa-dot${i === idx ? " is-active" : ""}`}
                  onClick={() => setIdx(i)}
                  aria-label={t("photoApprovals.slider.goTo", {
                    defaultValue: "Show photo {{n}}",
                    n: i + 1,
                  }) as string}
                  aria-current={i === idx}
                />
              ))}
            </div>
          </>
        )}
      </div>
      <div className="pp-pa-body">
        <div className="pp-pa-who">
          <span className="pp-pa-avatar" aria-hidden style={{ background: avatarBg(first.employee_full_name) }}>
            {initials(first.employee_full_name)}
          </span>
          <div className="pp-pa-who-text">
            <Link to={`/employees/${first.employee_id}`} className="pp-pa-name" title={first.employee_full_name}>
              {first.employee_full_name}
            </Link>
            <span className="pp-pa-code">
              <span className="mono">{first.employee_code}</span>
              <span aria-hidden> · </span>
              {t("photoApprovals.group.count", {
                count,
                defaultValue: count === 1 ? "1 photo" : `${count} photos`,
              }) as string}
            </span>
          </div>
        </div>
        <div className="pp-pa-meta" title={meta.title}>
          <Icon name={mode === "approved" ? "check" : "clock"} size={12} />
          <span>{meta.text}</span>
        </div>
        {mode === "pending" && <div className="pp-pa-actions">{decideButtons(cur)}</div>}
      </div>
    </li>
  );
}

function ViewerInfo({ p, mode, angle }: { p: AnyPhoto & PendingPhoto; mode: "pending" | "approved"; angle: string }) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const a = p as Partial<ApprovedPhoto>;
  const When = ({ iso }: { iso: string }): ReactNode => (
    <span className="pp-pa-when" title={dt.formatDateTime(iso)}>
      {dt.formatDateTime(iso)}
    </span>
  );
  return (
    <>
      <dl className="pp-pv-facts">
        <PhotoViewerFact label={t("photoApprovals.viewer.employee", { defaultValue: "Employee" }) as string}>
          <Link to={`/employees/${p.employee_id}`}>{p.employee_full_name}</Link>
        </PhotoViewerFact>
        <PhotoViewerFact label={t("employees.field.code", { defaultValue: "Employee ID" }) as string}>
          <span className="mono">{p.employee_code}</span>
        </PhotoViewerFact>
        <PhotoViewerFact label={t("photoApprovals.filters.angle", { defaultValue: "Angle" }) as string}>
          {angle}
        </PhotoViewerFact>
        <PhotoViewerFact label={t("employees.col.status", { defaultValue: "Status" }) as string}>
          <DotPill tone={mode === "pending" ? "warning" : "success"}>
            {mode === "pending"
              ? (t("photoApprovals.pendingPill") as string)
              : (t("photoApprovals.approvedPill") as string)}
          </DotPill>
        </PhotoViewerFact>
      </dl>
      <div className="pp-pa-trail">
        <div className="pp-pa-trail-row">
          <span className="pp-pa-trail-icon" aria-hidden>
            <Icon name="upload" size={12} />
          </span>
          <div className="pp-pa-trail-text">
            <span className="pp-pa-trail-label">{t("photoApprovals.uploadedAt", { defaultValue: "Uploaded" }) as string}</span>
            <When iso={p.uploaded_at} />
            {p.uploaded_by_email && (
              <span className="pp-pa-trail-who" title={p.uploaded_by_email}>
                {p.uploaded_by_email}
              </span>
            )}
          </div>
        </div>
        {mode === "approved" && a.approved_at && (
          <div className="pp-pa-trail-row">
            <span className="pp-pa-trail-icon is-ok" aria-hidden>
              <Icon name="check" size={12} />
            </span>
            <div className="pp-pa-trail-text">
              <span className="pp-pa-trail-label">
                {t("photoApprovals.approvedAt") as string}
                {a.approved_by_role && (
                  <span className={`pill ${rolePillClass(a.approved_by_role)} pp-pa-role`}>{a.approved_by_role}</span>
                )}
              </span>
              <When iso={a.approved_at} />
              {a.approved_by_email && (
                <span className="pp-pa-trail-who" title={a.approved_by_email}>
                  {a.approved_by_email}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
      {mode === "pending" && (
        <p className="pp-pv-help">
          {t("photoApprovals.viewer.pendingHelp", {
            defaultValue: "Approve to use this photo for face recognition. Rejecting deletes it.",
          }) as string}
        </p>
      )}
    </>
  );
}

function NoMatch({ onClear }: { onClear: () => void }) {
  const { t } = useTranslation();
  return (
    <EmptyPanel
      icon={<Icon name="search" size={28} />}
      title={t("photoApprovals.emptyState.noMatchTitle", {
        defaultValue: "No photos match your search",
      }) as string}
      body={t("photoApprovals.emptyState.noMatchBody", {
        defaultValue: "Try another name or ID, or clear the filters.",
      }) as string}
      actions={
        <button type="button" className="btn" onClick={onClear}>
          <Icon name="refresh" size={12} />
          {t("employees.emptyState.clearFilters", { defaultValue: "Clear filters" }) as string}
        </button>
      }
    />
  );
}
