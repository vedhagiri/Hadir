// Read-only Employee detail drawer. Distinct from EmployeeDrawer
// (Add/Edit form) — opened from the kebab menu's "View" action.
//
// Two tabs:
//   * Details — all employee fields rendered as read-only labelled
//     rows (identity, assignment, lifecycle, photos, login/roles).
//   * Events  — detection events captured for this employee on
//     tenant cameras, paged. Reuses the camera-logs detection-events
//     query with the employee_id filter; same /crop endpoint serves
//     the per-row face thumbnail.
//
// Edit is intentionally NOT inline here — operators flip to the Edit
// drawer via the row's kebab menu (or the "Edit" button in this
// drawer's footer) so the read-only / write-mode boundary is
// explicit.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { DatePicker, todayIso } from "../../components/DatePicker";
import { DrawerShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import { useDayDetail } from "../calendar/hooks";
import type { DayDetail } from "../calendar/types";
import { useDetectionEvents } from "../camera-logs/hooks";
import type { DetectionEvent } from "../camera-logs/types";
import {
  useEmployeeDetail,
  useEmployeePhotos,
  useEmployeeTeamMembers,
} from "./hooks";
import type { Employee, Photo } from "./types";

type Tab = "details" | "events" | "attendance" | "team";

export function EmployeeViewDrawer({
  employeeId,
  onClose,
  onEdit,
}: {
  employeeId: number;
  onClose: () => void;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const detail = useEmployeeDetail(employeeId);
  const photos = useEmployeePhotos(employeeId);
  const [tab, setTab] = useState<Tab>("details");

  return (
    <DrawerShell onClose={onClose}>
      <div className="drawer">
        <div className="drawer-head">
          <div>
            <div className="mono text-xs text-dim">
              {t("employees.view.label") as string}
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>
              {detail.data?.full_name ?? "—"}
            </div>
            {detail.data && (
              <div className="mono text-xs text-dim" style={{ marginTop: 2 }}>
                {detail.data.employee_code} · {detail.data.department.name}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                onClose();
                onEdit();
              }}
              title={t("employees.action.edit") as string}
            >
              <Icon name="edit" size={11} />
              {t("employees.action.edit") as string}
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={onClose}
              aria-label={t("common.close") as string}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        </div>

        {/* Tab strip */}
        <nav
          aria-label={t("employees.view.tabs") as string}
          style={{
            display: "flex",
            gap: 4,
            borderBottom: "1px solid var(--border)",
            padding: "0 18px",
          }}
        >
          {(["details", "attendance", "events", "team"] as Tab[]).map((key) => {
            const active = tab === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                aria-pressed={active}
                style={{
                  padding: "10px 12px",
                  fontSize: 13,
                  border: "none",
                  background: "transparent",
                  color: active ? "var(--text)" : "var(--text-secondary)",
                  borderBottom: active
                    ? "2px solid var(--accent)"
                    : "2px solid transparent",
                  fontWeight: active ? 600 : 400,
                  marginBottom: -1,
                  cursor: "pointer",
                }}
              >
                {t(`employees.view.tab.${key}`) as string}
              </button>
            );
          })}
        </nav>

        <div className="drawer-body">
          {tab === "details" &&
            (detail.isLoading ? (
              <div className="text-sm text-dim">
                {t("common.loading") as string}…
              </div>
            ) : detail.data ? (
              <DetailsTab
                employee={detail.data}
                photos={photos.data?.items ?? []}
              />
            ) : (
              <div className="text-sm text-dim">
                {t("employees.loadFailed") as string}
              </div>
            ))}

          {tab === "events" && <EventsTab employeeId={employeeId} />}

          {tab === "attendance" && (
            <AttendanceTab employeeId={employeeId} />
          )}

          {tab === "team" && <TeamMembersTab employeeId={employeeId} />}
        </div>
      </div>
    </DrawerShell>
  );
}

// ---------------------------------------------------------------------------
// Team Members tab
// ---------------------------------------------------------------------------

function TeamMembersTab({ employeeId }: { employeeId: number }) {
  const { t } = useTranslation();
  const team = useEmployeeTeamMembers(employeeId);
  // Dev/debug toggle — the three org-tier columns are off by default
  // and revealed via the "Show org tiers" button. Keeps the tab tidy
  // for everyday use without losing the rule-tracing visibility.
  const [showTiers, setShowTiers] = useState(false);

  if (team.isLoading) {
    return (
      <div className="text-sm text-dim">{t("common.loading") as string}…</div>
    );
  }
  if (team.isError || !team.data) {
    return (
      <div className="text-sm" style={{ color: "var(--danger-text)" }}>
        {t("employees.team.loadFailed", {
          defaultValue: "Could not load team members.",
        }) as string}
      </div>
    );
  }

  const { scope, scope_name, items } = team.data;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "8px 12px",
          background: "var(--bg-sunken)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          fontSize: 12.5,
        }}
      >
        <div>
          <span className="text-xs text-dim" style={{ marginInlineEnd: 6 }}>
            {t("employees.team.scopeLabel", {
              defaultValue: "Scope",
            }) as string}
          </span>
          <span style={{ fontWeight: 500 }}>
            {t(`employees.team.scope.${scope}`, {
              defaultValue:
                scope === "division"
                  ? "Division"
                  : scope === "section"
                    ? "Section"
                    : "Department",
            }) as string}
            {" · "}
            {scope_name || "—"}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setShowTiers((v) => !v)}
            aria-pressed={showTiers}
            title={
              showTiers
                ? (t("employees.team.hideTiers", {
                    defaultValue: "Hide org tiers",
                  }) as string)
                : (t("employees.team.showTiers", {
                    defaultValue: "Show org tiers",
                  }) as string)
            }
          >
            {showTiers
              ? (t("employees.team.hideTiers", {
                  defaultValue: "Hide org tiers",
                }) as string)
              : (t("employees.team.showTiers", {
                  defaultValue: "Show org tiers",
                }) as string)}
          </button>
          <span className="mono text-xs text-dim">
            {items.length}{" "}
            {t("employees.team.members", {
              count: items.length,
              defaultValue: items.length === 1 ? "member" : "members",
            }) as string}
          </span>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="text-sm text-dim" style={{ padding: 8 }}>
          {t("employees.team.empty", {
            defaultValue: "No other team members in this scope.",
          }) as string}
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ textTransform: "uppercase", fontSize: 11 }}>
                  {t("employees.field.code", {
                    defaultValue: "Employee ID",
                  }) as string}
                </th>
                <th style={{ textTransform: "uppercase", fontSize: 11 }}>
                  {t("employees.field.fullName", {
                    defaultValue: "Name",
                  }) as string}
                </th>
                <th style={{ textTransform: "uppercase", fontSize: 11 }}>
                  {t("employees.field.designation", {
                    defaultValue: "Designation",
                  }) as string}
                </th>
                {showTiers && (
                  <>
                    <th style={{ textTransform: "uppercase", fontSize: 11 }}>
                      {t("employees.team.col.division", {
                        defaultValue: "Division",
                      }) as string}
                    </th>
                    <th style={{ textTransform: "uppercase", fontSize: 11 }}>
                      {t("employees.team.col.department", {
                        defaultValue: "Department",
                      }) as string}
                    </th>
                    <th style={{ textTransform: "uppercase", fontSize: 11 }}>
                      {t("employees.team.col.section", {
                        defaultValue: "Section",
                      }) as string}
                    </th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.id}>
                  <td className="mono text-sm">{m.employee_code}</td>
                  <td className="text-sm" style={{ fontWeight: 500 }}>
                    {m.full_name}
                  </td>
                  <td className="text-sm">{m.designation ?? "—"}</td>
                  {showTiers && (
                    <>
                      <td className="text-sm text-dim">
                        {m.division_name ?? "—"}
                      </td>
                      <td className="text-sm text-dim">
                        {m.department_name ?? "—"}
                      </td>
                      <td className="text-sm text-dim">
                        {m.section_name ?? "—"}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DetailsTab({
  employee,
  photos,
}: {
  employee: Employee;
  photos: Photo[];
}) {
  const { t } = useTranslation();
  const [zoomPhotoId, setZoomPhotoId] = useState<number | null>(null);
  const role = primaryRoleFromCodes(employee.role_codes ?? []);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
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
          {employee.joining_date ?? "—"}
        </Row>
        <Row label={t("employees.field.relievingDate") as string}>
          {employee.relieving_date ?? "—"}
        </Row>
        <Row label={t("employees.field.deactivatedAt") as string}>
          {employee.deactivated_at
            ? new Date(employee.deactivated_at).toLocaleString()
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
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
            gap: 8,
            marginTop: -4,
          }}
        >
          {photos.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setZoomPhotoId(p.id)}
              title={t(`employees.photos.angles.${p.angle}`, {
                defaultValue: p.angle,
              }) as string}
              style={{
                position: "relative",
                padding: 0,
                border: "1px solid var(--border)",
                borderRadius: 8,
                overflow: "hidden",
                background: "var(--bg-sunken)",
                cursor: "zoom-in",
                aspectRatio: "1 / 1",
              }}
            >
              <img
                src={`/api/employees/${employee.id}/photos/${p.id}/image`}
                alt={p.angle}
                style={{
                  display: "block",
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                }}
              />
              <span
                className="text-xs mono"
                style={{
                  position: "absolute",
                  bottom: 0,
                  insetInlineStart: 0,
                  padding: "1px 6px",
                  background: "rgba(0,0,0,0.55)",
                  color: "white",
                  fontSize: 10,
                  borderTopRightRadius: 6,
                }}
              >
                {p.angle}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Lightbox — click thumbnail to open; X button only closes
          (matches the operator-policy red line). */}
      {zoomPhotoId !== null && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            display: "grid",
            placeItems: "center",
            zIndex: 9999,
            padding: 32,
          }}
        >
          <div
            style={{
              position: "relative",
              maxWidth: "90vw",
              maxHeight: "90vh",
            }}
          >
            <img
              src={`/api/employees/${employee.id}/photos/${zoomPhotoId}/image`}
              alt="Reference photo"
              style={{
                maxWidth: "90vw",
                maxHeight: "90vh",
                objectFit: "contain",
                borderRadius: 8,
                boxShadow: "0 12px 48px rgba(0,0,0,0.5)",
              }}
            />
            <button
              type="button"
              className="icon-btn"
              onClick={() => setZoomPhotoId(null)}
              aria-label={t("common.close") as string}
              style={{
                position: "absolute",
                top: 8,
                insetInlineEnd: 8,
                background: "rgba(0,0,0,0.6)",
                color: "white",
              }}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        </div>
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

function EventsTab({ employeeId }: { employeeId: number }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  // Defaults to today's local date in YYYY-MM-DD; operator can flip
  // to any past date or clear the filter (use "All dates" toggle).
  const [date, setDate] = useState<string>(todayLocalIso());
  const [allDates, setAllDates] = useState<boolean>(false);
  const PAGE_SIZE = 25;

  // Day-bounded range — captured_at is stored in UTC so we convert
  // the operator's local picked date to a UTC ISO range covering the
  // full local day. Null when "All dates" is on.
  const { start, end } = computeDayRange(allDates ? null : date);

  // Reset to page 1 when the date filter changes.
  // (Don't memoise the start/end recompute — it's a few string ops
  // per render, cheap.)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useDateChangeReset(date, allDates, () => setPage(1));

  const events = useDetectionEvents({
    camera_id: null,
    employee_id: employeeId,
    identified: null,
    start,
    end,
    page,
    page_size: PAGE_SIZE,
  });

  const totalPages = events.data
    ? Math.max(1, Math.ceil(events.data.total / events.data.page_size))
    : 1;

  return (
    <div>
      {/* Date filter row — default = today, "All dates" reverts to
          the unbounded query. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 12,
        }}
      >
        <label
          className="text-xs text-dim"
          style={{ fontWeight: 500 }}
        >
          {t("employees.events.dateLabel") as string}
        </label>
        <DatePicker
          value={date}
          disabled={allDates}
          onChange={(next) => setDate(next || todayLocalIso())}
          max={todayIso()}
          ariaLabel={t("employees.events.dateLabel") as string}
        />
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: "var(--text-secondary)",
            cursor: "pointer",
          }}
        >
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

      {events.isLoading && (
        <div className="text-sm text-dim">
          {t("common.loading") as string}…
        </div>
      )}
      {events.isError && (
        <div className="text-sm" style={{ color: "var(--danger-text)" }}>
          {t("employees.events.loadFailed") as string}
        </div>
      )}
      {events.data && events.data.items.length === 0 && (
        <div className="text-sm text-dim" style={{ padding: 12 }}>
          {allDates
            ? (t("employees.events.empty") as string)
            : (t("employees.events.emptyForDate") as string)}
        </div>
      )}

      {events.data && events.data.items.length > 0 && (
        <>
      <div
        style={{
          fontSize: 12,
          color: "var(--text-secondary)",
          marginBottom: 8,
        }}
      >
        {t("employees.events.totalLabel", {
          count: events.data?.total ?? 0,
        }) as string}
      </div>
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 64 }}>{t("liveCapture.col.face") as string}</th>
            <th>{t("liveCapture.col.time") as string}</th>
            <th>{t("liveCapture.col.camera") as string}</th>
            <th>{t("liveCapture.col.confidence") as string}</th>
          </tr>
        </thead>
        <tbody>
          {(events.data?.items ?? []).map((ev: DetectionEvent) => (
            <tr key={ev.id}>
              <td>
                {ev.has_crop ? (
                  <img
                    src={`/api/detection-events/${ev.id}/crop`}
                    alt={`event ${ev.id}`}
                    loading="lazy"
                    style={{
                      display: "block",
                      width: 44,
                      height: 44,
                      objectFit: "cover",
                      borderRadius: "var(--radius-sm)",
                      border: "1px solid var(--border)",
                    }}
                  />
                ) : (
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: "var(--radius-sm)",
                      border: "1px dashed var(--border)",
                      background: "var(--bg-sunken)",
                    }}
                    title="No crop"
                  />
                )}
              </td>
              <td className="mono text-sm">
                {new Date(ev.captured_at).toLocaleString()}
              </td>
              <td className="text-sm">{ev.camera_name}</td>
              <td className="mono text-sm">
                {ev.confidence !== null
                  ? `${(ev.confidence * 100).toFixed(0)}%`
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Pagination */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: 10,
          fontSize: 12,
        }}
      >
        <span className="text-dim">
          {t("employees.events.pageNumber", {
            page,
            totalPages,
          }) as string}
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            className="btn btn-sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <Icon name="chevronLeft" size={11} />
            {t("common.previous") as string}
          </button>
          <button
            className="btn btn-sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            {t("common.next") as string}
            <Icon name="chevronRight" size={11} />
          </button>
        </div>
      </div>
        </>
      )}
    </div>
  );
}

