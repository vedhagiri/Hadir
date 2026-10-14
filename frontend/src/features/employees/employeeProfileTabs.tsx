// Shared tab bodies for the employee profile — used by both the
// full-page profile (/employees/:id, EmployeeProfilePage) and the
// read-only EmployeeViewDrawer (still opened from My Team). One copy of
// the logic; each host supplies its own chrome.

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, api } from "../../api/client";
import { AnomalyInfoBanner } from "../../components/AnomalyNote";
import { DatePicker, todayIso } from "../../components/DatePicker";
import { useTenantDateTime } from "../../util/datetime";
import { Icon } from "../../shell/Icon";
import { LoadErrorPanel } from "./peopleUi";
import { EmptyPanel, SearchField } from "../../components/ListPageUi";
import { EmployeeEventsTab } from "./EmployeeEventsTab";
import { EmployeeAttendanceTab } from "./EmployeeAttendanceTab";
import { ClipDetailDrawer } from "../person-clips/PersonClipsPage";
import type {
  PersonClipListResponse,
  PersonClipOut,
} from "../person-clips/types";
import { useEmployeeTeamMembers } from "./hooks";
import type { Employee, Photo } from "./types";
import { SkeletonLines, SkeletonGrid } from "../../components/Skeleton";

// ---------------------------------------------------------------------------
// Team Members tab
// ---------------------------------------------------------------------------

