// Employee profile — full page at /employees/:id.
//
// Replaces the EmployeesPage view drawer (which stays in use from My
// Team). Layout: back link → profile header card → facts strip →
// URL-synced tabs (?tab=details|attendance|events|clips|team). Tab
// bodies are shared with the drawer via employeeProfileTabs.tsx; the
// Details tab gets a page-specific two-column card layout here.
//
// Cross-tenant / unknown ids: the backend returns 404 → we render an
// "Employee not found" EmptyPanel (never a blank page, never a 403
// leak).

import { useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";

import { ApiError } from "../../api/client";
import { useMe } from "../../auth/AuthProvider";
import { EmptyPanel } from "../../components/ListPageUi";
import { RelativeTime } from "../../components/RelativeTime";
import { SkeletonLine, SkeletonLines } from "../../components/Skeleton";
import { Icon } from "../../shell/Icon";
import { useTenantDateTime } from "../../util/datetime";
import { useDetectionEvents } from "../camera-logs/hooks";
import { EmployeeDrawer } from "./EmployeeDrawer";
import { avatarBg, initials } from "./EmployeesPage";
import {
  AttendanceTab,
  EventsTab,
  MatchedClipsTab,
  ReferencePhotoLightbox,
  TeamMembersTab,
  primaryRoleFromCodes,
  rolePillClass,
} from "./employeeProfileTabs";
import { useDeleteRequestList, useEmployeeDetail, useEmployeePhotos } from "./hooks";
import { DotPill, LoadErrorPanel } from "./peopleUi";
import type { Employee, Photo } from "./types";

type Tab = "details" | "attendance" | "events" | "clips" | "team";
const TABS: Tab[] = ["details", "attendance", "events", "clips", "team"];

function isTab(v: string | null): v is Tab {
  return v !== null && (TABS as string[]).includes(v);
}

/** Small stroke icons the shared Icon set doesn't carry. */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}
const PHONE_PATH = (
  <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />
);
const ORG_PATH = (
  <>
    <path d="M4 21V5l8-2v18M12 8h8v13M4 21h16" />
    <path d="M7.5 8h1M7.5 12h1M7.5 16h1M15.5 12h1M15.5 16h1" />
  </>
);