/**
 * Attendance tab. Mirrors docs/scripts/issues-screenshots/03-Attendance_Record_model_screen_ref.png:
 *
 *   * Profile strip with policy + status pills.
 *   * 4-cell stat row: in_time / out_time / total / overtime (large mono).
 *   * Day timeline ribbon (06:00–18:00 with shaded work intervals).
 *   * Evidence strip — up to 5 face crops with timestamps + cam codes.
 *   * Policy applied card.
 *
 * Defaults to today; date picker re-fetches via useDayDetail.
 */
function AttendanceTab({ employeeId }: { employeeId: number }) {
  const { t } = useTranslation();
  const [date, setDate] = useState<string>(todayLocalIso());
  const day = useDayDetail(employeeId, date);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Date picker row — same shape as the Events tab. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <label
          className="text-xs text-dim"
          style={{ fontWeight: 500 }}
        >
          {t("employees.events.dateLabel") as string}
        </label>
        <DatePicker
          value={date}
          onChange={(next) => setDate(next || todayLocalIso())}
          max={todayIso()}
          ariaLabel={t("employees.events.dateLabel") as string}
        />
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setDate(todayLocalIso())}
          disabled={date === todayLocalIso()}
        >
          {t("employees.events.today") as string}
        </button>
      </div>

      {day.isLoading && (
        <div className="text-sm text-dim">
          {t("common.loading") as string}…
        </div>
      )}
      {day.isError && (
        <div className="text-sm" style={{ color: "var(--danger-text)" }}>
          {t("employees.attendance.loadFailed") as string}
        </div>
      )}
      {day.data && <AttendanceDayCard day={day.data} />}
    </div>
  );
}