export function TeamMembersTab({ employeeId }: { employeeId: number }) {
  const { t } = useTranslation();
  const team = useEmployeeTeamMembers(employeeId);
  const [searchQuery, setSearchQuery] = useState("");

  if (team.isLoading) {
    return (
      <SkeletonLines lines={5} />
    );
  }
  if (team.isError || !team.data) {
    return (
      <LoadErrorPanel
        title={t("employees.team.loadFailed", {
          defaultValue: "Could not load team members.",
        }) as string}
        onRetry={() => void team.refetch()}
      />
    );
  }

  const { items } = team.data;

  const needle = searchQuery.trim().toLowerCase();
  const filteredItems = needle
    ? items.filter(
        (m) =>
          m.employee_code.toLowerCase().includes(needle) ||
          m.full_name.toLowerCase().includes(needle) ||
          (m.designation ?? "").toLowerCase().includes(needle) ||
          (m.department_name ?? "").toLowerCase().includes(needle),
      )
    : items;

  const showFiltered = needle.length > 0;

  return (
    <div className="pp-stack" style={{ gap: 12 }}>
      {/* Count bar */}
      <div className="pp-panel pp-panel-row" style={{ marginBottom: 0, justifyContent: "space-between" }}>
        <span style={{ fontWeight: 600, fontSize: 12.5 }}>
          {t("employees.team.directReportsLabel", {
            defaultValue: "Direct reports",
          }) as string}
        </span>
        <span className="pp-count">
          {showFiltered ? (
            <>
              {filteredItems.length}
              <span style={{ opacity: 0.6 }}>/{items.length}</span>
            </>
          ) : (
            items.length
          )}{" "}
          {t("employees.team.members", {
            count: items.length,
            defaultValue: items.length === 1 ? "member" : "members",
          }) as string}
        </span>
      </div>

      {/* Search bar — hidden when there is nothing to search */}
      {items.length > 0 && (
      <SearchField
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder={
          t("employees.team.searchPlaceholder", {
            defaultValue: "Search by ID, name, designation or department…",
          }) as string
        }
        clearLabel={t("common.clear", { defaultValue: "Clear" }) as string}
      />
      )}

      {/* Table or empty states */}
      {items.length === 0 ? (
        <EmptyPanel
          icon={<Icon name="users" size={28} />}
          title={t("employees.team.empty", {
            defaultValue: "No employees report to this person.",
          }) as string}
          body={t("employees.team.emptyBody", {
            defaultValue: "Set this person as “Reports to” on an employee to build their team.",
          }) as string}
        />
      ) : filteredItems.length === 0 ? (
        <EmptyPanel
          icon={<Icon name="search" size={28} />}
          title={t("employees.team.noResults", {
            defaultValue: "No members match your search.",
          }) as string}
          body={t("employees.emptyState.filtersBody", {
            defaultValue: "Try a different name, ID or email, or clear the filters to see everyone.",
          }) as string}
          actions={
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setSearchQuery("")}
            >
              {t("common.clearSearch", { defaultValue: "Clear search" }) as string}
            </button>
          }
        />
      ) : (
        <div className="card" style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>
                  {t("employees.field.code", {
                    defaultValue: "Employee ID",
                  }) as string}
                </th>
                <th>
                  {t("employees.field.fullName", {
                    defaultValue: "Name",
                  }) as string}
                </th>
                <th>
                  {t("employees.field.designation", {
                    defaultValue: "Designation",
                  }) as string}
                </th>
                <th>
                  {t("employees.team.col.department", {
                    defaultValue: "Department",
                  }) as string}
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map((m) => (
                <tr key={m.id}>
                  <td className="mono text-sm">{m.employee_code}</td>
                  <td className="text-sm" style={{ fontWeight: 500 }}>
                    {m.full_name}
                  </td>
                  <td className="text-sm">{m.designation ?? "—"}</td>
                  <td className="text-sm text-dim">
                    {m.department_name ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function DetailsTab({
  employee,
  photos,
}: {
  employee: Employee;
  photos: Photo[];
}) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const [zoomPhotoId, setZoomPhotoId] = useState<number | null>(null);
  const role = primaryRoleFromCodes(employee.role_codes ?? []);

  return (
    <div>
      <Section label={t("employees.section.identity") as string}>
        <Row label={t("employees.field.code") as string}>
          <span className="mono">{employee.employee_code}</span>
        </Row>
        <Row label={t("employees.field.fullName") as string}>
          {employee.full_name}
        </Row>
        <Row label={t("employees.field.designation") as string}>
          {employee.designation ?? "—"}
        </Row>
        <Row label={t("employees.field.email") as string}>
          {employee.email ?? "—"}
        </Row>
        <Row label={t("employees.field.phone") as string}>
          {employee.phone ?? "—"}
        </Row>
      </Section>

      <Section label={t("employees.section.assignment") as string}>
        <Row label={t("employees.field.division") as string}>
          {employee.division ? (
            <>
              {employee.division.name}{" "}
              <span className="mono text-xs text-dim">
                ({employee.division.code})
              </span>
            </>
          ) : (
            <span className="text-xs text-dim">—</span>
          )}
        </Row>
        <Row label={t("employees.field.department") as string}>
          {employee.department.name}{" "}
          <span className="mono text-xs text-dim">
            ({employee.department.code})
          </span>
        </Row>
        <Row label={t("employees.field.section") as string}>
          {employee.section ? (
            <>
              {employee.section.name}{" "}
              <span className="mono text-xs text-dim">
                ({employee.section.code})
              </span>
            </>
          ) : (
            <span className="text-xs text-dim">—</span>
          )}
        </Row>
        <Row label={t("employees.field.reportsTo") as string}>
          {employee.reports_to_full_name ?? "—"}
        </Row>
        <Row label={t("employees.col.role") as string}>
          {role ? (
            <span className={`pill ${rolePillClass(role)}`}>
              {t(`role.${role}`, { defaultValue: role }) as string}
            </span>
          ) : (
            <span className="text-xs text-dim">—</span>
          )}
        </Row>
      </Section>

      <Section label={t("employees.section.lifecycle") as string}>
        <Row label={t("employees.field.joinDate") as string}>
          {employee.joining_date ? dt.formatLocalDate(employee.joining_date) : "—"}
        </Row>
        <Row label={t("employees.field.relievingDate") as string}>
          {employee.relieving_date ? dt.formatLocalDate(employee.relieving_date) : "—"}
        </Row>
        <Row label={t("employees.field.deactivatedAt") as string}>
          {employee.deactivated_at
            ? dt.formatDateTime(employee.deactivated_at)
            : "—"}
        </Row>
      </Section>

      <Section label={t("employees.section.referencePhotos") as string}>
        <Row label={t("employees.col.photos") as string}>
          <span
            className={`pill ${photos.length > 0 ? "pill-accent" : "pill-neutral"}`}
          >
            {photos.length}
          </span>
        </Row>
      </Section>
      {photos.length > 0 && (
        <div className="pp-thumb-grid" style={{ marginBottom: 22 }}>
          {photos.map((p) => (
            <button
              key={p.id}
              type="button"
              className="pp-thumb"
              onClick={() => setZoomPhotoId(p.id)}
              title={t(`employees.photos.angles.${p.angle}`, {
                defaultValue: p.angle,
              }) as string}
            >
              <img
                src={`/api/employees/${employee.id}/photos/${p.id}/image`}
                alt={p.angle}
              />
              <span className="pp-thumb-tag mono">{p.angle}</span>
            </button>
          ))}
        </div>
      )}

      {/* Lightbox — clicking a thumbnail opens this; X button or Esc
          dismisses. z-index has to clear the design CSS's sticky
          topbar (10000) and toast container (99999), and the close
          button is anchored to the fixed overlay itself (not the
          inner image wrapper) so it always renders at the top-right
          of the viewport regardless of image dimensions. */}
      {zoomPhotoId !== null && (
        <ReferencePhotoLightbox
          employeeId={employee.id}
          photoId={zoomPhotoId}
          onClose={() => setZoomPhotoId(null)}
        />
      )}

      <Section label={t("employees.section.status") as string}>
        <Row label={t("employees.col.status") as string}>
          <span
            className={`pill ${
              employee.status === "active" ? "pill-success" : "pill-warning"
            }`}
          >
            {t(`employees.statusValue.${employee.status}`) as string}
          </span>
        </Row>
      </Section>
    </div>
  );
}

export function EventsTab({ employeeId, syncUrl = false }: { employeeId: number; syncUrl?: boolean }) {
  return <EmployeeEventsTab employeeId={employeeId} syncUrl={syncUrl} />;
}

// ---------------------------------------------------------------------------
// Matched Clips tab
//
// Lists every person_clip where the employee is matched — either by the
// legacy ``person_clips.employee_id`` link or by appearing in the
// per-UC ``matched_employees`` JSONB array. Server filter:
// ``?matched_employee_id=N`` (union semantics, see repository.py).
//
// Each card renders the clip thumbnail (``/api/person-clips/{id}/thumbnail``)
// + camera name + duration + size + processed-UC chips. Click → opens the
// same ``ClipDetailDrawer`` used by Person Clips + Clip Analytics.
// ---------------------------------------------------------------------------

const MATCHED_CLIPS_PAGE_SIZE = 24;

export function MatchedClipsTab({ employeeId }: { employeeId: number }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  // Same date pattern as EventsTab — defaults to today's local date;
  // operator can flip to any past date or clear via "All dates".
  const [date, setDate] = useState<string>(todayLocalIso());
  const [allDates, setAllDates] = useState<boolean>(false);
  const [openClip, setOpenClip] = useState<PersonClipOut | null>(null);

  // Convert the local YYYY-MM-DD to a UTC ISO range covering the full
  // local day. Same helper EventsTab uses.
  const { start, end } = computeDayRange(allDates ? null : date);

  // Reset paging when the date filter changes so the operator doesn't
  // land on an empty page after narrowing.
  useDateChangeReset(date, allDates, () => setPage(1));

  const qs = (() => {
    const p = new URLSearchParams();
    p.set("matched_employee_id", String(employeeId));
    p.set("page", String(page));
    p.set("page_size", String(MATCHED_CLIPS_PAGE_SIZE));
    if (start) p.set("start", start);
    if (end) p.set("end", end);
    return p.toString();
  })();

  const list = useQuery({
    queryKey: ["matched-clips", employeeId, qs],
    queryFn: () => api<PersonClipListResponse>(`/api/person-clips?${qs}`),
    refetchInterval: 30_000,
    // Don't burn the 30 s polling budget retrying permission /
    // not-found failures — those won't change between polls.
    retry: (failureCount, error) => {
      if (error instanceof ApiError) {
        if (error.status === 401 || error.status === 403 || error.status === 404) {
          return false;
        }
      }
      return failureCount < 2;
    },
  });

  const errorMessage = (() => {
    if (!list.isError) return null;
    const err = list.error;
    if (err instanceof ApiError) {
      if (err.status === 401) {
        return "Your session expired. Sign in again to view matched clips.";
      }
      if (err.status === 403) {
        return "Matched clips are available to Admin and HR roles.";
      }
      if (err.status === 400) {
        return "Invalid date range. Try clearing the filter.";
      }
      if (err.status >= 500) {
        return "Could not load matched clips — the server is still warming up. The page will retry automatically.";
      }
      return `Could not load matched clips (HTTP ${err.status}).`;
    }
    return "Could not load matched clips. Check your connection and try again.";
  })();

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / MATCHED_CLIPS_PAGE_SIZE));

  return (
    <>
      {/* Date filter row — identical pattern to EventsTab so operators
          get the same affordances across both tabs. */}
      <div className="pp-head-actions" style={{ marginBottom: 12 }}>
        <span className="field-label" style={{ marginBottom: 0 }}>
          {t("employees.events.dateLabel") as string}
        </span>
        <DatePicker
          value={date}
          disabled={allDates}
          onChange={(next) => setDate(next || todayLocalIso())}
          max={todayIso()}
          ariaLabel={t("employees.events.dateLabel") as string}
        />
        <label className="pp-check-row" style={{ fontSize: 12.5, fontWeight: 500, color: "var(--text-secondary)" }}>
          <input
            type="checkbox"
            checked={allDates}
            onChange={(e) => setAllDates(e.target.checked)}
          />
          {t("employees.events.allDates") as string}
        </label>
        {!allDates && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setDate(todayLocalIso())}
            disabled={date === todayLocalIso()}
            title={t("employees.events.resetToToday") as string}
          >
            {t("employees.events.today") as string}
          </button>
        )}
      </div>

      <div className="pp-profile-head" style={{ marginBottom: 12 }}>
        <div className="text-xs text-dim">
          {list.isLoading
            ? ""
            : (t("employees.clips.matchedCount", {
                defaultValue: "{{count}} clips where this person was matched",
                count: total,
              }) as string)}
        </div>
        {totalPages > 1 && (
          <div className="pp-head-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={page <= 1 || list.isFetching}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <Icon name="chevronLeft" size={11} />
            </button>
            <span className="pp-count">
              {page} / {totalPages}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={page >= totalPages || list.isFetching}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              <Icon name="chevronRight" size={11} />
            </button>
          </div>
        )}
      </div>

      {list.isLoading && <SkeletonGrid count={6} minWidth={220} />}
      {errorMessage && (
        <LoadErrorPanel
          title={t("employees.clips.loadFailed", { defaultValue: "Couldn’t load matched clips" }) as string}
          body={errorMessage}
          onRetry={() => void list.refetch()}
        />
      )}
      {!list.isLoading && !list.isError && items.length === 0 && (
        <EmptyPanel
          icon={<Icon name="videocam" size={28} />}
          title={t("employees.clips.emptyTitle", { defaultValue: "No matched clips yet" }) as string}
          body={t("employees.clips.emptyBody", {
            defaultValue:
              "When this person is identified in a clip (via UC1 / UC2 on the Clip Analytics page), it will show up here.",
          }) as string}
        />
      )}

      {items.length > 0 && (
        <>
          <AnomalyInfoBanner message="If the camera misses certain events due to camera positioning, capture limitations, lighting, or brightness conditions, those cases should be treated as possible anomalies." />
          <div className="pp-photo-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
          {items.map((c) => (
            <MatchedClipCard
              key={c.id}
              clip={c}
              onOpen={() => {
                // Only completed clips have a stable artifact — the
                // detail drawer's video + face-crop panels would 404
                // for an in-flight encode. Match the gating Clip
                // Analytics already applies.
                if (c.recording_status === "completed") setOpenClip(c);
              }}
            />
          ))}
        </div>
        </>
      )}

      {openClip && (
        <ClipDetailDrawer
          clip={openClip}
          onClose={() => setOpenClip(null)}
          focusEmployeeId={employeeId}
        />
      )}
    </>
  );
}

function MatchedClipCard({
  clip,
  onOpen,
}: {
  clip: PersonClipOut;
  onOpen: () => void;
}) {
  const [thumbError, setThumbError] = useState(false);
  const fmtClipTime = useFmtClipTime();
  const playable = clip.recording_status === "completed";
  // Prefer the matched employee's face crop when the API returned one
  // (populated by the list endpoint when called with ?matched_employee_id=N).
  // Fall back to the full clip thumbnail for completed clips.
  const imgSrc =
    clip.matched_face_crop_id != null
      ? `/api/person-clips/${clip.id}/face-crops/${clip.matched_face_crop_id}/image`
      : playable
        ? `/api/person-clips/${clip.id}/thumbnail`
        : null;

  // Reset sticky error state whenever the image source changes so a
  // 404 caught while the clip was still encoding doesn't prevent the
  // thumbnail from appearing once encoding completes.
  useEffect(() => {
    setThumbError(false);
  }, [imgSrc]);

  return (
    <button
      type="button"
      onClick={playable ? onOpen : undefined}
      title={
        playable
          ? "Open clip details"
          : `Details unavailable while clip is ${clip.recording_status}`
      }
      style={{
        textAlign: "start",
        padding: 0,
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        overflow: "hidden",
        cursor: playable ? "pointer" : "not-allowed",
        display: "flex",
        flexDirection: "column",
        transition: "transform 120ms ease, box-shadow 120ms ease",
      }}
      onMouseEnter={(e) => {
        if (!playable) return;
        e.currentTarget.style.boxShadow = "0 6px 16px rgba(0,0,0,0.12)";
        e.currentTarget.style.transform = "translateY(-1px)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = "";
        e.currentTarget.style.transform = "";
      }}
    >
      {/* Thumbnail */}
      <div
        style={{
          position: "relative",
          aspectRatio: "16 / 9",
          background: "#111",
          overflow: "hidden",
        }}
      >
        {!thumbError && imgSrc ? (
          <img
            src={imgSrc}
            alt=""
            onError={() => setThumbError(true)}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "block",
            }}
          />
        ) : (
          <div
            style={{
              width: "100%",
              height: "100%",
              display: "grid",
              placeItems: "center",
              color: "rgba(255,255,255,0.4)",
            }}
          >
            <Icon name="videocam" size={28} />
          </div>
        )}

        {/* Lifecycle pill (top-left). Recording / Encoding land as
            colour-coded chips; Completed shows nothing — we don't
            want every card carrying a green badge. */}
        {clip.recording_status === "recording" && (
          <LifecyclePill bg="rgba(239,68,68,0.92)">🔴 Recording</LifecyclePill>
        )}
        {clip.recording_status === "finalizing" && (
          <LifecyclePill bg="rgba(245,158,11,0.92)">Encoding</LifecyclePill>
        )}

        {/* Duration (bottom-right). */}
        <div
          className="mono"
          style={{
            position: "absolute",
            insetInlineEnd: 6,
            insetBlockEnd: 6,
            padding: "2px 6px",
            background: "rgba(0,0,0,0.65)",
            color: "#fff",
            fontSize: 11,
            borderRadius: 4,
          }}
        >
          {fmtClipDuration(clip.duration_seconds)}
        </div>
      </div>

      {/* Meta footer */}
      <div
        style={{
          padding: "8px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 4,
          minWidth: 0,
        }}
      >
        <div
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={clip.camera_name}
        >
          {clip.camera_name || "Unknown camera"}
        </div>
        <div
          className="text-xs text-dim"
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={clip.clip_name}
        >
          {fmtClipTime(clip.clip_start)} · {fmtClipSize(clip.filesize_bytes)}
        </div>

        {/* Processed-UC chips. Only show when at least one UC has run
            — keeps the card quiet for raw Saved clips. */}
        {clip.processed_use_cases.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2 }}>
            {clip.processed_use_cases.map((uc) => (
              <span
                key={uc}
                className="mono"
                style={{
                  padding: "1px 6px",
                  borderRadius: 999,
                  fontSize: 10,
                  fontWeight: 700,
                  background: ucAccentSoft(uc),
                  color: ucAccentText(uc),
                  border: `1px solid ${ucAccentBorder(uc)}`,
                }}
              >
                {uc.toUpperCase()}
              </span>
            ))}
          </div>
        )}
      </div>
    </button>
  );
}

