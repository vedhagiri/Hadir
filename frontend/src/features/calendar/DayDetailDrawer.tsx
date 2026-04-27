// Drawer with the full day detail — status, summary tiles, policy
// applied, day timeline ribbon, evidence crops, and a "Submit
// exception" CTA the request flow (P14) plugs into.

import { useTranslation } from "react-i18next";

import { Icon } from "../../shell/Icon";
import { useDayDetail } from "./hooks";

interface Props {
  employeeId: number;
  isoDate: string;
  onClose: () => void;
  onSubmitException?: (isoDate: string) => void;
}

export function DayDetailDrawer({
  employeeId,
  isoDate,
  onClose,
  onSubmitException,
}: Props) {
  const { t } = useTranslation();
  const detail = useDayDetail(employeeId, isoDate);

  const exportHref = `/api/attendance/calendar/export?month=${isoDate.slice(
    0,
    7,
  )}&employee_id=${employeeId}&date=${isoDate}`;

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          <div>
            <div className="mono text-xs text-dim">
              {(t("calendar.dayDetail") as string)}
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>
              {detail.data?.full_name ?? ""} · {isoDate}
            </div>
          </div>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label={t("calendar.close") as string}
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="drawer-body">
          {detail.isLoading && (
            <div className="text-sm text-dim">{t("calendar.loading") as string}</div>
          )}
          {detail.isError && (
            <div className="text-sm" style={{ color: "var(--danger-text)" }}>
              {t("calendar.loadFailed") as string}
            </div>
          )}

          {detail.data && (
            <>
              {/* Header chip line */}
              <div
                className="flex items-center gap-2"
                style={{ marginBottom: 16, flexWrap: "wrap" }}
              >
                <span className="pill pill-neutral">
                  {detail.data.employee_code}
                </span>
                <span className="pill pill-neutral">
                  {detail.data.department_name}
                </span>
                <StatusPill status={detail.data.status} />
                {detail.data.holiday_name && (
                  <span className="pill pill-info">
                    {detail.data.holiday_name}
                  </span>
                )}
                {detail.data.leave_name && (
                  <span className="pill pill-info">
                    {detail.data.leave_name}
                  </span>
                )}
              </div>

              {/* Summary tiles */}
              <div
                className="grid grid-4"
                style={{ gap: 10, marginBottom: 16 }}
              >
                <Tile
                  label={t("calendar.inTime") as string}
                  value={detail.data.in_time?.slice(0, 5) ?? "—"}
                />
                <Tile
                  label={t("calendar.outTime") as string}
                  value={detail.data.out_time?.slice(0, 5) ?? "—"}
                />
                <Tile
                  label={t("calendar.total") as string}
                  value={
                    detail.data.total_minutes != null
                      ? `${(detail.data.total_minutes / 60).toFixed(1)}h`
                      : "—"
                  }
                />
                <Tile
                  label={t("calendar.overtime") as string}
                  value={
                    detail.data.overtime_minutes > 0
                      ? `${(detail.data.overtime_minutes / 60).toFixed(1)}h`
                      : "—"
                  }
                />
              </div>

              {/* Day timeline ribbon */}
              <Section label={t("calendar.dayTimeline") as string}>
                <DayTimelineRibbon
                  intervals={detail.data.timeline}
                />
                {detail.data.timeline.length === 0 && (
                  <div className="text-xs text-dim" style={{ marginTop: 6 }}>
                    {t("calendar.noTimeline") as string}
                  </div>
                )}
              </Section>

              {/* Policy applied */}
              <Section label={t("calendar.policyApplied") as string}>
                <div
                  style={{
                    padding: 12,
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                  }}
                >
                  <div className="flex items-center justify-between">
                    <div style={{ fontSize: 13, fontWeight: 500 }}>
                      {detail.data.policy_name ?? "—"}
                    </div>
                    <span className="text-xs text-dim mono">
                      {detail.data.policy_scope}
                    </span>
                  </div>
                  {detail.data.policy_description && (
                    <div
                      className="text-xs text-dim"
                      style={{ marginTop: 6 }}
                    >
                      {detail.data.policy_description}
                    </div>
                  )}
                </div>
              </Section>

              {/* Evidence crops */}
              <Section
                label={`${t("calendar.evidence") as string}${
                  detail.data.evidence.length > 0
                    ? ` · ${detail.data.evidence.length}`
                    : ""
                }`}
              >
                {detail.data.evidence.length === 0 ? (
                  <div className="text-sm text-dim">
                    {t("calendar.noEvidence") as string}
                  </div>
                ) : (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(5, 1fr)",
                      gap: 8,
                    }}
                  >
                    {detail.data.evidence.map((e) => (
                      <div
                        key={e.detection_event_id}
                        style={{
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          overflow: "hidden",
                          background: "var(--bg-sunken)",
                        }}
                      >
                        <img
                          src={e.crop_url}
                          alt={`${e.captured_at} ${e.camera_code}`}
                          loading="lazy"
                          style={{
                            display: "block",
                            width: "100%",
                            aspectRatio: "1 / 1",
                            objectFit: "cover",
                          }}
                        />
                        <div style={{ padding: "4px 6px" }}>
                          <div className="mono text-xs">
                            {e.captured_at.slice(0, 5)}
                          </div>
                          <div className="text-xs text-dim">
                            {e.camera_code}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Section>
            </>
          )}
        </div>

        <div
          className="drawer-foot"
          style={{ display: "flex", gap: 8, justifyContent: "space-between" }}
        >
          <div style={{ display: "flex", gap: 8 }}>
            {onSubmitException && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => onSubmitException(isoDate)}
              >
                + {t("calendar.submitException") as string}
              </button>
            )}
            <a
              className="btn"
              href={exportHref}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("calendar.export") as string}
            </a>
          </div>
          <button className="btn" onClick={onClose}>
            {t("calendar.close") as string}
          </button>
        </div>
      </div>
    </>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--text-tertiary)",
          marginBottom: 8,
          marginTop: 4,
        }}
      >
        {label}
      </div>
      <div style={{ marginBottom: 16 }}>{children}</div>
    </>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: "10px 12px",
        background: "var(--bg-sunken)",
        borderRadius: 8,
      }}
    >
      <div
        className="text-xs text-dim"
        style={{
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      <div
        className="mono"
        style={{ fontSize: 15, fontWeight: 500, marginTop: 2 }}
      >
        {value}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const { t } = useTranslation();
  const tone =
    status === "present"
      ? "success"
      : status === "late"
        ? "warning"
        : status === "absent"
          ? "danger"
          : status === "leave" || status === "holiday"
            ? "info"
            : "neutral";
  return (
    <span className={`pill pill-${tone}`}>
      {t(`calendar.status.${status}`) as string}
    </span>
  );
}

function DayTimelineRibbon({
  intervals,
}: {
  intervals: { start: string; end: string }[];
}) {
  // Render a 24-hour SVG ribbon with one bar per interval. Hours are
  // marked along the bottom for orientation.
  const HOURS = 24;
  const widthPct = (mm: number) => `${(100 * mm) / (HOURS * 60)}%`;
  const minutesOf = (hhmm: string): number => {
    const [h, m] = hhmm.split(":").map((s) => parseInt(s, 10));
    return (h ?? 0) * 60 + (m ?? 0);
  };

  return (
    <div
      style={{
        position: "relative",
        height: 36,
        border: "1px solid var(--border)",
        borderRadius: 6,
        background: "var(--bg-sunken)",
      }}
    >
      {/* Hour ticks */}
      {Array.from({ length: HOURS + 1 }).map((_, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            insetInlineStart: `${(100 * i) / HOURS}%`,
            top: 0,
            bottom: 0,
            width: 1,
            background:
              i === 0 || i === HOURS
                ? "transparent"
                : "var(--border)",
            opacity: i % 6 === 0 ? 0.7 : 0.3,
          }}
          aria-hidden
        />
      ))}
      {/* Interval bars */}
      {intervals.map((iv, idx) => {
        const start = minutesOf(iv.start);
        const end = Math.max(start + 1, minutesOf(iv.end));
        return (
          <div
            key={idx}
            style={{
              position: "absolute",
              insetInlineStart: widthPct(start),
              width: widthPct(end - start),
              top: 6,
              bottom: 16,
              background: "var(--accent)",
              borderRadius: 3,
            }}
            title={`${iv.start} – ${iv.end}`}
          />
        );
      })}
      {/* Hour labels */}
      {[0, 6, 12, 18, 24].map((h) => (
        <div
          key={h}
          style={{
            position: "absolute",
            insetInlineStart: `${(100 * h) / HOURS}%`,
            bottom: 0,
            transform: "translateX(-50%)",
            fontSize: 9.5,
            color: "var(--text-tertiary)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {String(h).padStart(2, "0")}
        </div>
      ))}
    </div>
  );
}