function AttendanceDayCard({ day }: { day: DayDetail }) {
  const { t } = useTranslation();

  const inTime = day.in_time ? formatHms(day.in_time) : "—";
  const outTime = day.out_time ? formatHms(day.out_time) : "—";
  const totalHms =
    day.total_minutes != null ? minutesToHms(day.total_minutes) : "—";
  const overtimeH =
    day.overtime_minutes > 0
      ? `+${(day.overtime_minutes / 60).toFixed(1)}h`
      : "—";

  return (
    <>
      {/* Status pills */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {day.policy_name && (
          <span className="pill pill-neutral">{day.policy_name}</span>
        )}
        <span className={`pill ${statusPillClass(day.status)}`}>
          {t(`employees.attendance.status.${day.status}`, {
            defaultValue: day.status,
          }) as string}
        </span>
      </div>

      {/* Stat grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr 1fr",
          gap: 8,
        }}
      >
        <StatCell
          label={t("employees.attendance.inTime") as string}
          value={inTime}
        />
        <StatCell
          label={t("employees.attendance.outTime") as string}
          value={outTime}
        />
        <StatCell
          label={t("employees.attendance.total") as string}
          value={totalHms}
        />
        <StatCell
          label={t("employees.attendance.overtime") as string}
          value={overtimeH}
          highlight={day.overtime_minutes > 0}
        />
      </div>

      {/* Day timeline ribbon */}
      <div>
        <SectionLabel>
          {t("employees.attendance.dayTimeline") as string}
        </SectionLabel>
        <DayTimeline timeline={day.timeline} />
      </div>

      {/* Evidence */}
      {day.evidence.length > 0 && (
        <div>
          <SectionLabel>
            {t("employees.attendance.evidence", {
              count: day.evidence.length,
            }) as string}
          </SectionLabel>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
              gap: 8,
            }}
          >
            {day.evidence.slice(0, 8).map((c) => (
              <div
                key={c.detection_event_id}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  overflow: "hidden",
                  background: "var(--bg-sunken)",
                }}
              >
                <div
                  style={{
                    position: "relative",
                    aspectRatio: "1 / 1",
                  }}
                >
                  <img
                    src={c.crop_url}
                    alt={c.camera_code}
                    loading="lazy"
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                      display: "block",
                    }}
                  />
                  {c.confidence != null && (
                    <span
                      className="mono text-xs"
                      style={{
                        position: "absolute",
                        top: 4,
                        insetInlineStart: 4,
                        background: "rgba(0,0,0,0.6)",
                        color: "white",
                        padding: "1px 5px",
                        borderRadius: 4,
                        fontSize: 10,
                      }}
                    >
                      {Math.round(c.confidence * 100)}%
                    </span>
                  )}
                </div>
                <div
                  className="mono text-xs text-dim"
                  style={{ padding: "4px 6px", lineHeight: 1.3 }}
                >
                  <div style={{ color: "var(--text)", fontSize: 11 }}>
                    {formatHms(c.captured_at).slice(0, 5)}
                  </div>
                  <div>{c.camera_code}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Policy applied */}
      {day.policy_name && (
        <div>
          <SectionLabel>
            {t("employees.attendance.policyApplied") as string}
          </SectionLabel>
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: 10,
              background: "var(--bg-sunken)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 500, fontSize: 13 }}>
                {day.policy_name}
              </div>
              {day.policy_description && (
                <div className="text-xs text-dim" style={{ marginTop: 2 }}>
                  {day.policy_description}
                </div>
              )}
            </div>
            <span className="mono text-xs text-dim">
              {t("employees.attendance.policyScope", {
                scope: day.policy_scope,
                defaultValue: day.policy_scope,
              }) as string}
            </span>
          </div>
        </div>
      )}

      {/* Empty / non-working day callouts */}
      {day.is_weekend && (
        <div className="pill pill-neutral">
          {t("employees.attendance.weekend") as string}
        </div>
      )}
      {day.is_holiday && day.holiday_name && (
        <div className="pill pill-accent">
          {t("employees.attendance.holiday", {
            name: day.holiday_name,
          }) as string}
        </div>
      )}
      {day.leave_name && (
        <div className="pill pill-warning">
          {t("employees.attendance.leave", {
            name: day.leave_name,
          }) as string}
        </div>
      )}
    </>
  );
}