function LifecyclePill({
  bg,
  children,
}: {
  bg: string;
  children: React.ReactNode;
}) {
  return (
    <span
      style={{
        position: "absolute",
        top: 6,
        insetInlineStart: 6,
        padding: "2px 8px",
        background: bg,
        color: "#fff",
        fontSize: 10.5,
        fontWeight: 700,
        borderRadius: 999,
      }}
    >
      {children}
    </span>
  );
}

function fmtClipDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function fmtClipSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// Migration 0068 — hook factory replaces a module-level helper so
// the rendered string respects the tenant's date+time format.
function useFmtClipTime(): (iso: string) => string {
  const dt = useTenantDateTime();
  return (iso) => dt.formatDateTime(iso) || iso;
}

function ucAccentSoft(uc: string): string {
  switch (uc.toLowerCase()) {
    case "uc1":
      return "rgba(59,130,246,0.12)";
    case "uc2":
      return "rgba(139,92,246,0.12)";
    default:
      return "var(--bg-sunken)";
  }
}

function ucAccentText(uc: string): string {
  switch (uc.toLowerCase()) {
    case "uc1":
      return "#1d4ed8";
    case "uc2":
      return "#6d28d9";
    default:
      return "var(--text-secondary)";
  }
}

function ucAccentBorder(uc: string): string {
  switch (uc.toLowerCase()) {
    case "uc1":
      return "rgba(59,130,246,0.25)";
    case "uc2":
      return "rgba(139,92,246,0.25)";
    default:
      return "var(--border)";
  }
}