export function EmployeeProfilePage() {
  const { t } = useTranslation();
  const params = useParams();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();

  const parsed = Number.parseInt(params.id ?? "", 10);
  const employeeId = Number.isFinite(parsed) && parsed > 0 ? parsed : null;

  const me = useMe();
  const roles = me.data?.roles ?? [];
  const isAdmin = roles.includes("Admin");
  const isHr = roles.includes("HR");
  // Edit is Admin/HR-only on the backend (same gate the drawer used).
  const canEdit = isAdmin || isHr;

  const detail = useEmployeeDetail(employeeId);
  const photos = useEmployeePhotos(employeeId);
  const pendingDeletes = useDeleteRequestList({ enabled: canEdit });
  const pendingDelete = (pendingDeletes.data?.items ?? []).some(
    (r) => r.employee_id === employeeId,
  );

  const [editing, setEditing] = useState(false);

  const rawTab = searchParams.get("tab");
  const tab: Tab = isTab(rawTab) ? rawTab : "details";
  const setTab = (next: Tab) => {
    const p = new URLSearchParams(searchParams);
    if (next === "details") p.delete("tab");
    else p.set("tab", next);
    // replace: switching tabs shouldn't stack history — Back returns
    // to the list, reload keeps the tab.
    setSearchParams(p, { replace: true });
  };

  // Back target: the list URL we came from (when it carried filters in
  // its query string), else plain /employees.
  const fromState = (location.state as { from?: string } | null)?.from;
  const backTo = fromState && fromState.startsWith("/employees") ? fromState : "/employees";

  const backLink = (
    <Link to={backTo} className="pp-prof-back">
      <Icon name="chevronLeft" size={13} />
      {t("employeeProfile.back", { defaultValue: "Employees" }) as string}
    </Link>
  );

  const notFound =
    employeeId === null ||
    (detail.isError && detail.error instanceof ApiError && detail.error.status === 404);

  if (notFound) {
    return (
      <div className="pp-prof">
        {backLink}
        <div className="card pp-prof-panel">
          <EmptyPanel
            tone="neutral"
            icon={<Icon name="user" size={28} />}
            title={t("employeeProfile.notFound.title", { defaultValue: "Employee not found" }) as string}
            body={t("employeeProfile.notFound.body", {
              defaultValue: "This employee doesn't exist or isn't visible to you. They may have been deleted.",
            }) as string}
            actions={
              <Link to="/employees" className="btn">
                <Icon name="chevronLeft" size={12} />
                {t("employeeProfile.notFound.action", { defaultValue: "Back to employees" }) as string}
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  if (detail.isError) {
    return (
      <div className="pp-prof">
        {backLink}
        <div className="card pp-prof-panel">
          <LoadErrorPanel
            title={t("employeeProfile.loadFailed", { defaultValue: "Couldn't load this employee" }) as string}
            body={detail.error?.message}
            onRetry={() => void detail.refetch()}
          />
        </div>
      </div>
    );
  }

  const employee = detail.data;
  const photoItems = photos.data?.items ?? [];

  return (
    <div className="pp-prof">
      {backLink}

      {employee ? (
        <ProfileHeader
          employee={employee}
          photos={photoItems}
          pendingDelete={pendingDelete}
          actions={
            canEdit ? (
              <button type="button" className="btn btn-primary" onClick={() => setEditing(true)}>
                <Icon name="edit" size={13} />
                {t("employees.action.edit") as string}
              </button>
            ) : null
          }
        />
      ) : (
        <HeaderSkeleton />
      )}

      {employee && (
        <FactsStrip employee={employee} />
      )}

      <div className="tabs pp-prof-tabs" role="tablist" aria-label={t("employees.view.tabs") as string}>
        {TABS.map((key) => {
          const active = key === tab;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              id={`pp-prof-tab-${key}`}
              aria-selected={active}
              aria-controls="pp-prof-tabpanel"
              className={`tab${active ? " active" : ""}`}
              onClick={() => setTab(key)}
            >
              {t(`employees.view.tab.${key}`) as string}
            </button>
          );
        })}
      </div>

      <div id="pp-prof-tabpanel" role="tabpanel" aria-labelledby={`pp-prof-tab-${tab}`}>
        {tab === "details" &&
          (employee ? (
            <ProfileDetails employee={employee} photos={photoItems} photosLoading={photos.isLoading} />
          ) : (
            <div className="pp-prof-grid">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="card pp-prof-panel">
                  <SkeletonLines lines={4} />
                </div>
              ))}
            </div>
          ))}
        {tab === "attendance" && employeeId !== null && (
          <div className="card pp-prof-panel">
            <AttendanceTab employeeId={employeeId} />
          </div>
        )}
        {tab === "events" && employeeId !== null && (
          <div className="card pp-prof-panel">
            <EventsTab employeeId={employeeId} />
          </div>
        )}
        {tab === "clips" && employeeId !== null && (
          <div className="card pp-prof-panel">
            <MatchedClipsTab employeeId={employeeId} />
          </div>
        )}
        {tab === "team" && employeeId !== null && (
          <div className="card pp-prof-panel">
            <TeamMembersTab employeeId={employeeId} />
          </div>
        )}
      </div>

      {editing && employeeId !== null && (
        <EmployeeDrawer
          employeeId={employeeId}
          onClose={() => {
            setEditing(false);
            void detail.refetch();
            void photos.refetch();
          }}
          onSaved={() => {
            void detail.refetch();
            void photos.refetch();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function ProfileAvatar({ employee, photos }: { employee: Employee; photos: Photo[] }) {
  // Initials render immediately; the photo (same-origin, cookie-auth'd
  // endpoint) fades in only once it has actually loaded. On error the
  // initials simply stay.
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const photo = photos.find((p) => p.angle === "front") ?? photos[0];
  const src = photo ? `/api/employees/${employee.id}/photos/${photo.id}/image` : null;
  const showPhoto = src !== null && loadedSrc === src && failedSrc !== src;
  return (
    <span className="pp-prof-avatar pp-prof-avatar-wrap" aria-hidden>
      <span className="pp-prof-avatar-initials" style={{ background: avatarBg(employee.full_name) }}>
        {initials(employee.full_name)}
      </span>
      {src && failedSrc !== src && (
        <img
          key={src}
          className={`pp-prof-avatar-img${showPhoto ? " is-loaded" : ""}`}
          src={src}
          alt=""
          onLoad={() => setLoadedSrc(src)}
          onError={() => setFailedSrc(src)}
        />
      )}
    </span>
  );
}

function ProfileHeader({
  employee,
  photos,
  pendingDelete,
  actions,
}: {
  employee: Employee;
  photos: Photo[];
  pendingDelete: boolean;
  actions: ReactNode;
}) {
  const { t } = useTranslation();
  const role = primaryRoleFromCodes(employee.role_codes ?? []);
  const org = [employee.division?.name, employee.department.name, employee.section?.name].filter(
    (x): x is string => !!x,
  );
  return (
    <div className="card pp-prof-head">
      <ProfileAvatar employee={employee} photos={photos} />
      <div className="pp-prof-head-main">
        <div className="pp-prof-name-row">
          <h1 className="pp-prof-name">{employee.full_name}</h1>
          <div className="pp-prof-pills">
            {employee.status === "active" ? (
              <DotPill tone="success">{t("employees.statusValue.active") as string}</DotPill>
            ) : (
              <DotPill tone="neutral">
                {t(`employees.statusValue.${employee.status}`, { defaultValue: employee.status }) as string}
              </DotPill>
            )}
            {pendingDelete && (
              <span className="pill pill-danger" title={t("employees.delete.pendingTooltip") as string}>
                {t("employees.delete.pendingBadge") as string}
              </span>
            )}
            {role && (
              <span className={`pill ${rolePillClass(role)}`}>
                {t(`role.${role}`, { defaultValue: role }) as string}
              </span>
            )}
          </div>
        </div>
        <div className="pp-prof-sub">
          <span className="mono">{employee.employee_code}</span>
          {employee.designation && (
            <>
              <span aria-hidden className="pp-prof-dot">·</span>
              <span>{employee.designation}</span>
            </>
          )}
        </div>
        <div className="pp-prof-contact">
          <span className="pp-prof-contact-item">
            <Glyph>{ORG_PATH}</Glyph>
            {org.join(" / ")}
          </span>
          {employee.email && (
            <a className="pp-prof-contact-item" href={`mailto:${employee.email}`}>
              <Icon name="mail" size={14} />
              {employee.email}
            </a>
          )}
          {employee.phone && (
            <a className="pp-prof-contact-item" href={`tel:${employee.phone}`}>
              <Glyph>{PHONE_PATH}</Glyph>
              <span className="mono">{employee.phone}</span>
            </a>
          )}
        </div>
      </div>
      {actions && <div className="pp-prof-actions">{actions}</div>}
    </div>
  );
}

function HeaderSkeleton() {
  return (
    <div className="card pp-prof-head" aria-busy="true">
      <span className="sk pp-prof-avatar pp-prof-avatar-skel" aria-hidden />
      <div className="pp-prof-head-main">
        <SkeletonLine width={260} height={22} />
        <SkeletonLine width={180} height={12} />
        <SkeletonLine width={340} height={12} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Facts strip — only data the page already loads; a tile is omitted
// rather than shown with a made-up value.
// ---------------------------------------------------------------------------

function tenureParts(fromIso: string, toDate: Date): { y: number; m: number } | null {
  const [y, m, d] = fromIso.split("-").map(Number);
  if (!y || !m || !d) return null;
  let months = (toDate.getFullYear() - y) * 12 + (toDate.getMonth() + 1 - m);
  if (toDate.getDate() < d) months -= 1;
  if (months < 0) return null;
  return { y: Math.floor(months / 12), m: months % 12 };
}

function FactsStrip({ employee }: { employee: Employee }) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  // One cheap call: newest detection for this employee (page_size 1).
  const lastEvent = useDetectionEvents({
    camera_id: null,
    employee_id: employee.id,
    identified: null,
    start: null,
    end: null,
    page: 1,
    page_size: 1,
  });

  const tenure = employee.joining_date ? tenureParts(employee.joining_date, new Date()) : null;
  const tenureText = tenure
    ? tenure.y > 0
      ? (t("employeeProfile.facts.tenureYm", {
          defaultValue: "{{y}} yr {{m}} mo",
          y: tenure.y,
          m: tenure.m,
        }) as string)
      : (t("employeeProfile.facts.tenureM", { defaultValue: "{{m}} mo", m: tenure.m }) as string)
    : null;

  const last = lastEvent.data?.items[0];

  return (
    <div className="pp-prof-facts">
      {employee.joining_date && (
        <FactTile
          tone="info"
          icon={<Icon name="calendar" size={18} />}
          label={t("employeeProfile.facts.joined", { defaultValue: "Joined" }) as string}
          value={dt.formatLocalDate(employee.joining_date)}
          sub={
            tenureText
              ? (t("employeeProfile.facts.tenure", { defaultValue: "Tenure {{tenure}}", tenure: tenureText }) as string)
              : (t("employeeProfile.facts.notStarted", { defaultValue: "Not started yet" }) as string)
          }
        />
      )}
      {employee.reports_to_full_name && (
        <FactTile
          tone="neutral"
          icon={<Icon name="user" size={18} />}
          label={t("employees.field.reportsTo") as string}
          value={employee.reports_to_full_name}
          sub={t("employeeProfile.facts.manager", { defaultValue: "Line manager" }) as string}
        />
      )}
      {lastEvent.data && (
        <FactTile
          tone={last ? "accent" : "neutral"}
          icon={<Icon name="eye" size={18} />}
          label={t("employeeProfile.facts.lastSeen", { defaultValue: "Last seen" }) as string}
          value={last ? <RelativeTime iso={last.captured_at} /> : (t("employeeProfile.facts.never", { defaultValue: "Not yet" }) as string)}
          sub={
            last
              ? (t("employeeProfile.facts.lastSeenSub", {
                  defaultValue: "{{camera}} · {{count}} detections",
                  camera: last.camera_name,
                  count: lastEvent.data.total,
                }) as string)
              : (t("employeeProfile.facts.neverSub", { defaultValue: "No camera detections yet" }) as string)
          }
        />
      )}
    </div>
  );
}

function FactTile({
  tone,
  icon,
  label,
  value,
  sub,
}: {
  tone: "info" | "neutral" | "accent";
  icon: ReactNode;
  label: string;
  value: ReactNode;
  sub: string;
}) {
  return (
    <div className={`mg-stat pp-prof-fact tone-${tone}`}>
      <span className="mg-stat-top">
        <span className="mg-stat-label">{label}</span>
        <span className="mg-stat-icon" aria-hidden>
          {icon}
        </span>
      </span>
      <span className="mg-stat-value pp-prof-fact-value">{value}</span>
      <span className="mg-stat-sub">{sub}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Details tab (page layout)
// ---------------------------------------------------------------------------

function InfoCard({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="card pp-prof-panel">
      <h2 className="pp-prof-card-title">
        <span className="pp-prof-card-icon" aria-hidden>
          {icon}
        </span>
        {title}
      </h2>
      <dl className="pp-prof-dl">{children}</dl>
    </section>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="pp-prof-dl-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const Dash = () => <span className="text-dim">—</span>;

function ProfileDetails({
  employee,
  photos,
  photosLoading,
}: {
  employee: Employee;
  photos: Photo[];
  photosLoading: boolean;
}) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const [zoomPhotoId, setZoomPhotoId] = useState<number | null>(null);
  const role = primaryRoleFromCodes(employee.role_codes ?? []);

  const codeSuffix = (code: string) => <span className="mono text-xs text-dim"> ({code})</span>;

  return (
    <>
      <div className="pp-prof-grid">
        <InfoCard title={t("employees.section.identity") as string} icon={<Icon name="user" size={15} />}>
          <Item label={t("employees.field.code") as string}>
            <span className="mono">{employee.employee_code}</span>
          </Item>
          <Item label={t("employees.field.fullName") as string}>{employee.full_name}</Item>
          <Item label={t("employees.field.designation") as string}>{employee.designation || <Dash />}</Item>
          <Item label={t("employees.field.email") as string}>{employee.email || <Dash />}</Item>
          <Item label={t("employees.field.phone") as string}>
            {employee.phone ? <span className="mono">{employee.phone}</span> : <Dash />}
          </Item>
        </InfoCard>

        <InfoCard title={t("employees.section.assignment") as string} icon={<Glyph>{ORG_PATH}</Glyph>}>
          <Item label={t("employees.field.division") as string}>
            {employee.division ? (
              <>
                {employee.division.name}
                {codeSuffix(employee.division.code)}
              </>
            ) : (
              <Dash />
            )}
          </Item>
          <Item label={t("employees.field.department") as string}>
            {employee.department.name}
            {codeSuffix(employee.department.code)}
          </Item>
          <Item label={t("employees.field.section") as string}>
            {employee.section ? (
              <>
                {employee.section.name}
                {codeSuffix(employee.section.code)}
              </>
            ) : (
              <Dash />
            )}
          </Item>
          <Item label={t("employees.field.reportsTo") as string}>{employee.reports_to_full_name || <Dash />}</Item>
          <Item label={t("employees.col.role") as string}>
            {role ? (
              <span className={`pill ${rolePillClass(role)}`}>{t(`role.${role}`, { defaultValue: role }) as string}</span>
            ) : (
              <Dash />
            )}
          </Item>
        </InfoCard>

        <InfoCard title={t("employees.section.lifecycle") as string} icon={<Icon name="calendar" size={15} />}>
          <Item label={t("employees.field.joinDate") as string}>
            {employee.joining_date ? dt.formatLocalDate(employee.joining_date) : <Dash />}
          </Item>
          <Item label={t("employees.field.relievingDate") as string}>
            {employee.relieving_date ? dt.formatLocalDate(employee.relieving_date) : <Dash />}
          </Item>
        </InfoCard>

        <InfoCard title={t("employees.section.status") as string} icon={<Icon name="activity" size={15} />}>
          <Item label={t("employees.col.status") as string}>
            <span className={`pill ${employee.status === "active" ? "pill-success" : "pill-warning"}`}>
              {t(`employees.statusValue.${employee.status}`) as string}
            </span>
          </Item>
          <Item label={t("employees.field.deactivatedAt") as string}>
            {employee.deactivated_at ? dt.formatDateTime(employee.deactivated_at) : <Dash />}
          </Item>
          {employee.deactivation_reason && (
            <Item label={t("employeeProfile.deactivationReason", { defaultValue: "Deactivation reason" }) as string}>
              {employee.deactivation_reason}
            </Item>
          )}
        </InfoCard>
      </div>

      <section className="card pp-prof-panel pp-prof-photos">
        <div className="pp-prof-photos-head">
          <h2 className="pp-prof-card-title">
            <span className="pp-prof-card-icon" aria-hidden>
              <Icon name="camera" size={15} />
            </span>
            {t("employees.section.referencePhotos") as string}
          </h2>
          {!photosLoading && (
            <span className={`pill ${photos.length > 0 ? "pill-accent" : "pill-neutral"}`}>{photos.length}</span>
          )}
        </div>
        {photosLoading ? (
          <div className="pp-prof-gallery">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="sk pp-prof-photo pp-prof-photo-skel" aria-hidden />
            ))}
          </div>
        ) : photos.length === 0 ? (
          <div className="pp-prof-inline-empty">
            <Icon name="camera" size={16} />
            {t("employeeProfile.photos.empty", {
              defaultValue: "No reference photos yet — add some from Edit so this person can be recognised.",
            }) as string}
          </div>
        ) : (
          <div className="pp-prof-gallery">
            {photos.map((p) => {
              const angle = t(`employees.photos.angles.${p.angle}`, { defaultValue: p.angle }) as string;
              return (
                <button
                  key={p.id}
                  type="button"
                  className="pp-prof-photo"
                  onClick={() => setZoomPhotoId(p.id)}
                  title={angle}
                  aria-label={t("employeeProfile.photos.open", {
                    defaultValue: "Open {{angle}} photo",
                    angle,
                  }) as string}
                >
                  <img src={`/api/employees/${employee.id}/photos/${p.id}/image`} alt={p.angle} loading="lazy" />
                  <span className="pp-prof-photo-tag">{angle}</span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {zoomPhotoId !== null && (
        <ReferencePhotoLightbox
          employeeId={employee.id}
          photoId={zoomPhotoId}
          onClose={() => setZoomPhotoId(null)}
        />
      )}
    </>
  );
}