function StatCell({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "10px 12px",
        background: "var(--bg-sunken)",
      }}
    >
      <div
        className="text-xs"
        style={{
          fontWeight: 500,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--text-tertiary)",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        className="mono"
        style={{
          fontSize: 18,
          fontWeight: 600,
          color: highlight ? "var(--accent-text)" : "var(--text)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="text-xs"
      style={{
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        color: "var(--text-tertiary)",
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

function DayTimeline({
  timeline,
}: {
  timeline: { start: string; end: string }[];
}) {
  // 06:00–18:00 ribbon, scaled 0..100% across the band. Intervals
  // outside the band clamp to the edges so the operator still sees
  // them visually.
  const TICKS = [6, 9, 12, 15, 18];
  const startMin = 6 * 60;
  const endMin = 18 * 60;
  const total = endMin - startMin;
  const pct = (iso: string) => {
    const m = isoToLocalMin(iso);
    if (m == null) return null;
    return Math.max(0, Math.min(100, ((m - startMin) / total) * 100));
  };
  return (
    <div>
      <div
        style={{
          position: "relative",
          height: 18,
          background: "var(--bg-sunken)",
          borderRadius: 4,
          border: "1px solid var(--border)",
          overflow: "hidden",
        }}
      >
        {timeline.map((iv, i) => {
          const a = pct(iv.start);
          const b = pct(iv.end);
          if (a == null || b == null) return null;
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                insetInlineStart: `${a}%`,
                width: `${Math.max(0.5, b - a)}%`,
                background: "var(--accent)",
                opacity: 0.85,
              }}
            />
          );
        })}
      </div>
      <div
        className="mono text-xs text-dim"
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 4,
        }}
      >
        {TICKS.map((h) => (
          <span key={h}>{String(h).padStart(2, "0")}</span>
        ))}
      </div>
    </div>
  );
}

