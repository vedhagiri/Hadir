// Admin-only modal that drives ``POST /api/identification/rematch``.
// Replays past detection_events through the current matcher cache so
// newly-uploaded reference photos retroactively assign employee_id on
// historical events. Idempotent — operator can re-run the same date
// any number of times after each new photo upload.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { api, ApiError } from "../../api/client";
import { DatePicker, todayIso } from "../../components/DatePicker";
import { Icon } from "../../shell/Icon";
import { toast } from "../../shell/Toaster";

interface Props {
  onClose: () => void;
}

interface RematchResult {
  events_scanned: number;
  matches_added: number;
  matches_changed: number;
  attendance_recomputed: number;
}

export function RematchModal({ onClose }: Props) {
  const { t } = useTranslation();
  const [from, setFrom] = useState<string>(todayIso());
  const [to, setTo] = useState<string>(todayIso());
  const [onlyUnidentified, setOnlyUnidentified] = useState(true);
  const [recompute, setRecompute] = useState(true);
  const [running, setRunning] = useState(false);
  const [last, setLast] = useState<RematchResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function runOnce() {
    setRunning(true);
    setErr(null);
    try {
      const result = await api<RematchResult>("/api/identification/rematch", {
        method: "POST",
        body: {
          from,
          to,
          only_unidentified: onlyUnidentified,
          recompute_attendance: recompute,
        },
      });
      setLast(result);
      let msg = t("rematch.toastScanned", {
        scanned: result.events_scanned,
        matched: result.matches_added,
      });
      if (result.matches_changed > 0) {
        msg += t("rematch.toastChanged", { n: result.matches_changed });
      }
      if (recompute && result.attendance_recomputed > 0) {
        msg += t("rematch.toastRecomputed", { count: result.attendance_recomputed });
      }
      toast.success(msg);
    } catch (e) {
      const msg =
        e instanceof ApiError ? e.message : t("rematch.networkError");
      setErr(msg);
      toast.error(msg);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-label={t("rematch.ariaLabel")}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "grid",
        placeItems: "center",
        zIndex: 80,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 520,
          maxWidth: "calc(100vw - 32px)",
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-md, 10px)",
          boxShadow:
            "0 12px 40px rgba(0,0,0,0.25), 0 4px 12px rgba(0,0,0,0.1)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>
              {t("rematch.title")}
            </div>
            <div className="text-xs text-dim" style={{ marginTop: 2 }}>
              {t("rematch.sub")}
            </div>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label={t("rematch.closeAria")}
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label
              className="text-xs text-dim"
              style={{ display: "block", marginBottom: 6, fontWeight: 500 }}
            >
              {t("rematch.dateRange")}
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <DatePicker
                value={from}
                onChange={(next) => {
                  setFrom(next);
                  if (to < next) setTo(next);
                }}
                max={todayIso()}
                ariaLabel={t("rematch.fromDateAria")}
              />
              <span
                style={{
                  fontSize: 12,
                  color: "var(--text-tertiary)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                →
              </span>
              <DatePicker
                value={to}
                onChange={setTo}
                min={from}
                max={todayIso()}
                ariaLabel={t("rematch.toDateAria")}
              />
            </div>
          </div>

          <label
            style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}
          >
            <input
              type="checkbox"
              checked={onlyUnidentified}
              onChange={(e) => setOnlyUnidentified(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span style={{ fontSize: 13 }}>
              {t("rematch.onlyUnidentified")}
              <div className="text-xs text-dim" style={{ marginTop: 2 }}>
                {t("rematch.onlyUnidentifiedHint")}
              </div>
            </span>
          </label>

          <label
            style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}
          >
            <input
              type="checkbox"
              checked={recompute}
              onChange={(e) => setRecompute(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span style={{ fontSize: 13 }}>
              {t("rematch.recompute")}
              <div className="text-xs text-dim" style={{ marginTop: 2 }}>
                {t("rematch.recomputeHint")}
              </div>
            </span>
          </label>

          {last && (
            <div
              style={{
                padding: "10px 12px",
                background: "var(--bg-sunken)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                fontSize: 12.5,
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "4px 16px",
              }}
            >
              <span className="text-dim">{t("rematch.eventsScanned")}</span>
              <span className="mono">{last.events_scanned}</span>
              <span className="text-dim">{t("rematch.matchesAdded")}</span>
              <span className="mono" style={{ color: "var(--success)" }}>
                {last.matches_added}
              </span>
              <span className="text-dim">{t("rematch.matchesChanged")}</span>
              <span className="mono">{last.matches_changed}</span>
              <span className="text-dim">{t("rematch.attendanceRecomputed")}</span>
              <span className="mono">{last.attendance_recomputed}</span>
            </div>
          )}

          {err && (
            <div
              className="text-sm"
              style={{
                color: "var(--danger-text)",
                padding: "8px 10px",
                background: "var(--danger-soft)",
                borderRadius: "var(--radius-sm)",
              }}
            >
              {err}
            </div>
          )}
        </div>

        <div
          style={{
            padding: "12px 18px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span className="text-xs text-dim">
            {from === to
              ? t("rematch.oneDay", { date: from })
              : t("rematch.dateRangeDisplay", { from, to })}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              {t("rematch.close")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void runOnce()}
              disabled={running}
            >
              {running ? t("rematch.running") : last ? t("rematch.runAgain") : t("rematch.run")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