/** Attendance tab — range summary + calendar + selected-day detail +
 *  day-by-day list. See EmployeeAttendanceTab.tsx. ``syncUrl`` keeps the
 *  range / selected day in the URL on the full profile page. */
export function AttendanceTab({ employeeId, syncUrl = false }: { employeeId: number; syncUrl?: boolean }) {
  return <EmployeeAttendanceTab employeeId={employeeId} syncUrl={syncUrl} />;
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className="pp-section">
      <div className="pp-section-head">
        <div className="pp-section-title">{label}</div>
      </div>
      <div className="pp-facts">{children}</div>
    </section>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="pp-fact-label">{label}</div>
      <div className="pp-fact-value">{children}</div>
    </>
  );
}

export function primaryRoleFromCodes(codes: string[]): string | null {
  const order = ["Admin", "HR", "Manager", "Employee"];
  for (const r of order) if (codes.includes(r)) return r;
  return codes[0] ?? null;
}

export function rolePillClass(role: string): string {
  switch (role) {
    case "Admin":
      return "pill-danger";
    case "HR":
      return "pill-accent";
    case "Manager":
      return "pill-warning";
    default:
      return "pill-neutral";
  }
}

/** Today's date in local time as YYYY-MM-DD. Used as the events
 *  tab's default date filter — operator can pick any earlier date or
 *  toggle "All dates" to drop the bound. */