function statusPillClass(status: string): string {
  switch (status) {
    case "present":
      return "pill-success";
    case "late":
      return "pill-warning";
    case "absent":
      return "pill-danger";
    case "leave":
      return "pill-accent";
    case "weekend":
    case "holiday":
      return "pill-neutral";
    default:
      return "pill-neutral";
  }
}

function formatHms(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour12: false });
  } catch {
    return iso;
  }
}

function minutesToHms(m: number): string {
  const h = Math.floor(m / 60);
  const r = Math.floor(m % 60);
  const s = Math.floor((m * 60) % 60);
  return `${String(h).padStart(2, "0")}:${String(r).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function isoToLocalMin(iso: string): number | null {
  try {
    const d = new Date(iso);
    return d.getHours() * 60 + d.getMinutes();
  } catch {
    return null;
  }
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 11.5,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--text-tertiary)",
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "150px 1fr",
          rowGap: 6,
          columnGap: 12,
          fontSize: 13,
        }}
      >
        {children}
      </div>
    </div>
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
      <div className="text-xs text-dim" style={{ paddingTop: 2 }}>
        {label}
      </div>
      <div>{children}</div>
    </>
  );
}

function primaryRoleFromCodes(codes: string[]): string | null {
  const order = ["Admin", "HR", "Manager", "Employee"];
  for (const r of order) if (codes.includes(r)) return r;
  return codes[0] ?? null;
}

function rolePillClass(role: string): string {
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
function todayLocalIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** Convert a YYYY-MM-DD local date to a UTC ISO range covering the
 *  full local day. captured_at is stored in UTC, so the range needs
 *  to span the operator's local day in UTC terms. Null date ⇒ no
 *  bound (used by the "All dates" toggle). */
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
 *  changes. Wrapped in a hook so the events tab body stays
 *  declarative and the dep array is correct. */
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
