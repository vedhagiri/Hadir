// Drawer with the full day detail — status, summary tiles, policy
// applied, day timeline ribbon, evidence crops, and a "Submit
// exception" CTA the request flow (P14) plugs into.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";

import { BsXCircleFill, BsClipboard2PlusFill, BsChevronRight } from "react-icons/bs";

import { api, extractApiError } from "../../api/client";
import { AnomalyInfoBanner } from "../../components/AnomalyNote";
import { DrawerShell } from "../../components/DrawerShell";
import { LateBadge } from "../../components/LateBadge";
import { Icon } from "../../shell/Icon";
import { useMe } from "../../auth/AuthProvider";
import { primaryRole } from "../../types";
import { EscalationDrawer } from "./EscalationDrawer";
import { useDayDetail } from "./hooks";
import { calcLateMinutes, fmtMinutes } from "./PersonView";
import type {
  DayDetail,
  EscalationRequestSnapshot,
  EvidenceCrop,
} from "./types";

interface Props {
  employeeId: number;
  isoDate: string;
  onClose: () => void;
  onSubmitException?: (isoDate: string) => void;
}

// ---------------------------------------------------------------------------
// DayDetailContent — the reusable body. Used directly by DayDetailDrawer
// and by the Employee profile Attendance tab so both surfaces show the
// exact same UI without duplication.
// ---------------------------------------------------------------------------

export function DayDetailContent({
  employeeId,
  isoDate,
  onSubmitException,
}: {
  employeeId: number;
  isoDate: string;
  onSubmitException?: ((isoDate: string) => void) | null;
}) {
  const { t } = useTranslation();
  const detail = useDayDetail(employeeId, isoDate);

  const [highlightedEventId, setHighlightedEventId] = useState<number | null>(null);
  const [showEscalation, setShowEscalation] = useState(false);
  const me = useMe();
  const currentRole = me.data ? primaryRole(me.data.roles) : null;
  const isEmployee = currentRole === "Employee";
  const qc = useQueryClient();

  const onDecisionMade = useCallback(() => {
    const month = isoDate.slice(0, 7);
    void qc.invalidateQueries({ queryKey: ["calendar"] });
    void qc.invalidateQueries({ queryKey: ["attendance"] });
    void qc.invalidateQueries({ queryKey: ["requests"] });
    void qc.refetchQueries({ queryKey: ["calendar", "day", employeeId, isoDate], exact: true });
    void qc.refetchQueries({ queryKey: ["calendar", "person", employeeId, month], exact: true });
  }, [qc, isoDate, employeeId]);

  const evidenceRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const onTimelineEventActivate = useCallback((eventId: number) => {
    const el = evidenceRefs.current.get(eventId);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setHighlightedEventId(eventId);
    window.setTimeout(() => setHighlightedEventId(null), 2500);
  }, []);

  return (
    <>
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
          {/* Header chip line — always shown */}
          <div className="flex items-center gap-2" style={{ marginBottom: 16, flexWrap: "wrap" }}>
            <span className="pill pill-neutral">{detail.data.employee_code}</span>
            <span className="pill pill-neutral">{detail.data.department_name}</span>
            <StatusPill status={detail.data.status} detail={detail.data} />
            {detail.data.holiday_name && (
              <span className="pill pill-info">{detail.data.holiday_name}</span>
            )}
            {detail.data.leave_name && (
              <span className="pill pill-info">{detail.data.leave_name}</span>
            )}
          </div>

          {detail.data.status === "late" && <LateBreakdownCard detail={detail.data} />}

          {detail.data.status === "absent" && (
            <AbsentStateCard
              detail={detail.data}
              isoDate={isoDate}
              onSubmitException={onSubmitException ?? null}
              onRaiseEscalation={isEmployee ? () => setShowEscalation(true) : null}
              currentRole={currentRole}
              onDecisionMade={onDecisionMade}
            />
          )}

          {detail.data.status === "waiting" && (
            <AbsentWaitingCard
              status="waiting"
              isoDate={isoDate}
              policyName={detail.data.policy_name ?? null}
              policyType={detail.data.policy_type ?? null}
              policyShiftStart={detail.data.policy_shift_start ?? null}
              policyShiftEnd={detail.data.policy_shift_end ?? null}
              policyRequiredHours={detail.data.policy_required_hours ?? null}
              onSubmitException={onSubmitException ?? null}
              onRaiseEscalation={isEmployee ? () => setShowEscalation(true) : null}
            />
          )}

          {detail.data.status !== "absent" && detail.data.status !== "waiting" && (
            detail.data.escalation_confirmed ? (
              <EscalationConfirmedCard
                note={detail.data.escalation_note ?? null}
                snapshot={detail.data.escalation_request ?? null}
              />
            ) : detail.data.status === "weekend" ? (
              <WeekOffDayContent
                detail={detail.data}
                isoDate={isoDate}
                highlightedEventId={highlightedEventId}
                onEventActivate={onTimelineEventActivate}
                registerRef={(eventId, el) => {
                  if (el) evidenceRefs.current.set(eventId, el);
                  else evidenceRefs.current.delete(eventId);
                }}
              />
            ) : (
              <>
                <div className="grid grid-4" style={{ gap: 10, marginBottom: 16 }}>
                  <Tile label={t("calendar.inTime")   as string} value={detail.data.in_time?.slice(0, 5) ?? "—"} />
                  <Tile label={t("calendar.outTime")  as string} value={detail.data.out_time?.slice(0, 5) ?? "—"} />
                  <Tile label={t("calendar.total")    as string} value={detail.data.total_minutes != null ? `${(detail.data.total_minutes / 60).toFixed(1)}h` : "—"} />
                  <Tile label={t("calendar.overtime") as string} value={detail.data.overtime_minutes > 0 ? `${(detail.data.overtime_minutes / 60).toFixed(1)}h` : "—"} />
                </div>

                <Section label={t("calendar.dayTimeline") as string}>
                  <DayTimelineRibbon
                    intervals={detail.data.timeline}
                    evidence={detail.data.evidence}
                    inTime={detail.data.in_time ?? null}
                    outTime={detail.data.out_time ?? null}
                    totalMinutes={detail.data.total_minutes ?? null}
                    onEventActivate={onTimelineEventActivate}
                  />
                  {detail.data.timeline.length === 0 && (
                    <div className="text-xs text-dim" style={{ marginTop: 6 }}>
                      {t("calendar.noTimeline") as string}
                    </div>
                  )}
                </Section>

                <Section label={t("calendar.policyApplied") as string}>
                  <PolicyAppliedCard detail={detail.data} />
                </Section>

                <Section
                  label={`${t("calendar.evidence") as string}${
                    detail.data.evidence.length > 0 ? ` · ${detail.data.evidence.length}` : ""
                  }`}
                >
                  <EvidenceGallery
                    evidence={detail.data.evidence}
                    status={detail.data.status}
                    highlightedEventId={highlightedEventId}
                    isoDate={isoDate}
                    registerRef={(eventId, el) => {
                      if (el) evidenceRefs.current.set(eventId, el);
                      else evidenceRefs.current.delete(eventId);
                    }}
                  />
                </Section>
              </>
            )
          )}
        </>
      )}

      {/* EscalationDrawer portals to #drawer-root via DrawerShell — safe
          even when DayDetailContent is rendered inside another drawer. */}
      {showEscalation && isEmployee && detail.data && (
        <EscalationDrawer
          employeeCode={detail.data.employee_code}
          fullName={detail.data.full_name}
          isoDate={isoDate}
          onClose={() => setShowEscalation(false)}
          onSubmitted={onDecisionMade}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// DayDetailDrawer — thin wrapper: DrawerShell + header + DayDetailContent.
// ---------------------------------------------------------------------------

export function DayDetailDrawer({
  employeeId,
  isoDate,
  onClose,
  onSubmitException,
}: Props) {
  const { t } = useTranslation();
  // Same cache key as DayDetailContent — TanStack Query deduplicates; no
  // extra network request. Used only for the drawer header employee name.
  const detail = useDayDetail(employeeId, isoDate);

  const exportHref =
    `/api/attendance/calendar/export?month=${isoDate.slice(0, 7)}` +
    `&employee_id=${employeeId}&date=${isoDate}`;

  return (
    <DrawerShell onClose={onClose}>
      <div className="drawer">
        <div className="drawer-head">
          <div>
            <div className="mono text-xs text-dim">
              {t("calendar.dayDetail") as string}
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>
              {detail.data?.full_name ?? ""} · {isoDate}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <a className="btn btn-sm" href={exportHref} target="_blank" rel="noopener noreferrer">
              <Icon name="download" size={12} />
              {t("calendar.export") as string}
            </a>
            <button
              className="icon-btn"
              onClick={onClose}
              aria-label={t("calendar.close") as string}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        </div>

        <div className="drawer-body">
          <DayDetailContent
            employeeId={employeeId}
            isoDate={isoDate}
            onSubmitException={onSubmitException ?? null}
          />
        </div>

        {onSubmitException && (
          <div className="drawer-foot">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => onSubmitException(isoDate)}
            >
              + {t("calendar.submitException") as string}
            </button>
          </div>
        )}
      </div>
    </DrawerShell>
  );
}

// ---------------------------------------------------------------------------
// Evidence / Face Crops gallery
// ---------------------------------------------------------------------------

function EvidenceGallery({
  evidence,
  status,
  highlightedEventId,
  registerRef,
  isoDate,
}: {
  evidence: EvidenceCrop[];
  status: string;
  highlightedEventId: number | null;
  registerRef?: (eventId: number, el: HTMLDivElement | null) => void;
  isoDate: string;
}) {
  const { t } = useTranslation();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  if (evidence.length === 0) {
    return <EvidenceEmptyState status={status} />;
  }

  const bestConfidence = evidence.reduce<number | null>((acc, e) => {
    if (e.confidence == null) return acc;
    return acc == null || e.confidence > acc ? e.confidence : acc;
  }, null);

  return (
    <div>
      <AnomalyInfoBanner message="If the camera misses certain events due to camera positioning, capture limitations, lighting, or brightness conditions, those cases should be treated as possible anomalies." />

      {/* Summary line */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap", fontSize: 11.5, color: "var(--text-tertiary)" }}>
        <span>
          {t("calendar.evidenceCount", { count: evidence.length, defaultValue: `${evidence.length} face crops` })}
        </span>
        {bestConfidence != null && (
          <span>
            ·{" "}
            {t("calendar.bestConfidence", { defaultValue: "Best match" })}{" "}
            <span className="mono" style={{ color: "var(--text)", fontWeight: 600 }}>
              {(bestConfidence * 100).toFixed(0)}%
            </span>
          </span>
        )}
        <span style={{ marginInlineStart: "auto", fontSize: 11, opacity: 0.7 }}>
          {t("calendar.clickToExpand", { defaultValue: "Click any crop to preview" })}
        </span>
      </div>

      {/* Gallery grid — padding creates room for the flash ring so it
          isn't clipped by the scroll container's overflow boundary. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10, maxHeight: "55vh", overflowY: "auto", padding: "4px", margin: "-4px" }}>
        {evidence.map((ev, idx) => (
          <EvidenceCard
            key={ev.detection_event_id}
            item={ev}
            index={idx}
            total={evidence.length}
            flashing={ev.detection_event_id === highlightedEventId}
            registerRef={(el) => registerRef?.(ev.detection_event_id, el)}
            onOpen={() => setLightboxIndex(idx)}
          />
        ))}
      </div>

      {lightboxIndex != null && (
        <EvidenceLightbox
          evidence={evidence}
          initialIndex={lightboxIndex}
          isoDate={isoDate}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}

function EvidenceCard({
  item,
  index,
  total,
  flashing,
  registerRef,
  onOpen,
}: {
  item: EvidenceCrop;
  index: number;
  total: number;
  flashing: boolean;
  registerRef?: (el: HTMLDivElement | null) => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const [imgStatus, setImgStatus] = useState<"loading" | "loaded" | "broken">("loading");
  const [hovered, setHovered] = useState(false);

  const confColor = item.confidence != null
    ? item.confidence >= 0.75 ? "var(--success-text, #1a7a4a)" : item.confidence >= 0.5 ? "var(--warning-text, #92500a)" : "var(--danger-text, #a12b2b)"
    : undefined;

  return (
    <div
      ref={registerRef}
      data-event-id={item.detection_event_id}
      style={{
        position: "relative",
        border: `2px solid ${flashing ? "var(--accent)" : hovered ? "var(--border-hover, var(--border))" : "var(--border)"}`,
        borderRadius: 12,
        overflow: "hidden",
        background: "var(--bg-elev)",
        boxShadow: flashing
          ? "0 0 0 4px var(--accent), 0 4px 18px rgba(0,0,0,0.18)"
          : hovered ? "0 6px 20px rgba(0,0,0,0.12)" : "var(--shadow-sm)",
        transition: flashing
          ? "none"
          : "box-shadow 180ms ease, border-color 180ms ease, transform 150ms ease",
        transform: flashing ? "scale(1.04)" : hovered ? "translateY(-3px)" : "scale(1)",
        zIndex: flashing ? 2 : "auto",
        display: "flex",
        flexDirection: "column",
        cursor: "pointer",
        animation: flashing ? "evidenceFlash 0.35s ease-out forwards" : "none",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${t("calendar.openEvidence", { defaultValue: "Open larger view" })} — ${item.captured_at.slice(0, 5)} ${item.camera_code}`}
        style={{ position: "relative", width: "100%", aspectRatio: "3 / 4", background: "var(--bg-sunken)", border: "none", padding: 0, margin: 0, cursor: "pointer", display: "block", overflow: "hidden" }}
      >
        {imgStatus !== "broken" && (
          <img
            src={item.crop_url}
            alt={`${item.captured_at} ${item.camera_code}`}
            loading="lazy"
            onLoad={() => setImgStatus("loaded")}
            onError={() => setImgStatus("broken")}
            style={{ display: "block", width: "100%", height: "100%", objectFit: "cover", opacity: imgStatus === "loaded" ? 1 : 0, transition: "opacity 160ms ease" }}
          />
        )}
        {imgStatus === "loading" && (
          <div aria-hidden style={{ position: "absolute", inset: 0, background: "linear-gradient(90deg, var(--bg-sunken) 0%, var(--bg-hover) 50%, var(--bg-sunken) 100%)", backgroundSize: "200% 100%", animation: "evidenceShimmer 1.2s linear infinite" }} />
        )}
        {imgStatus === "broken" && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "var(--text-tertiary)", fontSize: 10.5, textAlign: "center", padding: 8, gap: 4 }}>
            <Icon name="info" size={18} />
            <span>{t("calendar.evidenceUnavailable", { defaultValue: "Crop unavailable" }) as string}</span>
          </div>
        )}

        {/* Confidence chip */}
        {item.confidence != null && (
          <span className="mono" style={{ position: "absolute", top: 7, insetInlineEnd: 7, background: "rgba(0,0,0,0.62)", color: "#fff", fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 20, backdropFilter: "blur(3px)", letterSpacing: "0.02em" }}>
            {(item.confidence * 100).toFixed(0)}%
          </span>
        )}

        {/* Hover expand overlay */}
        <div aria-hidden style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.28)", display: "grid", placeItems: "center", opacity: hovered ? 1 : 0, transition: "opacity 160ms ease" }}>
          <div style={{ width: 40, height: 40, borderRadius: "50%", background: "rgba(255,255,255,0.22)", border: "1.5px solid rgba(255,255,255,0.5)", display: "grid", placeItems: "center", color: "#fff", backdropFilter: "blur(4px)" }}>
            <Icon name="search" size={16} />
          </div>
        </div>

        {/* Bottom gradient + time/camera */}
        <div aria-hidden style={{ position: "absolute", insetInline: 0, bottom: 0, height: 60, background: "linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.68) 100%)", pointerEvents: "none" }} />
        <div style={{ position: "absolute", insetInline: 8, bottom: 7, color: "#fff", textShadow: "0 1px 3px rgba(0,0,0,0.7)" }}>
          <div className="mono" style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.2 }}>{item.captured_at.slice(0, 5)}</div>
          <div style={{ fontSize: 10.5, opacity: 0.9, lineHeight: 1.2, display: "flex", alignItems: "center", gap: 3 }}>
            <Icon name="camera" size={9} />
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.camera_code}</span>
          </div>
        </div>
      </button>

      {/* Footer strip */}
      <div style={{ padding: "6px 10px", display: "flex", alignItems: "center", justifyContent: "space-between", borderTop: "1px solid var(--border)", background: "var(--bg)", flexShrink: 0 }}>
        <span className="mono" style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{index + 1}/{total}</span>
        {item.confidence != null ? (
          <span style={{ fontSize: 10, fontWeight: 700, color: confColor }}>{(item.confidence * 100).toFixed(0)}% match</span>
        ) : (
          <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>—</span>
        )}
      </div>

      <style>{`
        @keyframes evidenceShimmer {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @keyframes evidenceFlash {
          0%   { transform: scale(1);    box-shadow: 0 0 0 0   var(--accent), 0 4px 18px rgba(0,0,0,0.18); border-color: var(--accent); }
          40%  { transform: scale(1.06); box-shadow: 0 0 0 6px var(--accent), 0 6px 24px rgba(0,0,0,0.22); border-color: var(--accent); }
          100% { transform: scale(1.04); box-shadow: 0 0 0 4px var(--accent), 0 4px 18px rgba(0,0,0,0.18); border-color: var(--accent); }
        }
      `}</style>
    </div>
  );
}