export function todayLocalIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** Convert a YYYY-MM-DD local date to a UTC ISO range covering the
 *  full local day. Null date ⇒ no bound. */
function computeDayRange(date: string | null): {
  start: string | null;
  end: string | null;
} {
  if (!date) return { start: null, end: null };
  const [y, m, d] = date.split("-").map((s) => Number(s));
  if (!y || !m || !d) return { start: null, end: null };
  const startLocal = new Date(y, m - 1, d, 0, 0, 0, 0);
  const endLocal = new Date(y, m - 1, d, 23, 59, 59, 999);
  return {
    start: startLocal.toISOString(),
    end: endLocal.toISOString(),
  };
}

/** Reset paging to 1 whenever the date filter (or all-dates flag)
 *  changes. */
function useDateChangeReset(
  date: string,
  allDates: boolean,
  reset: () => void,
): void {
  useEffect(() => {
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, allDates]);
}

/** Full-screen reference-photo viewer. X button or Esc dismisses. The
 *  z-index clears the sticky topbar (10000) and toast stack (99999);
 *  the close button is anchored to the fixed overlay so it always sits
 *  at the top corner regardless of image dimensions. */
export function ReferencePhotoLightbox({
  employeeId,
  photoId,
  onClose,
}: {
  employeeId: number;
  photoId: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // Esc closes the lightbox specifically — capture phase so it doesn't
  // bubble into a surrounding drawer's focus-trap handler.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("employees.photos.preview", { defaultValue: "Photo preview" }) as string}
      className="pp-lightbox"
    >
      <button
        type="button"
        className="pp-lightbox-close"
        onClick={onClose}
        aria-label={t("common.close") as string}
        title={(t("common.close") as string) + " (Esc)"}
        autoFocus
      >
        <Icon name="x" size={20} />
      </button>
      <img
        src={`/api/employees/${employeeId}/photos/${photoId}/image`}
        alt="Reference photo"
        style={{ pointerEvents: "none" }}
      />
    </div>
  );
}