// Split-panel lightbox for evidence face crops.
// Portals out of .drawer to escape its fixed containing block.
function EvidenceLightbox({
  evidence,
  initialIndex,
  isoDate,
  onClose,
}: {
  evidence: EvidenceCrop[];
  initialIndex: number;
  isoDate: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [idx, setIdx] = useState(initialIndex);
  const total = evidence.length;
  const item = evidence[idx]!;

  const prev = () => setIdx((i) => (i - 1 + total) % total);
  const next = () => setIdx((i) => (i + 1) % total);

  useEffectOnMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); prev(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); next(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  });

  const timeStr = item.captured_at.length >= 8 ? item.captured_at.slice(0, 8) : item.captured_at;
  const confPct = item.confidence != null ? `${(item.confidence * 100).toFixed(1)}%` : null;
  const confBarColor = item.confidence != null
    ? item.confidence >= 0.75 ? "var(--success-text, #1a7a4a)" : item.confidence >= 0.5 ? "var(--warning-text, #92500a)" : "var(--danger-text, #a12b2b)"
    : "var(--accent)";

  const portalTarget = typeof document !== "undefined"
    ? (document.getElementById("drawer-root") ?? document.body)
    : null;

  const modal = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("calendar.lightboxAria", { defaultValue: "Face crop preview" }) as string}
      style={{ position: "fixed", inset: 0, zIndex: 100000, background: "rgba(0,0,0,0.78)", display: "grid", placeItems: "center", padding: 24 }}
      onClick={onClose}
    >
      {/* Card — click inside doesn't close */}
      <div
        style={{ display: "flex", width: "min(860px, 95vw)", maxHeight: "90vh", borderRadius: 16, overflow: "hidden", boxShadow: "0 32px 80px rgba(0,0,0,0.6)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Left: dark image pane ── */}
        <div style={{ flex: 1, minWidth: 0, background: "#0d0d0d", display: "flex", flexDirection: "column", position: "relative", overflow: "hidden" }}>
          {/* Image stage */}
          <div style={{ flex: 1, minHeight: 0, display: "grid", placeItems: "center", padding: "32px 52px 12px" }}>
            <img
              key={item.detection_event_id}
              src={item.crop_url}
              alt={`${timeStr} ${item.camera_code}`}
              style={{ maxWidth: "100%", maxHeight: "calc(90vh - 140px)", width: "auto", height: "auto", objectFit: "contain", borderRadius: 10, boxShadow: "0 8px 32px rgba(0,0,0,0.6)", display: "block" }}
            />
          </div>

          {/* Prev / Next arrows */}
          {total > 1 && (
            <>
              <button type="button" onClick={prev} aria-label={t("calendar.lightboxPrev", { defaultValue: "Previous" }) as string}
                style={{ position: "absolute", insetInlineStart: 10, top: "50%", transform: "translateY(-50%)", width: 40, height: 40, borderRadius: "50%", border: "1.5px solid rgba(255,255,255,0.25)", background: "rgba(0,0,0,0.45)", color: "#fff", cursor: "pointer", display: "grid", placeItems: "center", fontSize: 20, lineHeight: 1 }}>
                ‹
              </button>
              <button type="button" onClick={next} aria-label={t("calendar.lightboxNext", { defaultValue: "Next" }) as string}
                style={{ position: "absolute", insetInlineEnd: 10, top: "50%", transform: "translateY(-50%)", width: 40, height: 40, borderRadius: "50%", border: "1.5px solid rgba(255,255,255,0.25)", background: "rgba(0,0,0,0.45)", color: "#fff", cursor: "pointer", display: "grid", placeItems: "center", fontSize: 20, lineHeight: 1 }}>
                ›
              </button>
            </>
          )}

          {/* Counter badge */}
          <div className="mono" style={{ position: "absolute", bottom: total > 1 ? 68 : 12, left: "50%", transform: "translateX(-50%)", background: "rgba(0,0,0,0.5)", color: "rgba(255,255,255,0.85)", padding: "3px 14px", borderRadius: 999, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
            {idx + 1} / {total}
          </div>

          {/* Filmstrip — only when >1 crop */}
          {total > 1 && (
            <div style={{ display: "flex", gap: 6, padding: "8px 14px", overflowX: "auto", background: "rgba(0,0,0,0.5)", borderTop: "1px solid rgba(255,255,255,0.08)", flexShrink: 0, alignItems: "center" }}>
              {evidence.map((ev, i) => (
                <button
                  key={ev.detection_event_id}
                  type="button"
                  onClick={() => setIdx(i)}
                  aria-label={`Crop ${i + 1}`}
                  style={{ width: 46, height: 54, flexShrink: 0, padding: 0, border: i === idx ? "2.5px solid var(--accent)" : "2px solid rgba(255,255,255,0.12)", borderRadius: 7, overflow: "hidden", cursor: "pointer", background: "#111", opacity: i === idx ? 1 : 0.5, transition: "opacity 150ms, border-color 150ms", transform: i === idx ? "scale(1.08)" : "scale(1)", outline: "none" }}
                >
                  <img src={ev.crop_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ── Right: metadata pane ── */}
        <div style={{ width: 280, flexShrink: 0, background: "var(--bg)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {/* Header */}
          <div style={{ padding: "12px 14px 10px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
            <span className="pill pill-neutral" style={{ fontSize: 10.5, fontWeight: 700, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              <Icon name="camera" size={9} /> {item.camera_code}
            </span>
            <div style={{ flex: 1 }} />
            <button type="button" onClick={onClose} aria-label={t("calendar.lightboxClose", { defaultValue: "Close preview" }) as string}
              style={{ width: 28, height: 28, borderRadius: "50%", border: "1px solid var(--border)", background: "transparent", cursor: "pointer", display: "grid", placeItems: "center", color: "var(--text)", flexShrink: 0 }}>
              <Icon name="x" size={13} />
            </button>
          </div>

          {/* Capture time — large display */}
          <div style={{ padding: "16px 16px 0", flexShrink: 0 }}>
            <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-tertiary)", marginBottom: 4 }}>
              {t("calendar.captureTime", { defaultValue: "Capture time" })}
            </div>
            <div className="mono" style={{ fontSize: 26, fontWeight: 800, color: "var(--text)", lineHeight: 1.1, letterSpacing: "-0.01em" }}>
              {item.captured_at.slice(0, 5)}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary, var(--text-tertiary))", marginTop: 2 }}>
              {isoDate}
            </div>
          </div>

          {/* Confidence bar */}
          {item.confidence != null && (
            <div style={{ padding: "14px 16px 0", flexShrink: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-tertiary)", marginBottom: 5 }}>
                <span>{t("calendar.matchConfidence", { defaultValue: "Match confidence" })}</span>
                <span className="mono" style={{ fontWeight: 700, color: "var(--text)" }}>{confPct}</span>
              </div>
              <div style={{ height: 7, borderRadius: 4, background: "var(--border)", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.min(100, (item.confidence ?? 0) * 100)}%`, background: confBarColor, borderRadius: 4, transition: "width 350ms ease" }} />
              </div>
            </div>
          )}

          {/* Metadata grid */}
          <div style={{ padding: "14px 16px 0", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, overflowY: "auto", flex: 1 }}>
            <EvidenceMetaCard label={t("calendar.meta.camera", { defaultValue: "Camera" })} value={item.camera_code} />
            <EvidenceMetaCard label={t("calendar.meta.eventId", { defaultValue: "Event ID" })} value={`#${item.detection_event_id}`} />
            <EvidenceMetaCard label={t("calendar.meta.seconds", { defaultValue: "Full time" })} value={timeStr} />
            <EvidenceMetaCard label={t("calendar.meta.confidence", { defaultValue: "Confidence" })} value={confPct ?? "—"} />
          </div>

          {/* Keyboard hint */}
          <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--text-tertiary)", flexShrink: 0, lineHeight: 1.5 }}>
            {t("calendar.lightboxHint", { defaultValue: "← → to navigate · Esc to close" })}
          </div>
        </div>
      </div>
    </div>
  );

  return portalTarget ? createPortal(modal, portalTarget) : modal;
}

function EvidenceMetaCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", background: "var(--bg-elev)" }}>
      <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-tertiary)", marginBottom: 4 }}>
        {label}
      </div>
      <div className="mono" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", wordBreak: "break-all" }}>
        {value}
      </div>
    </div>
  );
}

/** Tiny helper — equivalent of useEffect with no deps, but
 *  expressed in a way that doesn't trigger
 *  ``react-hooks/exhaustive-deps`` for a deliberately mount-only
 *  effect. Local to this file. */
function useEffectOnMount(fn: () => void | (() => void)): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffectStub(() => fnRef.current());
}

// Re-export React's useEffect under a private name to satisfy
// `useEffectOnMount`. Avoids polluting the imports — the file
// otherwise doesn't need useEffect directly.
// eslint-disable-next-line react-hooks/rules-of-hooks
const useEffectStub: typeof useEffect = useEffect;

function EvidenceEmptyState({ status }: { status: string }) {
  const { t } = useTranslation();

  // Status-specific empty copy. The fallback is the original
  // generic "no crops" line so an unrecognised status still gets
  // a sensible message instead of a dangling key.
  const copy: { title: string; sub: string; icon: "info" | "calendar" | "clock" } = (() => {
    switch (status) {
      case "present":
      case "late":
        return {
          icon: "info",
          title: t("calendar.emptyEvidencePresent.title", {
            defaultValue: "No face crops retained for this day",
          }) as string,
          sub: t("calendar.emptyEvidencePresent.sub", {
            defaultValue:
              "Crops may have been swept by the retention policy. Detection events are still recorded.",
          }) as string,
        };
      case "absent":
        return {
          icon: "info",
          title: t("calendar.emptyEvidenceAbsent.title", {
            defaultValue: "No face was captured",
          }) as string,
          sub: t("calendar.emptyEvidenceAbsent.sub", {
            defaultValue:
              "No detection events were recorded on this date.",
          }) as string,
        };
      case "waiting":
        return {
          icon: "clock",
          title: t("calendar.emptyEvidenceWaiting.title", {
            defaultValue: "Awaiting completion of the day",
          }) as string,
          sub: t("calendar.emptyEvidenceWaiting.sub", {
            defaultValue:
              "Face crops appear here as detections come in.",
          }) as string,
        };
      case "leave":
        return {
          icon: "calendar",
          title: t("calendar.emptyEvidenceLeave.title", {
            defaultValue: "Marked as leave",
          }) as string,
          sub: t("calendar.emptyEvidenceLeave.sub", {
            defaultValue: "No face captures expected for this day.",
          }) as string,
        };
      case "holiday":
        return {
          icon: "calendar",
          title: t("calendar.emptyEvidenceHoliday.title", {
            defaultValue: "Marked as holiday",
          }) as string,
          sub: t("calendar.emptyEvidenceHoliday.sub", {
            defaultValue: "No face captures expected for this day.",
          }) as string,
        };
      case "weekend":
        return {
          icon: "calendar",
          title: t("calendar.emptyEvidenceWeekend.title", {
            defaultValue: "Weekend",
          }) as string,
          sub: t("calendar.emptyEvidenceWeekend.sub", {
            defaultValue: "No face captures expected for this day.",
          }) as string,
        };
      case "future":
        return {
          icon: "calendar",
          title: t("calendar.emptyEvidenceFuture.title", {
            defaultValue: "Future date",
          }) as string,
          sub: t("calendar.emptyEvidenceFuture.sub", {
            defaultValue:
              "Face crops will appear here after detections are captured.",
          }) as string,
        };
      default:
        return {
          icon: "info",
          title: t("calendar.emptyEvidenceGeneric.title", {
            defaultValue: "No face crops to show",
          }) as string,
          sub: t("calendar.emptyEvidenceGeneric.sub", {
            defaultValue:
              "Either no detections were captured, or this day has no attendance record.",
          }) as string,
        };
    }
  })();

  return (
    <div
      style={{
        border: "1px dashed var(--border)",
        borderRadius: 10,
        padding: 16,
        background: "var(--bg-sunken)",
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
      }}
    >
      <div
        aria-hidden
        style={{
          width: 36,
          height: 36,
          flexShrink: 0,
          borderRadius: "50%",
          background: "var(--bg-elev)",
          display: "grid",
          placeItems: "center",
          color: "var(--text-tertiary)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <Icon name={copy.icon} size={16} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--text)",
            marginBottom: 2,
          }}
        >
          {copy.title}
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-tertiary)",
            lineHeight: 1.5,
          }}
        >
          {copy.sub}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Late breakdown card — rendered above summary tiles when status === "late"
// ---------------------------------------------------------------------------

function LateBreakdownCard({ detail }: { detail: DayDetail }) {
  const { t } = useTranslation();

  // Determine the reference "expected" time and label.
  // Fixed / Ramadan / Custom-Fixed → policy_shift_start (+ grace)
  // Flex → policy_in_window_end (last moment to arrive without being late)
  const isFlexType =
    detail.policy_type === "Flex" ||
    (detail.policy_type === "Custom" &&
      detail.policy_custom_inner_type === "Flex");

  const expectedTime: string | null = isFlexType
    ? (detail.policy_in_window_end ?? null)
    : (detail.policy_shift_start ?? null);

  const graceMinutes = isFlexType ? 0 : (detail.policy_grace_minutes ?? 0);

  const lateByMins =
    detail.in_time && expectedTime
      ? calcLateMinutes(detail.in_time, expectedTime, graceMinutes)
      : null;

  // Always show the card for late status even when we can't compute
  // late-by (policy data missing) — the arrival time alone is useful.
  const showExpected = expectedTime != null;
  const showLateBy = lateByMins != null && lateByMins > 0;

  const friendlyTime = (hhmm: string | null | undefined): string => {
    if (!hhmm) return "—";
    const parts = hhmm.split(":");
    const h = parseInt(parts[0] ?? "", 10);
    const m = parts[1] ?? "00";
    if (Number.isNaN(h)) return hhmm.slice(0, 5);
    const suffix = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${m} ${suffix}`;
  };

  // Grace suffix shown on the expected-time tile for Fixed-type policies
  // so the reader immediately understands the grace window.
  const graceLabel =
    !isFlexType && graceMinutes > 0
      ? ` + ${graceMinutes}${t("calendar.minutesShort", { defaultValue: "min" }) as string} grace`
      : null;

  return (
    <div
      style={{
        background: "var(--warning-soft)",
        border: "1px solid var(--warning)",
        borderRadius: 12,
        padding: "14px 16px",
        marginBottom: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Icon name="clock" size={14} style={{ color: "var(--warning-text)" }} />
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--warning-text)",
          }}
        >
          {t("calendar.lateBreakdown.title", {
            defaultValue: "Late arrival details",
          }) as string}
        </span>
      </div>

      {/* Three-column grid: Expected / Arrived / Late By */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: showExpected && showLateBy
            ? "1fr 1fr 1fr"
            : showExpected || showLateBy
              ? "1fr 1fr"
              : "1fr",
          gap: 8,
        }}
      >
        {showExpected && (
          <LateFactTile
            label={
              isFlexType
                ? (t("calendar.lateBreakdown.mustArriveBy", {
                    defaultValue: "Must arrive by",
                  }) as string)
                : (t("calendar.lateBreakdown.expectedIn", {
                    defaultValue: "Expected in-time",
                  }) as string)
            }
            value={friendlyTime(expectedTime)}
            sub={graceLabel}
            highlight={false}
          />
        )}

        <LateFactTile
          label={
            t("calendar.lateBreakdown.arrivedAt", {
              defaultValue: "Employee arrived",
            }) as string
          }
          value={friendlyTime(detail.in_time)}
          highlight
        />

        {showLateBy && (
          <LateFactTile
            label={
              t("calendar.lateBreakdown.lateBy", {
                defaultValue: "Late by",
              }) as string
            }
            value={`+ ${fmtMinutes(lateByMins)}`}
            danger
          />
        )}
      </div>
    </div>
  );
}

function LateFactTile({
  label,
  value,
  sub,
  highlight = false,
  danger = false,
}: {
  label: string;
  value: string;
  sub?: string | null;
  highlight?: boolean;
  danger?: boolean;
}) {
  const fg = danger
    ? "var(--danger-text)"
    : highlight
      ? "var(--warning-text)"
      : "var(--text)";
  return (
    <div
      style={{
        background: "var(--bg-elev)",
        borderRadius: 9,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--text-tertiary)",
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div
        className="mono"
        style={{
          fontSize: 14,
          fontWeight: 700,
          color: fg,
          lineHeight: 1,
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>
          {sub}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Policy applied card
// ---------------------------------------------------------------------------

const SHIFT_TYPE_ACCENT: Record<string, { bg: string; fg: string }> = {
  Fixed: { bg: "#E8F0FE", fg: "#1B4F8C" },
  Flex: { bg: "#E7F6EC", fg: "#1F6B3F" },
  Ramadan: { bg: "#FDEEDC", fg: "#9A4E14" },
  Custom: { bg: "#EDE7F6", fg: "#4A2E83" },
};

/** Format an ISO ``YYYY-MM-DD`` to a friendly short date in the
 *  browser locale — e.g. "13 Feb 2026". Falls back to the raw
 *  string when parsing fails. */
function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}


function PolicyAppliedCard({ detail }: { detail: DayDetail }) {
  const { t } = useTranslation();

  if (!detail.policy_name) {
    return (
      <div
        style={{
          padding: 12,
          border: "1px dashed var(--border)",
          borderRadius: 10,
          color: "var(--text-tertiary)",
          fontSize: 12.5,
        }}
      >
        {t("calendar.noPolicy", {
          defaultValue: "No policy applied for this day.",
        }) as string}
      </div>
    );
  }

  const layoutType: "Fixed" | "Flex" =
    detail.policy_type === "Custom"
      ? detail.policy_custom_inner_type === "Flex"
        ? "Flex"
        : "Fixed"
      : detail.policy_type === "Flex"
        ? "Flex"
        : "Fixed";

  const typeKey = detail.policy_type ?? "Fixed";
  const accent = SHIFT_TYPE_ACCENT[typeKey] ?? SHIFT_TYPE_ACCENT["Fixed"]!;

  const isDefault = ["tenant-default", "legacy"].includes(
    (detail.policy_scope ?? "").toLowerCase(),
  );

  const dateRangeLabel =
    detail.policy_range_start || detail.policy_range_end
      ? `${formatShortDate(detail.policy_range_start)} – ${formatShortDate(
          detail.policy_range_end,
        )}`
      : null;

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 12,
        background: "var(--bg-elev)",
        boxShadow: "var(--shadow-sm)",
        overflow: "hidden",
      }}
    >
      {/* Header — policy name + type badge + DEFAULT badge */}
      <div style={{ padding: "14px 16px 0 16px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              fontSize: 17,
              fontWeight: 700,
              color: "var(--text)",
              lineHeight: 1.3,
              wordBreak: "break-word",
            }}
          >
            {detail.policy_name}
          </span>
          <span
            style={{
              background: accent.bg,
              color: accent.fg,
              padding: "3px 9px",
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.02em",
              whiteSpace: "nowrap",
            }}
          >
            {typeKey}
          </span>
          {isDefault && (
            <span
              style={{
                background: accent.bg,
                color: accent.fg,
                padding: "3px 9px",
                borderRadius: 999,
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                whiteSpace: "nowrap",
              }}
            >
              {t("calendar.policyDefault", { defaultValue: "Default" }) as string}
            </span>
          )}
        </div>
        {/* "Must complete X hours" subtitle */}
        <div
          style={{
            fontSize: 12.5,
            color: "var(--text-tertiary)",
            marginTop: 5,
            marginBottom: 14,
          }}
        >
          {detail.policy_required_hours != null
            ? t("calendar.mustComplete", {
                hours: detail.policy_required_hours,
                defaultValue: `Must complete ${detail.policy_required_hours} hours`,
              })
            : t("calendar.policyApplied", { defaultValue: "Policy applied" })}
        </div>
      </div>

      <div style={{ padding: "0 16px 16px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Date range (Ramadan / Custom only) */}
        {dateRangeLabel && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "var(--bg-sunken)",
              padding: "8px 10px",
              borderRadius: 8,
              fontSize: 12.5,
              color: "var(--text-secondary)",
            }}
          >
            <Icon name="calendar" size={12} />
            <span style={{ fontWeight: 500 }}>
              {t("calendar.policyActiveRange", { defaultValue: "Active range" }) as string}:
            </span>
            <span>{dateRangeLabel}</span>
          </div>
        )}

        {/* SHIFT WINDOW section label + ribbon */}
        <div>
          <div
            style={{
              fontSize: 10.5,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--text-tertiary)",
              marginBottom: 8,
            }}
          >
            {t("calendar.shiftWindowLabel", { defaultValue: "Shift window" }) as string}
          </div>
          <PolicyShiftRibbon detail={detail} layoutType={layoutType} />
        </div>

        {/* Optional description */}
        {detail.policy_description && (
          <div
            style={{
              fontSize: 12.5,
              color: "var(--text-secondary)",
              lineHeight: 1.5,
              paddingTop: 4,
              borderTop: "1px dashed var(--border)",
            }}
          >
            {detail.policy_description}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PolicyShiftRibbon — visual timeline strip (06:00–20:00) showing shift bands
// ---------------------------------------------------------------------------

function PolicyShiftRibbon({
  detail,
  layoutType,
}: {
  detail: DayDetail;
  layoutType: "Fixed" | "Flex";
}) {
  const HOURS_START = 6;
  const HOURS_END = 20;
  const TOTAL_MIN = (HOURS_END - HOURS_START) * 60;

  const minutesOf = (hhmm: string | null | undefined): number | null => {
    if (!hhmm) return null;
    const parts = hhmm.split(":");
    const h = parseInt(parts[0] ?? "", 10);
    const m = parseInt(parts[1] ?? "0", 10);
    if (isNaN(h) || isNaN(m)) return null;
    return h * 60 + m;
  };

  const pct = (mm: number) =>
    Math.max(0, Math.min(100, ((mm - HOURS_START * 60) / TOTAL_MIN) * 100));

  type Band = {
    label: string;
    start: number;
    end: number;
    fill: string;
    accent?: boolean;
  };
  const bands: Band[] = [];

  if (layoutType === "Flex") {
    const inS = minutesOf(detail.policy_in_window_start);
    const inE = minutesOf(detail.policy_in_window_end);
    const outS = minutesOf(detail.policy_out_window_start);
    const outE = minutesOf(detail.policy_out_window_end);
    if (inS !== null && inE !== null) {
      bands.push({ label: "arrive", start: inS, end: inE, fill: "var(--info-soft)" });
    }
    if (inE !== null && outS !== null && inE < outS) {
      bands.push({
        label: `${detail.policy_required_hours ?? 8}h work`,
        start: inE,
        end: outS,
        fill: "var(--accent-soft)",
        accent: true,
      });
    }
    if (outS !== null && outE !== null) {
      bands.push({ label: "depart", start: outS, end: outE, fill: "var(--info-soft)" });
    }
  } else {
    const s = minutesOf(detail.policy_shift_start);
    const e = minutesOf(detail.policy_shift_end);
    if (s !== null && e !== null) {
      bands.push({
        label: `${detail.policy_required_hours ?? 8}h shift`,
        start: s,
        end: e,
        fill: "var(--accent-soft)",
        accent: true,
      });
    }
  }

  const tickHours = [6, 8, 10, 12, 14, 16, 18, 20];

  return (
    <div
      style={{
        position: "relative",
        height: 56,
        background: "var(--bg-sunken)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        overflow: "hidden",
      }}
      aria-hidden
    >
      {/* Hour grid ticks */}
      {Array.from({ length: HOURS_END - HOURS_START + 1 }).map((_, i) => {
        const hour = HOURS_START + i;
        const left = (i / (HOURS_END - HOURS_START)) * 100;
        return (
          <div
            key={hour}
            style={{
              position: "absolute",
              insetInlineStart: `${left}%`,
              top: 0,
              bottom: 16,
              width: 1,
              background: "var(--border)",
              opacity: hour % 2 === 0 ? 0.6 : 0.2,
            }}
          />
        );
      })}
      {/* Colored shift bands */}
      {bands.map((b, i) => {
        const left = pct(b.start);
        const width = pct(b.end) - left;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              insetInlineStart: `${left}%`,
              width: `${width}%`,
              top: 6,
              bottom: 20,
              background: b.fill,
              border: b.accent
                ? "1px solid var(--accent)"
                : "1px solid transparent",
              borderRadius: 4,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 10.5,
              color: b.accent ? "var(--accent-text)" : "var(--text-secondary)",
              fontWeight: 500,
              overflow: "hidden",
              whiteSpace: "nowrap",
            }}
          >
            {b.label}
          </div>
        );
      })}
      {/* Hour labels along the bottom */}
      <div
        style={{
          position: "absolute",
          insetInlineStart: 0,
          insetInlineEnd: 0,
          bottom: 3,
          display: "flex",
          justifyContent: "space-between",
          fontSize: 9,
          color: "var(--text-tertiary)",
          fontFamily: "var(--font-mono)",
          padding: "0 2px",
        }}
      >
        {tickHours.map((h) => (
          <span key={h}>{String(h).padStart(2, "0")}:00</span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Week Off day content — dedicated UI for weekend status
// ---------------------------------------------------------------------------

// All 7 canonical weekday names in ISO order (Monday-first).
const ISO_WEEK_DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

// Short abbreviations for the weekly schedule strip.
const DAY_ABBR: Record<string, string> = {
  Monday: "Mon",
  Tuesday: "Tue",
  Wednesday: "Wed",
  Thursday: "Thu",
  Friday: "Fri",
  Saturday: "Sat",
  Sunday: "Sun",
};

function WeekOffDayContent({
  detail,
  isoDate,
  highlightedEventId,
  onEventActivate,
  registerRef,
}: {
  detail: import("./types").DayDetail;
  isoDate: string;
  highlightedEventId: number | null;
  onEventActivate: (eventId: number) => void;
  registerRef: (eventId: number, el: HTMLDivElement | null) => void;
}) {
  const { t } = useTranslation();

  const workedOnWeekOff =
    detail.in_time != null ||
    (detail.total_minutes != null && detail.total_minutes > 0) ||
    detail.timeline.length > 0;

  // Day-of-week name derived from the ISO date string (locale-independent
  // — we pass `en-US` for the comparison set only; display uses default).
  const dayName = (() => {
    try {
      return new Date(`${isoDate}T00:00:00`).toLocaleDateString(undefined, {
        weekday: "long",
      });
    } catch {
      return isoDate;
    }
  })();

  // Canonical English name of this day (used for schedule strip matching).
  const currentDayEn = (() => {
    try {
      return new Date(`${isoDate}T00:00:00`).toLocaleDateString("en-US", {
        weekday: "long",
      });
    } catch {
      return "";
    }
  })();

  const offDaySet = new Set(
    (detail.weekend_days ?? []).map((d) => d.toLowerCase()),
  );
  const offDayCount = offDaySet.size;

  // Weekly schedule strip — Mon … Sun with current day and off-day marking.
  const weeklyStrip = (
    <div style={{ display: "flex", gap: 6 }}>
      {ISO_WEEK_DAYS.map((day) => {
        const isOff = offDaySet.has(day.toLowerCase());
        const isCurrent = day.toLowerCase() === currentDayEn.toLowerCase();
        const abbr = DAY_ABBR[day] ?? day.slice(0, 3);

        return (
          <div
            key={day}
            title={day}
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
              padding: "8px 4px 7px",
              borderRadius: 8,
              border: isCurrent
                ? "2px solid var(--accent)"
                : "1px solid var(--border)",
              background: isCurrent
                ? "var(--accent-soft)"
                : isOff
                  ? "var(--bg-sunken)"
                  : "var(--bg-elev)",
              transition: "none",
            }}
          >
            {/* Day abbreviation */}
            <span
              style={{
                fontSize: 10.5,
                fontWeight: isCurrent ? 700 : 500,
                color: isCurrent
                  ? "var(--accent-text)"
                  : "var(--text-secondary)",
                textTransform: "uppercase",
                letterSpacing: "0.03em",
                lineHeight: 1,
              }}
            >
              {abbr}
            </span>
            {/* Status indicator dot */}
            <span
              aria-hidden
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: isOff
                  ? isCurrent
                    ? "var(--accent)"
                    : "var(--text-tertiary)"
                  : "var(--success)",
                opacity: isCurrent ? 1 : 0.65,
              }}
            />
            {/* Work / Off label */}
            <span
              style={{
                fontSize: 9.5,
                fontWeight: 600,
                color: isOff
                  ? isCurrent
                    ? "var(--accent-text)"
                    : "var(--text-tertiary)"
                  : "var(--success-text)",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                lineHeight: 1,
              }}
            >
              {isOff
                ? t("calendar.weekOff.stripOff", { defaultValue: "Off" })
                : t("calendar.weekOff.stripWork", { defaultValue: "Work" })}
            </span>
          </div>
        );
      })}
    </div>
  );

  // ── Pure rest day (no detections) ─────────────────────────────────────────
  if (!workedOnWeekOff) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

        {/* Status card with accent top bar */}
        <div
          style={{
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            overflow: "hidden",
          }}
        >
          {/* Accent stripe */}
          <div
            aria-hidden
            style={{ height: 4, background: "var(--info)", opacity: 0.7 }}
          />
          <div
            style={{
              padding: "16px 18px 18px",
              display: "flex",
              gap: 14,
              alignItems: "flex-start",
            }}
          >
            {/* Icon */}
            <div
              aria-hidden
              style={{
                width: 42,
                height: 42,
                borderRadius: 10,
                background: "var(--info-soft)",
                border: "1px solid var(--info)",
                display: "grid",
                placeItems: "center",
                flexShrink: 0,
                fontSize: 20,
              }}
            >
              🗓
            </div>

            {/* Text */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 700,
                  color: "var(--text)",
                  marginBottom: 4,
                }}
              >
                {t("calendar.weekOff.title", {
                  defaultValue: "Official Week Off",
                }) as string}
              </div>
              <div
                style={{
                  fontSize: 12.5,
                  color: "var(--text-secondary)",
                  lineHeight: 1.55,
                }}
              >
                {t("calendar.weekOff.subtitle", {
                  day: dayName,
                  defaultValue: `${dayName} is a scheduled weekly off day. No attendance is expected today.`,
                }) as string}
              </div>
            </div>

            {/* Badge */}
            <span
              style={{
                padding: "3px 10px",
                borderRadius: 999,
                fontSize: 11,
                fontWeight: 700,
                background: "var(--info-soft)",
                color: "var(--info-text)",
                border: "1px solid var(--info)",
                flexShrink: 0,
                whiteSpace: "nowrap",
              }}
            >
              {t("calendar.weekOff.badge", {
                defaultValue: "Week Off",
              }) as string}
            </span>
          </div>
        </div>

        {/* Summary stat tiles */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 10,
          }}
        >
          {/* Off days per week */}
          <div
            style={{
              padding: "10px 12px",
              background: "var(--bg-sunken)",
              borderRadius: 8,
              border: "1px solid var(--border)",
            }}
          >
            <div
              className="text-xs text-dim"
              style={{
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                fontWeight: 500,
                marginBottom: 4,
              }}
            >
              {t("calendar.weekOff.statOffDays", {
                defaultValue: "Off days / week",
              }) as string}
            </div>
            <div
              className="mono"
              style={{
                fontSize: 22,
                fontWeight: 700,
                color: "var(--text)",
                lineHeight: 1,
              }}
            >
              {offDayCount}
            </div>
            <div
              className="text-xs text-dim"
              style={{ marginTop: 3 }}
            >
              {t("calendar.weekOff.statWorkDays", {
                count: 7 - offDayCount,
                defaultValue: `${7 - offDayCount} working days`,
              }) as string}
            </div>
          </div>

          {/* Today */}
          <div
            style={{
              padding: "10px 12px",
              background: "var(--accent-soft)",
              borderRadius: 8,
              border: "1px solid var(--accent)",
            }}
          >
            <div
              className="text-xs"
              style={{
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                fontWeight: 500,
                marginBottom: 4,
                color: "var(--accent-text)",
              }}
            >
              {t("calendar.weekOff.statToday", {
                defaultValue: "Today",
              }) as string}
            </div>
            <div
              style={{
                fontSize: 15,
                fontWeight: 700,
                color: "var(--accent-text)",
                lineHeight: 1,
              }}
            >
              {dayName}
            </div>
            <div
              className="mono text-xs"
              style={{ marginTop: 3, color: "var(--accent-text)", opacity: 0.75 }}
            >
              {isoDate}
            </div>
          </div>

          {/* Detections */}
          <div
            style={{
              padding: "10px 12px",
              background: "var(--bg-sunken)",
              borderRadius: 8,
              border: "1px solid var(--border)",
            }}
          >
            <div
              className="text-xs text-dim"
              style={{
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                fontWeight: 500,
                marginBottom: 4,
              }}
            >
              {t("calendar.weekOff.statDetections", {
                defaultValue: "Detections",
              }) as string}
            </div>
            <div
              className="mono"
              style={{
                fontSize: 22,
                fontWeight: 700,
                color: "var(--text-tertiary)",
                lineHeight: 1,
              }}
            >
              0
            </div>
            <div className="text-xs text-dim" style={{ marginTop: 3 }}>
              {t("calendar.weekOff.statNoActivity", {
                defaultValue: "No activity recorded",
              }) as string}
            </div>
          </div>
        </div>

        {/* Weekly schedule strip */}
        <Section
          label={
            t("calendar.weekOff.weeklySchedule", {
              defaultValue: "Weekly schedule",
            }) as string
          }
        >
          {weeklyStrip}
        </Section>

        {/* Assigned shift policy */}
        {detail.policy_name && (
          <Section
            label={
              t("calendar.weekOff.shiftPolicy", {
                defaultValue: "Assigned shift policy",
              }) as string
            }
          >
            <PolicyAppliedCard detail={detail} />
          </Section>
        )}

        {/* Informational note */}
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            padding: "11px 14px",
            background: "var(--bg-sunken)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            borderStyle: "dashed",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 20,
              height: 20,
              borderRadius: "50%",
              background: "var(--text-tertiary)",
              color: "var(--bg)",
              fontSize: 11,
              fontWeight: 700,
              display: "grid",
              placeItems: "center",
              flexShrink: 0,
              marginTop: 1,
            }}
          >
            i
          </span>
          <span
            style={{
              fontSize: 12,
              color: "var(--text-tertiary)",
              lineHeight: 1.6,
            }}
          >
            {t("calendar.weekOff.note", {
              defaultValue:
                "If you believe this day should be a working day, contact your HR team to update the weekly off schedule.",
            }) as string}
          </span>
        </div>
      </div>
    );
  }

  // ── Worked on a week-off day (detections recorded) ────────────────────────
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

      {/* Warning card with accent top bar */}
      <div
        style={{
          background: "var(--warning-soft)",
          border: "1px solid var(--warning)",
          borderRadius: 12,
          overflow: "hidden",
        }}
      >
        <div aria-hidden style={{ height: 4, background: "var(--warning)" }} />
        <div
          style={{
            padding: "14px 16px",
            display: "flex",
            gap: 12,
            alignItems: "flex-start",
          }}
        >
          <div
            aria-hidden
            style={{
              width: 36,
              height: 36,
              borderRadius: 9,
              background: "var(--warning)",
              color: "#fff",
              display: "grid",
              placeItems: "center",
              fontSize: 17,
              flexShrink: 0,
            }}
          >
            ⚠
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: "var(--warning-text)",
                marginBottom: 3,
              }}
            >
              {t("calendar.weekOff.workedTitle", {
                defaultValue: "Worked on Week Off",
              }) as string}
            </div>
            <div
              style={{
                fontSize: 12.5,
                color: "var(--text-secondary)",
                lineHeight: 1.5,
              }}
            >
              {t("calendar.weekOff.workedSubtitle", {
                day: dayName,
                defaultValue: `${dayName} is a weekly off day. Detections recorded — overtime may apply per policy.`,
              }) as string}
            </div>
          </div>
          {detail.overtime_minutes > 0 && (
            <span
              style={{
                padding: "3px 10px",
                borderRadius: 999,
                fontSize: 11.5,
                fontWeight: 700,
                background: "var(--warning)",
                color: "#fff",
                flexShrink: 0,
                whiteSpace: "nowrap",
              }}
            >
              +{(detail.overtime_minutes / 60).toFixed(1)}h OT
            </span>
          )}
        </div>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-4" style={{ gap: 10 }}>
        <Tile
          label={t("calendar.inTime") as string}
          value={detail.in_time?.slice(0, 5) ?? "—"}
        />
        <Tile
          label={t("calendar.outTime") as string}
          value={detail.out_time?.slice(0, 5) ?? "—"}
        />
        <Tile
          label={t("calendar.total") as string}
          value={
            detail.total_minutes != null
              ? `${(detail.total_minutes / 60).toFixed(1)}h`
              : "—"
          }
        />
        <Tile
          label={t("calendar.overtime") as string}
          value={
            detail.overtime_minutes > 0
              ? `+${(detail.overtime_minutes / 60).toFixed(1)}h`
              : "—"
          }
        />
      </div>

      {/* Weekly schedule strip — shows context for why this was unexpected */}
      <Section
        label={
          t("calendar.weekOff.weeklySchedule", {
            defaultValue: "Weekly schedule",
          }) as string
        }
      >
        {weeklyStrip}
      </Section>

      {/* Timeline */}
      <Section label={t("calendar.dayTimeline") as string}>
        <DayTimelineRibbon
          intervals={detail.timeline}
          evidence={detail.evidence}
          inTime={detail.in_time ?? null}
          outTime={detail.out_time ?? null}
          totalMinutes={detail.total_minutes ?? null}
          onEventActivate={onEventActivate}
        />
        {detail.timeline.length === 0 && (
          <div className="text-xs text-dim" style={{ marginTop: 6 }}>
            {t("calendar.noTimeline") as string}
          </div>
        )}
      </Section>

      {/* Policy */}
      {detail.policy_name && (
        <Section label={t("calendar.policyApplied") as string}>
          <PolicyAppliedCard detail={detail} />
        </Section>
      )}

      {/* Evidence */}
      <Section
        label={`${t("calendar.evidence") as string}${
          detail.evidence.length > 0 ? ` · ${detail.evidence.length}` : ""
        }`}
      >
        <EvidenceGallery
          evidence={detail.evidence}
          status={detail.status}
          highlightedEventId={highlightedEventId}
          isoDate={isoDate}
          registerRef={registerRef}
        />
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Escalation-confirmed present card
// ---------------------------------------------------------------------------

function EscalationConfirmedCard({
  note,
  snapshot,
}: {
  note: string | null;
  snapshot: EscalationRequestSnapshot | null;
}) {
  const { t } = useTranslation();

  const fmtDt = (iso: string | null | undefined) => {
    if (!iso) return null;
    try {
      return new Date(iso).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
    } catch {
      return iso;
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Success banner */}
      <div
        style={{
          background: "var(--success-soft)",
          border: "1px solid var(--success)",
          borderRadius: 12,
          padding: "14px 16px",
          display: "flex",
          gap: 14,
          alignItems: "flex-start",
        }}
      >
        <span
          style={{
            width: 38,
            height: 38,
            borderRadius: "50%",
            background: "var(--success)",
            color: "#fff",
            display: "grid",
            placeItems: "center",
            fontSize: 18,
            flexShrink: 0,
          }}
        >
          ✓
        </span>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--success-text)", marginBottom: 4 }}>
            {t("escalation.confirmedTitle", { defaultValue: "Present confirmed by escalation" }) as string}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.55 }}>
            {t("escalation.confirmedSub", {
              defaultValue:
                "An escalation was raised, reviewed by Manager and HR, and approved. Attendance is marked as Present.",
            }) as string}
          </div>
          {note && (
            <div
              style={{
                marginTop: 8,
                padding: "6px 10px",
                background: "var(--bg-elev)",
                borderRadius: 7,
                fontSize: 12,
                color: "var(--text-tertiary)",
              }}
            >
              <b style={{ color: "var(--text)" }}>
                {t("escalation.confirmedReason", { defaultValue: "Reason:" }) as string}{" "}
              </b>
              {note}
            </div>
          )}
        </div>
      </div>

      {/* Approval chain */}
      {snapshot && (
        <div
          style={{
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: "12px 14px",
          }}
        >
          <div
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "var(--text-tertiary)",
              marginBottom: 12,
            }}
          >
            {t("escalation.approvalChain", { defaultValue: "Approval chain" }) as string}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <ChainStep
              label={t("escalation.chainSubmitted", { defaultValue: "Submitted" }) as string}
              actor={null}
              meta={fmtDt(snapshot.submitted_at)}
              comment={snapshot.reason_text ?? snapshot.reason_category}
              done
            />
            <ChainStep
              label={t("escalation.chainManager", { defaultValue: "Manager reviewed" }) as string}
              actor={snapshot.manager_name}
              meta={fmtDt(snapshot.manager_decision_at)}
              comment={snapshot.manager_comment}
              done={!!snapshot.manager_decision_at}
            />
            <ChainStep
              label={t("escalation.chainHR", { defaultValue: "HR approved — present confirmed" }) as string}
              actor={snapshot.hr_name}
              meta={fmtDt(snapshot.hr_decision_at)}
              comment={snapshot.hr_comment}
              done={!!snapshot.hr_decision_at}
              highlight
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ChainStep({
  label,
  actor,
  meta,
  comment,
  done,
  highlight = false,
}: {
  label: string;
  actor: string | null | undefined;
  meta: string | null | undefined;
  comment: string | null | undefined;
  done: boolean;
  highlight?: boolean;
}) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
      <div
        style={{
          width: 20,
          height: 20,
          borderRadius: "50%",
          background: done
            ? highlight
              ? "var(--success)"
              : "var(--success)"
            : "var(--bg-sunken)",
          border: done ? "none" : "1.5px dashed var(--border-strong)",
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
          marginTop: 2,
        }}
      >
        {done && (
          <Icon name="check" size={10} style={{ color: "#fff" }} />
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: highlight ? "var(--success-text)" : "var(--text)" }}>
          {label}
          {actor && (
            <span style={{ fontWeight: 400, color: "var(--text-secondary)", marginInlineStart: 6 }}>
              · {actor}
            </span>
          )}
        </div>
        {meta && (
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 1 }}>
            {meta}
          </div>
        )}
        {comment && (
          <div
            style={{
              marginTop: 5,
              padding: "5px 9px",
              background: "var(--bg-sunken)",
              borderRadius: 6,
              fontSize: 12,
              color: "var(--text-secondary)",
            }}
          >
            "{comment}"
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Absent state system — 5 sub-states replacing the old single absent card
// ---------------------------------------------------------------------------

interface AbsentCardProps {
  detail: DayDetail;
  isoDate: string;
  onSubmitException: ((isoDate: string) => void) | null;
  onRaiseEscalation: (() => void) | null;
  currentRole: string | null;
  onDecisionMade: () => void;
}

/** Dispatches to one of the absent sub-state card components. */
function AbsentStateCard({
  detail,
  isoDate,
  onRaiseEscalation,
  currentRole,
  onDecisionMade,
}: AbsentCardProps) {
  const sub = getAbsentSubState(detail);
  if (sub === "approved") return <ApprovedAbsenceCard detail={detail} />;
  if (sub === "pending") return (
    <RequestPendingCard
      detail={detail}
      currentRole={currentRole}
      onDecisionMade={onDecisionMade}
    />
  );
  return <SimpleAbsentCard isoDate={isoDate} onRaiseEscalation={onRaiseEscalation} />;
}

// ─ Simple absent card — shown for all absent sub-states without a pending/approved request ─

function SimpleAbsentCard({
  isoDate,
  onRaiseEscalation,
}: {
  isoDate: string;
  onRaiseEscalation: (() => void) | null;
}) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);

  const parsedDate = (() => {
    try {
      return new Date(`${isoDate}T00:00:00`).toLocaleDateString(undefined, {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
      });
    } catch { return isoDate; }
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Absent status card */}
      <div style={{ background: "var(--danger-soft)", border: "1px solid var(--danger)", borderRadius: 12, overflow: "hidden" }}>
        <div aria-hidden style={{ height: 4, background: "var(--danger-text)" }} />
        <div style={{ padding: "14px 16px", display: "flex", gap: 12, alignItems: "flex-start" }}>
          <BsXCircleFill aria-hidden style={{ flexShrink: 0, fontSize: 22, color: "var(--danger-text)", marginTop: 1 }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--danger-text)", marginBottom: 4 }}>
              {t("calendar.absent.noRecordTitle", { defaultValue: "No attendance recorded" }) as string}
            </div>
            <div style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.55 }}>
              {parsedDate}
            </div>
            <div style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.55, marginTop: 6 }}>
              {onRaiseEscalation
                ? t("calendar.absent.escalationHint", {
                    defaultValue: "If you were present but the system missed you, submit an escalation request for manager and HR review.",
                  }) as string
                : t("calendar.absent.noRequestSubmitted", {
                    defaultValue: "The employee has not submitted an escalation request for this day.",
                  }) as string}
            </div>
          </div>
        </div>
      </div>

      {/* Exception CTA — Employee role only */}
      {onRaiseEscalation && (
        <button
          type="button"
          onClick={onRaiseEscalation}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          style={{
            display: "flex", alignItems: "center", gap: 12,
            padding: "13px 16px", borderRadius: 10,
            background: "var(--bg-elev)",
            border: `1.5px solid ${hovered ? "var(--accent)" : "var(--border)"}`,
            boxShadow: hovered ? "0 2px 12px rgba(0,0,0,0.09)" : "var(--shadow-sm)",
            cursor: "pointer", textAlign: "start", width: "100%",
            transition: "border-color 150ms ease, box-shadow 150ms ease",
            fontFamily: "var(--font-sans)",
          }}
        >
          <div aria-hidden style={{ flexShrink: 0, width: 38, height: 38, borderRadius: 10, background: hovered ? "color-mix(in oklab, var(--accent) 14%, var(--bg-elev))" : "var(--bg-sunken)", display: "grid", placeItems: "center", transition: "background 150ms ease" }}>
            <BsClipboard2PlusFill style={{ fontSize: 18, color: hovered ? "var(--accent)" : "var(--text-secondary)", transition: "color 150ms ease" }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text)" }}>
              {t("calendar.absent.submitExceptionTitle", { defaultValue: "Submit Escalation Request" }) as string}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2, lineHeight: 1.4 }}>
              {t("calendar.absent.submitExceptionSub", {
                defaultValue: "Explain your situation — manager and HR will review and update your status if approved.",
              }) as string}
            </div>
          </div>
          <BsChevronRight aria-hidden style={{ flexShrink: 0, fontSize: 13, color: "var(--text-tertiary)" }} />
        </button>
      )}
    </div>
  );
}

function RequestPendingCard({
  detail,
  currentRole,
  onDecisionMade,
}: {
  detail: DayDetail;
  currentRole: string | null;
  onDecisionMade: () => void;
}) {
  const { t } = useTranslation();
  const req = detail.pending_request!;

  // Inline decision state
  const [showReject, setShowReject] = useState(false);
  const [comment, setComment] = useState("");
  const [deciding, setDeciding] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  const fmtDt = (iso: string): string => {
    try {
      return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    } catch { return iso; }
  };

  const statusMap: Record<string, [boolean, boolean, boolean]> = {
    submitted:        [true, false, false],
    manager_approved: [true, true,  false],
  };
  const [step1, step2, step3] = statusMap[req.status] ?? [true, false, false];

  const typeLabel = req.request_type === "escalation"
    ? t("calendar.absent.typeEscalation", { defaultValue: "Escalation" }) as string
    : t("calendar.absent.typeException", { defaultValue: "Exception request" }) as string;

  const stageLabel = step2
    ? t("calendar.absent.awaitingHR", { defaultValue: "Awaiting HR review" }) as string
    : t("calendar.absent.awaitingManager", { defaultValue: "Awaiting manager review" }) as string;

  // Who can act and on which endpoint
  const canManagerDecide = currentRole === "Manager" && req.status === "submitted";
  const canHRDecide = currentRole === "HR" && req.status === "manager_approved";
  const canDecide = canManagerDecide || canHRDecide;
  const decisionEndpoint = canManagerDecide
    ? `/api/requests/${req.request_id}/manager-decide`
    : `/api/requests/${req.request_id}/hr-decide`;

  const decide = async (decision: "approve" | "reject") => {
    setDeciding(true);
    setDecisionError(null);
    try {
      await api(decisionEndpoint, {
        method: "POST",
        body: JSON.stringify({ decision, comment: comment.trim() }),
      });
      onDecisionMade();
    } catch (err) {
      setDecisionError(extractApiError(err, t("calendar.absent.decisionFailed", { defaultValue: "Failed to submit decision. Please try again." }) as string));
      setDeciding(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Status banner */}
      <div style={{ background: "var(--accent-soft)", border: "1px solid #93C5FD", borderRadius: 12, padding: "13px 15px", display: "flex", gap: 10, alignItems: "flex-start" }}>
        <div style={{ fontSize: 20, flexShrink: 0, lineHeight: 1.2 }}>⏳</div>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--accent-text)", marginBottom: 3 }}>
            {req.request_type === "escalation"
              ? t("calendar.absent.pendingTitleEscalation", { defaultValue: "Escalation under review" }) as string
              : t("calendar.absent.pendingTitleException", { defaultValue: "Exception request under review" }) as string}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>
            {t("calendar.absent.pendingSub", { defaultValue: "A request for this day is currently being reviewed. Attendance will update automatically once all approvals are complete." }) as string}
          </div>
        </div>
      </div>

      {/* Progress track */}
      <div style={{ background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px" }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: "var(--text-tertiary)", marginBottom: 12 }}>
          {t("calendar.absent.progressTitle", { defaultValue: "Request progress" }) as string}
        </div>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 0 }}>
          <ProgressStep done={true} current={false} icon="✓" label={t("calendar.absent.stepSubmitted", { defaultValue: "Submitted" }) as string} />
          <ProgressLine done={step1} />
          <ProgressStep done={step2} current={!step2} icon="👤" label={t("calendar.absent.stepManager", { defaultValue: "Manager" }) as string} />
          <ProgressLine done={step2} />
          <ProgressStep done={step3} current={step2 && !step3} icon="🏢" label={t("calendar.absent.stepHR", { defaultValue: "HR review" }) as string} />
          <ProgressLine done={step3} />
          <ProgressStep done={false} current={false} icon="✔" label={req.request_type === "escalation" ? (t("calendar.absent.stepPresent", { defaultValue: "Confirmed" }) as string) : (t("calendar.absent.stepApproved", { defaultValue: "Approved" }) as string)} />
        </div>

        {/* Request summary */}
        <div style={{ marginTop: 14, padding: "10px 12px", background: "var(--bg-sunken)", borderRadius: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          <FactRow label={t("calendar.absent.typeLabel", { defaultValue: "Type" }) as string} value={typeLabel} />
          <FactRow label={t("calendar.absent.reasonLabel", { defaultValue: "Reason" }) as string} value={req.reason_category} />
          {req.reason_text && (
            <FactRow label={t("calendar.absent.detailsLabel", { defaultValue: "Details" }) as string} value={`"${req.reason_text}"`} italic />
          )}
          <FactRow label={t("calendar.absent.submittedAt", { defaultValue: "Submitted" }) as string} value={fmtDt(req.submitted_at)} mono />
          {req.manager_name && (
            <FactRow label={t("calendar.absent.assignedTo", { defaultValue: "Assigned to" }) as string} value={req.manager_name} bold />
          )}
          <FactRow label={t("calendar.absent.currentStage", { defaultValue: "Status" }) as string} value={stageLabel} accent />
        </div>
      </div>

      {/* ── Inline decision panel (Manager / HR only) ── */}
      {canDecide && (
        <div style={{ border: "1.5px solid var(--border)", borderRadius: 12, overflow: "hidden", background: "var(--bg-elev)" }}>
          {/* Header */}
          <div style={{ padding: "11px 14px 9px", borderBottom: "1px solid var(--border)", background: "var(--bg-sunken)", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 14 }}>🔍</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>
              {t("calendar.absent.decisionTitle", {
                defaultValue: "Your decision",
                role: currentRole ?? "",
              }) as string}
            </span>
            <span className="pill pill-neutral" style={{ fontSize: 10.5, marginInlineStart: "auto" }}>
              {currentRole}
            </span>
          </div>

          <div style={{ padding: "14px" }}>
            {!showReject ? (
              /* Default: Approve + Reject side by side */
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  onClick={() => decide("approve")}
                  disabled={deciding}
                  style={{
                    flex: 1, padding: "10px 0", borderRadius: 8, border: "none",
                    background: deciding ? "var(--bg-sunken)" : "var(--success)",
                    color: deciding ? "var(--text-tertiary)" : "#fff",
                    fontWeight: 700, fontSize: 13, cursor: deciding ? "not-allowed" : "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                    transition: "opacity 150ms ease",
                    fontFamily: "var(--font-sans)",
                  }}
                >
                  {deciding ? (
                    t("calendar.absent.approving", { defaultValue: "Approving…" }) as string
                  ) : (
                    <>{t("calendar.absent.approveBtn", { defaultValue: "✓ Approve" }) as string}</>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setShowReject(true)}
                  disabled={deciding}
                  style={{
                    flex: 1, padding: "10px 0", borderRadius: 8,
                    border: "1.5px solid var(--border)",
                    background: "var(--bg)", color: "var(--danger-text)",
                    fontWeight: 700, fontSize: 13, cursor: deciding ? "not-allowed" : "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                    fontFamily: "var(--font-sans)",
                  }}
                >
                  {t("calendar.absent.rejectBtn", { defaultValue: "✕ Reject" }) as string}
                </button>
              </div>
            ) : (
              /* Reject form */
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-secondary)" }}>
                  {t("calendar.absent.rejectCommentLabel", { defaultValue: "Reason for rejection (optional)" }) as string}
                </label>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  rows={3}
                  placeholder={t("calendar.absent.rejectCommentPlaceholder", { defaultValue: "Explain why this request is being rejected…" }) as string}
                  style={{
                    padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 7,
                    fontSize: 13, background: "var(--bg)", color: "var(--text)",
                    fontFamily: "var(--font-sans)", outline: "none", resize: "vertical",
                    minHeight: 72, width: "100%",
                  }}
                />
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => { setShowReject(false); setComment(""); setDecisionError(null); }}
                    disabled={deciding}
                    style={{ flex: 1 }}
                  >
                    {t("common.cancel", { defaultValue: "Cancel" }) as string}
                  </button>
                  <button
                    type="button"
                    onClick={() => decide("reject")}
                    disabled={deciding}
                    style={{
                      flex: 2, padding: "7px 0", borderRadius: 7, border: "none",
                      background: deciding ? "var(--bg-sunken)" : "var(--danger-text)",
                      color: deciding ? "var(--text-tertiary)" : "#fff",
                      fontWeight: 700, fontSize: 13, cursor: deciding ? "not-allowed" : "pointer",
                      fontFamily: "var(--font-sans)",
                    }}
                  >
                    {deciding
                      ? t("calendar.absent.rejecting", { defaultValue: "Rejecting…" }) as string
                      : t("calendar.absent.confirmReject", { defaultValue: "Confirm Rejection" }) as string}
                  </button>
                </div>
              </div>
            )}

            {decisionError && (
              <div role="alert" style={{ marginTop: 8, padding: "7px 10px", background: "var(--danger-soft)", color: "var(--danger-text)", borderRadius: 7, fontSize: 12.5, border: "1px solid var(--danger)" }}>
                {decisionError}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Guidance note — only for employee / non-deciding roles */}
      {!canDecide && (
        <div style={{ background: "var(--bg-sunken)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.55 }}>
          {t("calendar.absent.pendingGuidance", { defaultValue: "Your request is currently under review. You will receive a notification when a decision is made." }) as string}
        </div>
      )}
    </div>
  );
}

// ─ State 5: Approved absence ──────────────────────────────────────────────────

function ApprovedAbsenceCard({ detail }: { detail: DayDetail }) {
  const { t } = useTranslation();
  const req = detail.approved_request!;

  const fmtDt = (iso: string | null | undefined): string | null => {
    if (!iso) return null;
    try {
      return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    } catch { return iso; }
  };

  const typeLabel =
    req.request_type === "leave"
      ? t("calendar.absent.typeLeave", { defaultValue: "Leave request" }) as string
      : t("calendar.absent.typeException", { defaultValue: "Exception request" }) as string;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        style={{
          background: "var(--success-soft)", border: "1px solid #86EFAC",
          borderRadius: 12, padding: "14px 16px",
          display: "flex", gap: 14, alignItems: "flex-start",
        }}
      >
        <span
          style={{
            width: 42, height: 42, borderRadius: "50%",
            background: "var(--success)", color: "#fff",
            display: "grid", placeItems: "center", fontSize: 18, flexShrink: 0,
          }}
        >
          ✓
        </span>
        <div>
          <div style={{ fontSize: 14.5, fontWeight: 700, color: "var(--success-text)", marginBottom: 4 }}>
            {req.request_type === "leave"
              ? t("calendar.absent.approvedTitleLeave", { defaultValue: "Leave approved — absence on record" }) as string
              : t("calendar.absent.approvedTitleException", { defaultValue: "Exception approved — absence on record" }) as string}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.55 }}>
            {t("calendar.absent.approvedSub", { defaultValue: "An exception request for this day was reviewed and approved. The absence is officially on record." }) as string}
          </div>
        </div>
      </div>

      {/* Approval details */}
      <div style={{ background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px" }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: "var(--text-tertiary)", marginBottom: 10 }}>
          {t("calendar.absent.approvalDetailsTitle", { defaultValue: "Approval details" }) as string}
        </div>

        {/* Request facts */}
        <div
          style={{
            padding: "10px 12px", background: "var(--bg-sunken)",
            borderRadius: 8, display: "flex", flexDirection: "column", gap: 6, marginBottom: 12,
          }}
        >
          <FactRow label={t("calendar.absent.typeLabel", { defaultValue: "Type" }) as string} value={typeLabel} />
          <FactRow label={t("calendar.absent.reasonLabel", { defaultValue: "Reason" }) as string} value={req.reason_category} />
          {req.reason_text && (
            <FactRow label={t("calendar.absent.detailsLabel", { defaultValue: "Details" }) as string} value={`"${req.reason_text}"`} italic />
          )}
        </div>

        {/* Approval chain */}
        <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: "var(--text-tertiary)", marginBottom: 10 }}>
          {t("calendar.absent.approvalChainTitle", { defaultValue: "Approval chain" }) as string}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <ApprovalChainStep
            done
            label={t("calendar.absent.chainSubmitted", { defaultValue: "Submitted by employee" }) as string}
            meta={fmtDt(req.submitted_at)}
          />
          <div style={{ width: 1.5, height: 10, background: "var(--border)", marginInlineStart: 10, marginBlock: 2 }} />
          {req.manager_name && (
            <>
              <ApprovalChainStep
                done
                label={`${t("calendar.absent.chainManagerApproved", { defaultValue: "Manager approved" }) as string} · ${req.manager_name}`}
                meta={fmtDt(req.manager_decision_at)}
                comment={req.manager_comment ?? null}
              />
              <div style={{ width: 1.5, height: 10, background: "var(--border)", marginInlineStart: 10, marginBlock: 2 }} />
            </>
          )}
          {req.hr_name && (
            <ApprovalChainStep
              done
              highlight
              label={`${t("calendar.absent.chainHRApproved", { defaultValue: "HR approved" }) as string} · ${req.hr_name}`}
              meta={fmtDt(req.hr_decision_at)}
              comment={req.hr_comment ?? null}
            />
          )}
        </div>
      </div>

      <div
        style={{
          display: "flex", gap: 10, alignItems: "flex-start",
          background: "var(--success-soft)", border: "1px solid #86EFAC",
          borderRadius: 8, padding: "10px 12px",
          fontSize: 12.5, color: "var(--success-text)", lineHeight: 1.6,
        }}
      >
        <span style={{ fontSize: 16, flexShrink: 0 }}>✅</span>
        <div>{t("calendar.absent.approvedNote", { defaultValue: "This absence has been reviewed and approved. No further action is required." }) as string}</div>
      </div>

      <a href="/my-requests" className="btn btn-sm" style={{ textDecoration: "none", alignSelf: "flex-start" }}>
        👁 {t("calendar.absent.viewBtn", { defaultValue: "View full request" }) as string}
      </a>
    </div>
  );
}

// ─ Absent sub-components ─────────────────────────────────────────────────────

function ProgressStep({
  done, current, icon, label,
}: {
  done: boolean; current: boolean; icon: string; label: string;
}) {
  const bg = done
    ? "var(--success)"
    : current
      ? "var(--accent)"
      : "var(--bg-sunken)";
  const color = done || current ? "#fff" : "var(--text-tertiary)";
  const labelColor = done
    ? "var(--success-text)"
    : current
      ? "var(--accent-text)"
      : "var(--text-tertiary)";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 0, minWidth: 48 }}>
      <div
        style={{
          width: 30, height: 30, borderRadius: "50%",
          background: bg, color, display: "grid", placeItems: "center",
          fontSize: 12, fontWeight: 700, marginBottom: 5,
          border: current ? `2px solid ${bg}` : "none",
          boxShadow: current ? `0 0 0 3px color-mix(in oklab, var(--accent) 18%, transparent)` : "none",
        }}
      >
        {icon}
      </div>
      <div style={{ fontSize: 10.5, textAlign: "center", color: labelColor, fontWeight: done || current ? 600 : 400, lineHeight: 1.3, maxWidth: 48 }}>
        {label}
      </div>
    </div>
  );
}

function ProgressLine({ done }: { done: boolean }) {
  return (
    <div
      style={{
        flex: 1, height: 2,
        background: done ? "var(--success)" : "var(--border)",
        marginTop: 14, minWidth: 12,
      }}
    />
  );
}

function FactRow({
  label, value, italic, mono, bold, accent,
}: {
  label: string; value: string;
  italic?: boolean; mono?: boolean; bold?: boolean; accent?: boolean;
}) {
  return (
    <div style={{ display: "flex", gap: 8, fontSize: 12, alignItems: "flex-start" }}>
      <span style={{ color: "var(--text-tertiary)", width: 80, flexShrink: 0 }}>{label}</span>
      <span
        style={{
          color: accent ? "var(--accent-text)" : bold ? "var(--text)" : "var(--text-secondary)",
          fontStyle: italic ? "italic" : "normal",
          fontFamily: mono ? "ui-monospace, Menlo, Consolas, monospace" : undefined,
          fontWeight: bold || accent ? 600 : 400,
          flex: 1, minWidth: 0,
        }}
      >
        {value}
      </span>
    </div>
  );
}

function ApprovalChainStep({
  done, highlight = false, label, meta, comment,
}: {
  done: boolean; highlight?: boolean; label: string;
  meta: string | null; comment?: string | null;
}) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <div
        style={{
          width: 20, height: 20, borderRadius: "50%",
          background: done ? "var(--success)" : "var(--bg-sunken)",
          border: done ? "none" : "1.5px dashed var(--border-strong)",
          display: "grid", placeItems: "center", flexShrink: 0, marginTop: 1,
        }}
      >
        {done && <Icon name="check" size={10} style={{ color: "#fff" }} />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: highlight ? "var(--success-text)" : "var(--text)" }}>
          {label}
        </div>
        {meta && (
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 1 }}>{meta}</div>
        )}
        {comment && (
          <div
            style={{
              marginTop: 5, padding: "5px 9px", background: "var(--bg-sunken)",
              borderRadius: 6, fontSize: 11.5, color: "var(--text-secondary)", fontStyle: "italic",
            }}
          >
            "{comment}"
          </div>
        )}
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Absent / Waiting card — shown instead of empty tiles + ribbon
// ---------------------------------------------------------------------------

function AbsentWaitingCard({
  status,
  isoDate,
  policyName,
  policyType: _policyType,
  policyShiftStart,
  policyShiftEnd,
  policyRequiredHours,
  onSubmitException,
  onRaiseEscalation,
}: {
  status: "absent" | "waiting";
  isoDate: string;
  policyName: string | null;
  policyType: string | null;
  policyShiftStart: string | null;
  policyShiftEnd: string | null;
  policyRequiredHours: number | null;
  onSubmitException: ((isoDate: string) => void) | null;
  onRaiseEscalation: (() => void) | null;
}) {
  const { t } = useTranslation();
  const isAbsent = status === "absent";

  // Colours and icon per status
  const accent = isAbsent ? "var(--danger-text)" : "var(--warning-text)";
  const accentSoft = isAbsent ? "var(--danger-soft)" : "var(--warning-soft)";
  const accentBorder = isAbsent ? "var(--danger)" : "var(--warning)";
  const icon = isAbsent ? "✕" : "⏳";

  const headingKey = isAbsent ? "absentHeading" : "waitingHeading";
  const subtitleKey = isAbsent ? "absentSubtitle" : "waitingSubtitle";
  const headingDefault = isAbsent
    ? "No attendance recorded"
    : "Day in progress";
  const subtitleDefault = isAbsent
    ? "This employee was not captured on this day and no approved exception exists."
    : "The shift window is still open. Attendance will update as detections come in.";

  // Format an HH:MM time string into a 12-hr-style friendly label
  const friendly = (t: string | null) => {
    if (!t) return null;
    const [hStr, mStr] = t.split(":");
    const h = parseInt(hStr ?? "", 10);
    const m = mStr ?? "00";
    if (isNaN(h)) return t;
    const suffix = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${m} ${suffix}`;
  };

  const parsedDate = (() => {
    try {
      return new Date(`${isoDate}T00:00:00`).toLocaleDateString(undefined, {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    } catch {
      return isoDate;
    }
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Status banner */}
      <div
        style={{
          background: accentSoft,
          border: `1px solid ${accentBorder}`,
          borderRadius: 12,
          padding: "16px 16px",
          display: "flex",
          gap: 14,
          alignItems: "flex-start",
        }}
      >
        <span
          style={{
            width: 40,
            height: 40,
            borderRadius: "50%",
            background: isAbsent ? "var(--danger)" : "var(--warning)",
            color: "#fff",
            display: "grid",
            placeItems: "center",
            fontSize: 18,
            flexShrink: 0,
          }}
        >
          {icon}
        </span>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: accent, marginBottom: 4 }}>
            {t(`calendar.${headingKey}`, { defaultValue: headingDefault }) as string}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.55 }}>
            {t(`calendar.${subtitleKey}`, { defaultValue: subtitleDefault }) as string}
          </div>
          <div
            className="mono"
            style={{
              fontSize: 11,
              marginTop: 8,
              color: "var(--text-tertiary)",
              display: "flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            <Icon name="calendar" size={11} />
            {parsedDate}
          </div>
        </div>
      </div>

      {/* Expected shift — from policy if available */}
      {(policyShiftStart || policyShiftEnd || policyRequiredHours) && (
        <div
          style={{
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: "12px 14px",
          }}
        >
          <div
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "var(--text-tertiary)",
              marginBottom: 10,
            }}
          >
            {t("calendar.expectedShift", {
              defaultValue: "Expected shift",
            }) as string}
            {policyName && (
              <span
                style={{
                  marginInlineStart: 8,
                  fontSize: 10.5,
                  fontWeight: 600,
                  background: "var(--accent-soft)",
                  color: "var(--accent-text)",
                  padding: "1px 7px",
                  borderRadius: 999,
                  textTransform: "none",
                  letterSpacing: 0,
                }}
              >
                {policyName}
              </span>
            )}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 8,
            }}
          >
            {policyShiftStart && (
              <div
                style={{
                  background: "var(--bg-sunken)",
                  borderRadius: 8,
                  padding: "8px 10px",
                }}
              >
                <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-tertiary)", fontWeight: 600, marginBottom: 4 }}>
                  {t("calendar.startTime", { defaultValue: "Start" }) as string}
                </div>
                <div className="mono" style={{ fontSize: 14, fontWeight: 700 }}>
                  {friendly(policyShiftStart) ?? policyShiftStart}
                </div>
              </div>
            )}
            {policyShiftEnd && (
              <div
                style={{
                  background: "var(--bg-sunken)",
                  borderRadius: 8,
                  padding: "8px 10px",
                }}
              >
                <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-tertiary)", fontWeight: 600, marginBottom: 4 }}>
                  {t("calendar.endTime", { defaultValue: "End" }) as string}
                </div>
                <div className="mono" style={{ fontSize: 14, fontWeight: 700 }}>
                  {friendly(policyShiftEnd) ?? policyShiftEnd}
                </div>
              </div>
            )}
            {policyRequiredHours != null && (
              <div
                style={{
                  background: "var(--bg-sunken)",
                  borderRadius: 8,
                  padding: "8px 10px",
                }}
              >
                <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-tertiary)", fontWeight: 600, marginBottom: 4 }}>
                  {t("calendar.requiredHours", { defaultValue: "Required" }) as string}
                </div>
                <div className="mono" style={{ fontSize: 14, fontWeight: 700 }}>
                  {policyRequiredHours}{" "}
                  <span style={{ fontSize: 11, fontWeight: 500 }}>
                    {t("calendar.hoursShort", { defaultValue: "h" }) as string}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* What-to-do actions */}
      <div
        style={{
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: "12px 14px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div
          style={{
            fontSize: 10.5,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--text-tertiary)",
          }}
        >
          {t("calendar.whatNext", { defaultValue: "What you can do" }) as string}
        </div>

        <ActionRow
          icon="clipboard"
          title={t("calendar.actionSubmitException", {
            defaultValue: "Submit an exception request",
          }) as string}
          sub={t("calendar.actionSubmitExceptionSub", {
            defaultValue:
              "If you have a valid reason, raise an exception for manager and HR review.",
          }) as string}
          cta={
            onSubmitException ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => onSubmitException(isoDate)}
              >
                {t("calendar.submitException") as string}
              </button>
            ) : null
          }
        />

        {onRaiseEscalation && (
          <ActionRow
            icon="zap"
            title={t("escalation.actionTitle", {
              defaultValue: "Raise an escalation (I was present)",
            }) as string}
            sub={t("escalation.actionSub", {
              defaultValue:
                "If you believe the camera missed you, raise an escalation. It routes to your manager then HR, and updates your attendance automatically when approved.",
            }) as string}
            cta={
              <button
                type="button"
                className="btn btn-sm"
                style={{ background: "var(--danger)", color: "#fff", borderColor: "var(--danger)" }}
                onClick={onRaiseEscalation}
              >
                {t("escalation.raiseButton", { defaultValue: "Raise escalation" }) as string}
              </button>
            }
          />
        )}
      </div>
    </div>
  );
}

function ActionRow({
  icon,
  title,
  sub,
  cta,
}: {
  icon: import("../../shell/Icon").IconName;
  title: string;
  sub: string;
  cta: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        padding: "10px 0",
        borderTop: "1px solid var(--border)",
      }}
    >
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          background: "var(--bg-sunken)",
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
          color: "var(--text-secondary)",
        }}
      >
        <Icon name={icon} size={14} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 2 }}>
          {title}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-tertiary)", lineHeight: 1.5 }}>
          {sub}
        </div>
      </div>
      {cta && <div style={{ flexShrink: 0 }}>{cta}</div>}
    </div>
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


function getAbsentSubState(
  detail: DayDetail,
): "approved" | "pending" | "outside_shift" | "camera_offline" | "complete" {
  if (detail.approved_request != null) return "approved";
  if (detail.pending_request != null) return "pending";
  if (detail.timeline.length > 0) return "outside_shift";
  if (detail.camera_gaps.length > 0) return "camera_offline";
  return "complete";
}

function StatusPill({
  status,
  detail,
}: {
  status: string;
  detail?: DayDetail;
}) {
  const { t } = useTranslation();
  if (status === "late") return <LateBadge size="md" />;

  if (status === "absent" && detail != null) {
    const sub = getAbsentSubState(detail);
    // Only escalation-related sub-states show a distinct chip.
    // camera_offline / outside_shift / complete all default to plain "Absent".
    if (sub === "approved") {
      return (
        <span style={{ padding: "3px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600, background: "var(--success-soft)", color: "var(--success-text)", border: "1px solid #86EFAC", whiteSpace: "nowrap" }}>
          {t("calendar.absent.chipApproved", { defaultValue: "✓ Approved" }) as string}
        </span>
      );
    }
    if (sub === "pending") {
      return (
        <span style={{ padding: "3px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600, background: "var(--accent-soft)", color: "var(--accent-text)", border: "1px solid #93C5FD", whiteSpace: "nowrap" }}>
          {t("calendar.absent.chipPending", { defaultValue: "⏳ Waiting for Approval" }) as string}
        </span>
      );
    }
    return (
      <span style={{ padding: "3px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600, background: "var(--danger-soft)", color: "var(--danger-text)", border: "1px solid #FCA5A5", whiteSpace: "nowrap" }}>
        {t("calendar.status.absent", { defaultValue: "Absent" }) as string}
      </span>
    );
  }

  // Escalation-confirmed present — distinct badge so it's never confused
  // with a normal camera-detected present day.
  if (status === "escalation_present") {
    return (
      <span style={{ padding: "3px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600, background: "color-mix(in oklab, var(--accent) 18%, var(--bg))", color: "var(--accent-text)", border: "1px solid var(--accent)", whiteSpace: "nowrap" }}>
        {t("calendar.status.escalation_present", { defaultValue: "✓ Present via Escalation" }) as string}
      </span>
    );
  }

  const tone =
    status === "present" ? "success"
    : status === "absent" ? "danger"
    : status === "waiting" ? "accent"
    : status === "leave" || status === "holiday" ? "info"
    : "neutral";
  return (
    <span className={`pill pill-${tone}`}>
      {t(`calendar.status.${status}`) as string}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Day timeline ribbon
// ---------------------------------------------------------------------------

const TIMELINE_HOURS = 24;

/** Returns minutes-since-midnight for an ``HH:MM[:SS]`` string. */
function timeStringToMinutes(s: string | null | undefined): number | null {
  if (!s) return null;
  const parts = s.split(":");
  const h = parseInt(parts[0] ?? "", 10);
  const m = parseInt(parts[1] ?? "", 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

/** Formats a total-minutes integer to ``Hh Mmin`` (compact). */
function formatHoursAndMinutes(mins: number | null | undefined): string {
  if (mins == null) return "—";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m.toString().padStart(2, "0")} min`;
}

interface TimelineHoverInfo {
  kind: "event" | "interval" | "marker";
  label: string;
  sub?: string;
  confidence?: number | null;
  pctLeft: number;
  hasAction?: boolean;
}

function DayTimelineRibbon({
  intervals,
  evidence,
  inTime,
  outTime,
  totalMinutes,
  onEventActivate,
}: {
  intervals: { start: string; end: string }[];
  evidence: EvidenceCrop[];
  inTime: string | null;
  outTime: string | null;
  totalMinutes: number | null;
  onEventActivate?: (detectionEventId: number) => void;
}) {
  const { t } = useTranslation();
  const [showFullDay, setShowFullDay] = useState(false);
  const [hover, setHover] = useState<TimelineHoverInfo | null>(null);

  const minutesOf = (hhmm: string): number => timeStringToMinutes(hhmm) ?? 0;

  const inMinutes = timeStringToMinutes(inTime);
  const outMinutes = timeStringToMinutes(outTime);

  // Collect all activity minutes to auto-zoom the view window.
  const activityMinutes: number[] = [
    inMinutes,
    outMinutes,
    ...evidence.map(ev => timeStringToMinutes(ev.captured_at)),
    ...intervals.flatMap(iv => [minutesOf(iv.start), minutesOf(iv.end)]),
  ].filter((m): m is number => m != null);
  const hasActivity = activityMinutes.length > 0;

  // Smart-zoom: pad ±90 min around the active window, min 4 h span.
  const viewStart = (showFullDay || !hasActivity) ? 0
    : Math.max(0, Math.min(...activityMinutes) - 90);
  const rawEnd = (showFullDay || !hasActivity) ? TIMELINE_HOURS * 60
    : Math.min(TIMELINE_HOURS * 60, Math.max(...activityMinutes) + 90);
  const viewEnd = (showFullDay || !hasActivity) ? TIMELINE_HOURS * 60
    : Math.max(rawEnd, viewStart + 240); // ensure min 4 h
  const viewSpan = viewEnd - viewStart;

  // Position helpers relative to the view window.
  const toLeft = (mm: number) => (100 * (mm - viewStart)) / viewSpan;
  const toWidth = (dur: number) => (100 * dur) / viewSpan;

  // Confidence-coded colour for detection dots.
  const confColor = (conf: number | null | undefined) => {
    if (conf == null) return "var(--text-tertiary)";
    if (conf >= 0.75) return "var(--accent)";
    if (conf >= 0.50) return "#d97706";
    return "var(--danger-text)";
  };

  // Hour ticks + labels within the view window.
  const hourStep = viewSpan <= 240 ? 1 : viewSpan <= 480 ? 2 : viewSpan <= 720 ? 3 : 6;
  const hourTicks = Array.from({ length: TIMELINE_HOURS + 1 }, (_, i) => i)
    .filter(h => h * 60 >= viewStart && h * 60 <= viewEnd);
  const hourLabels = hourTicks.filter(h => h % hourStep === 0);

  // Tooltip position — clamp so it never overflows the ribbon edges.
  const clampTooltipLeft = (raw: number) => Math.min(Math.max(raw, 8), 88);

  return (
    <div>
      {/* ── Header: zoom range + toggle ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "var(--font-mono)" }}>
            {String(Math.floor(viewStart / 60)).padStart(2, "0")}:00
            {" – "}
            {String(Math.floor(viewEnd / 60)).padStart(2, "0")}:{String(viewEnd % 60).padStart(2, "0")}
          </span>
          {!showFullDay && hasActivity && (
            <span style={{ fontSize: 10, color: "var(--accent)", fontWeight: 600, background: "color-mix(in oklab, var(--accent) 12%, transparent)", padding: "1px 6px", borderRadius: 10 }}>
              {t("calendar.autoZoom", { defaultValue: "auto-zoom" })}
            </span>
          )}
        </div>
        {hasActivity && (
          <button
            type="button"
            onClick={() => setShowFullDay(v => !v)}
            style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, padding: "3px 9px", fontSize: 11, color: "var(--text-secondary)", cursor: "pointer" }}
          >
            {showFullDay
              ? t("calendar.zoomToActivity", { defaultValue: "Zoom to activity" })
              : t("calendar.fullDay", { defaultValue: "Full day" })}
          </button>
        )}
      </div>

      {/* ── Ribbon ── */}
      <div
        className="day-timeline"
        style={{ position: "relative", height: 96, border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-sunken)", padding: "8px 0 26px", overflow: "visible" }}
        onMouseLeave={() => setHover(null)}
        role="figure"
        aria-label={t("calendar.dayTimelineAria", { defaultValue: "Day timeline — detection events and presence windows" }) as string}
      >
        {/* Hour grid */}
        {hourTicks.map((h) => (
          <div
            key={`tick-${h}`}
            style={{ position: "absolute", insetInlineStart: `${toLeft(h * 60)}%`, top: 0, bottom: 20, width: 1, background: "var(--border)", opacity: h % 6 === 0 ? 0.7 : h % 3 === 0 ? 0.35 : 0.18 }}
            aria-hidden
          />
        ))}

        {/* Gap connectors between consecutive intervals */}
        {intervals.map((iv, idx) => {
          if (idx === intervals.length - 1) return null;
          const next = intervals[idx + 1]!;
          const endMm = minutesOf(iv.end);
          const startMm = minutesOf(next.start);
          if (startMm <= endMm || endMm > viewEnd || startMm < viewStart) return null;
          const l = toLeft(Math.max(endMm, viewStart));
          const w = toLeft(Math.min(startMm, viewEnd)) - l;
          if (w <= 0) return null;
          return (
            <div key={`gap-${idx}`} style={{ position: "absolute", insetInlineStart: `${l}%`, width: `${w}%`, top: 38, height: 0, borderTop: "1.5px dashed var(--text-tertiary)", opacity: 0.45 }} aria-hidden />
          );
        })}

        {/* Presence interval bars */}
        {intervals.map((iv, idx) => {
          const rawStart = minutesOf(iv.start);
          const rawEnd = Math.max(rawStart + 1, minutesOf(iv.end));
          const clampedStart = Math.max(rawStart, viewStart);
          const clampedEnd = Math.min(rawEnd, viewEnd);
          if (clampedStart >= clampedEnd) return null;
          const l = toLeft(clampedStart);
          const w = toWidth(clampedEnd - clampedStart);
          const isHov = hover?.kind === "interval" && hover.label === `${iv.start}–${iv.end}`;
          return (
            <div
              key={`bar-${idx}`}
              style={{ position: "absolute", insetInlineStart: `${l}%`, width: `${Math.max(0.5, w)}%`, top: 30, height: 18, background: "var(--accent)", borderRadius: 5, cursor: "default", opacity: 0.88, boxShadow: isHov ? "0 0 0 3px color-mix(in oklab, var(--accent) 28%, transparent)" : undefined, transition: "box-shadow 120ms ease" }}
              onMouseEnter={() => setHover({ kind: "interval", label: `${iv.start}–${iv.end}`, sub: `${iv.start.slice(0, 5)} – ${iv.end.slice(0, 5)}`, pctLeft: toLeft(rawStart + (rawEnd - rawStart) / 2) })}
              onMouseLeave={() => setHover(null)}
              role="img"
              aria-label={`${t("calendar.presentBlock", { defaultValue: "Present" })} ${iv.start} – ${iv.end}`}
            />
          );
        })}

        {/* Detection event markers — larger, confidence-coloured */}
        {evidence.map((ev) => {
          const mins = timeStringToMinutes(ev.captured_at);
          if (mins == null || mins < viewStart || mins > viewEnd) return null;
          const left = toLeft(mins);
          const cc = confColor(ev.confidence);
          const isHov = hover?.kind === "event" && hover.label === ev.captured_at.slice(0, 5) && Math.abs(hover.pctLeft - left) < 0.1;
          return (
            <button
              key={`ev-${ev.detection_event_id}`}
              type="button"
              onClick={() => onEventActivate?.(ev.detection_event_id)}
              onMouseEnter={() => setHover({ kind: "event", label: ev.captured_at.slice(0, 5), sub: ev.camera_code, ...(ev.confidence != null ? { confidence: ev.confidence } : {}), pctLeft: left, hasAction: !!onEventActivate })}
              onFocus={() => setHover({ kind: "event", label: ev.captured_at.slice(0, 5), sub: ev.camera_code, ...(ev.confidence != null ? { confidence: ev.confidence } : {}), pctLeft: left, hasAction: !!onEventActivate })}
              onBlur={() => setHover(null)}
              aria-label={`${t("calendar.detectionAt", { defaultValue: "Detection at" })} ${ev.captured_at.slice(0, 5)} · ${ev.camera_code}`}
              style={{
                position: "absolute",
                insetInlineStart: `calc(${left}% - 9px)`,
                top: 5,
                width: 18,
                height: 18,
                borderRadius: "50%",
                background: "var(--bg-elev)",
                border: `2.5px solid ${cc}`,
                cursor: onEventActivate ? "pointer" : "default",
                padding: 0,
                zIndex: 1,
                display: "grid",
                placeItems: "center",
                boxShadow: isHov
                  ? `0 0 0 5px color-mix(in oklab, ${cc} 22%, transparent), 0 2px 6px rgba(0,0,0,0.18)`
                  : "0 1px 3px rgba(0,0,0,0.18)",
                transform: isHov ? "scale(1.3)" : "scale(1)",
                transition: "transform 120ms ease, box-shadow 120ms ease",
              }}
            >
              <div style={{ width: 7, height: 7, borderRadius: "50%", background: cc }} />
            </button>
          );
        })}

        {/* First / last detection markers */}
        {inMinutes != null && inMinutes >= viewStart && inMinutes <= viewEnd && (
          <FirstLastMarker kind="first" pctLeft={toLeft(inMinutes)} timeLabel={inTime?.slice(0, 5) ?? ""} label={t("calendar.firstDetection", { defaultValue: "First detection" }) as string} onHover={setHover} />
        )}
        {outMinutes != null && outMinutes !== inMinutes && outMinutes >= viewStart && outMinutes <= viewEnd && (
          <FirstLastMarker kind="last" pctLeft={toLeft(outMinutes)} timeLabel={outTime?.slice(0, 5) ?? ""} label={t("calendar.lastDetection", { defaultValue: "Last detection" }) as string} onHover={setHover} />
        )}

        {/* Hour labels */}
        {hourLabels.map((h) => (
          <div
            key={`lbl-${h}`}
            style={{ position: "absolute", insetInlineStart: `${toLeft(h * 60)}%`, bottom: 3, transform: "translateX(-50%)", fontSize: 10, color: "var(--text-tertiary)", fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}
            aria-hidden
          >
            {String(h).padStart(2, "0")}:00
          </div>
        ))}

        {/* Rich floating tooltip */}
        {hover && (
          <div
            role="tooltip"
            style={{ position: "absolute", insetInlineStart: `${clampTooltipLeft(hover.pctLeft)}%`, transform: "translate(-50%, calc(-100% - 12px))", top: 0, background: "var(--text)", color: "var(--bg-elev)", fontSize: 12, padding: "9px 11px", borderRadius: 8, whiteSpace: "nowrap", pointerEvents: "none", boxShadow: "0 6px 20px rgba(0,0,0,0.3)", zIndex: 10, minWidth: 140 }}
          >
            <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: hover.sub ? 3 : 0 }}>{hover.label}</div>
            {hover.sub && <div style={{ opacity: 0.8, fontSize: 11 }}>{hover.sub}</div>}
            {hover.confidence != null && (
              <div style={{ marginTop: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, opacity: 0.7, marginBottom: 3 }}>
                  <span>{t("calendar.matchConfidence", { defaultValue: "Match confidence" })}</span>
                  <span style={{ fontWeight: 700 }}>{(hover.confidence * 100).toFixed(0)}%</span>
                </div>
                <div style={{ height: 4, borderRadius: 2, background: "rgba(255,255,255,0.2)", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${Math.min(100, hover.confidence * 100)}%`, background: "rgba(255,255,255,0.85)", borderRadius: 2 }} />
                </div>
              </div>
            )}
            {hover.hasAction && (
              <div style={{ marginTop: 6, fontSize: 10.5, opacity: 0.65, borderTop: "1px solid rgba(255,255,255,0.18)", paddingTop: 5 }}>
                {t("calendar.clickForCrop", { defaultValue: "↓ Click to highlight face crop" })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Legend ── */}
      <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", alignItems: "center", gap: "5px 14px", fontSize: 11, color: "var(--text-tertiary)" }}>
        <TimelineLegendItem shape="bar" color="var(--accent)" label={t("calendar.legend.present", { defaultValue: "Present window" })} />
        <TimelineLegendItem shape="dot" color="var(--accent)" label={t("calendar.legend.detection", { defaultValue: "Face detected" })} />
        <TimelineLegendItem shape="pin" color="var(--accent)" label={t("calendar.legend.firstSeen", { defaultValue: "First seen" })} />
        <TimelineLegendItem shape="pin" color="var(--danger-text)" label={t("calendar.legend.lastSeen", { defaultValue: "Last seen" })} />
        {evidence.length > 0 && onEventActivate && (
          <span style={{ marginInlineStart: "auto", fontSize: 10.5, fontStyle: "italic", opacity: 0.6 }}>
            {t("calendar.cropClickHint", { defaultValue: "Click ● to highlight face crop below" })}
          </span>
        )}
      </div>

      {/* ── Summary stat pills ── */}
      <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 8 }}>
        <TimelineStatPill
          dotColor="var(--accent)"
          label={t("calendar.firstDetection", { defaultValue: "First" }) as string}
          value={inTime?.slice(0, 5) ?? "—"}
        />
        <TimelineStatPill
          dotColor="var(--danger-text)"
          label={t("calendar.lastDetection", { defaultValue: "Last" }) as string}
          value={outTime?.slice(0, 5) ?? "—"}
        />
        <TimelineStatPill
          dotColor="var(--text-secondary)"
          label={t("calendar.totalDuration", { defaultValue: "Duration" }) as string}
          value={formatHoursAndMinutes(totalMinutes)}
        />
      </div>
    </div>
  );
}

function TimelineLegendItem({
  shape,
  color,
  label,
}: {
  shape: "bar" | "dot" | "pin";
  color: string;
  label: string;
}) {
  const indicator =
    shape === "bar" ? (
      <span style={{ width: 14, height: 7, borderRadius: 2, background: color, display: "inline-block", flexShrink: 0, opacity: 0.88 }} />
    ) : shape === "dot" ? (
      <span style={{ width: 10, height: 10, borderRadius: "50%", border: `2px solid ${color}`, background: "transparent", display: "inline-block", flexShrink: 0 }} />
    ) : (
      // pin — diamond
      <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: "inline-block", flexShrink: 0, transform: "rotate(45deg)" }} />
    );
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      {indicator}
      <span>{label}</span>
    </span>
  );
}

function TimelineStatPill({
  dotColor,
  label,
  value,
}: {
  dotColor: string;
  label: string;
  value: string;
}) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 11px", borderRadius: 20, border: "1px solid var(--border)", background: "var(--bg-elev)", fontSize: 12 }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor, flexShrink: 0 }} />
      <span style={{ color: "var(--text-tertiary)" }}>{label}</span>
      <span className="mono" style={{ fontWeight: 700, color: "var(--text)" }}>{value}</span>
    </div>
  );
}

function FirstLastMarker({
  kind,
  pctLeft,
  timeLabel,
  label,
  onHover,
}: {
  kind: "first" | "last";
  pctLeft: number;
  timeLabel: string;
  label: string;
  onHover: (h: TimelineHoverInfo | null) => void;
}) {
  const color = kind === "first" ? "var(--accent)" : "var(--danger-text)";
  const tag = kind === "first" ? "IN" : "OUT";
  return (
    <div
      style={{ position: "absolute", insetInlineStart: `calc(${pctLeft}% - 7px)`, top: 20, width: 14, pointerEvents: "auto", zIndex: 2 }}
      onMouseEnter={() => onHover({ kind: "marker", label: `${label} · ${timeLabel}`, pctLeft })}
      onMouseLeave={() => onHover(null)}
      aria-label={`${label} ${timeLabel}`}
    >
      {/* Vertical line */}
      <div style={{ position: "absolute", insetInlineStart: 6, top: 0, height: 30, width: 2, background: color, borderRadius: 1, opacity: 0.8 }} />
      {/* Diamond at top */}
      <div style={{ position: "absolute", insetInlineStart: 2, top: -4, width: 10, height: 10, background: color, transform: "rotate(45deg)", borderRadius: 2, boxShadow: "0 0 0 2px var(--bg-elev)" }} />
      {/* IN / OUT tag below */}
      <div style={{ position: "absolute", insetInlineStart: "50%", transform: "translateX(-50%)", top: 32, fontSize: 8.5, fontWeight: 800, color: color, letterSpacing: "0.05em", whiteSpace: "nowrap" }}>
        {tag}
      </div>
    </div>
  );
}
