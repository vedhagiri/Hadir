// Admin-only modal that drives ``POST /api/identification/rematch``.
// Replays past detection_events through the current matcher cache so
// newly-uploaded reference photos retroactively assign employee_id on
// historical events. Idempotent — operator can re-run the same date
// any number of times after each new photo upload.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { api, ApiError } from "../../api/client";
import { DatePicker, todayIso } from "../../components/DatePicker";
import { ModalShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import { toast } from "../../shell/Toaster";
import { fieldDateStyle } from "../attendance/attendanceUi";

import "./reports.css";

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
    <ModalShell onClose={onClose}>
      <div className="rp-modal-center">
        <div
          className="modal rp-modal"
          role="dialog"
          aria-modal="true"
          aria-label={t("rematch.ariaLabel")}
        >
          <div className="modal-head rp-modal-head">
            <div>
              <h3 className="modal-title">{t("rematch.title")}</h3>
              <div className="rp-modal-sub">{t("rematch.sub")}</div>
            </div>
            <button
              type="button"
              className="icon-btn"
              onClick={onClose}
              aria-label={t("rematch.closeAria")}
              title={t("rematch.closeAria")}
              disabled={running}
            >
              <Icon name="x" size={14} />
            </button>
          </div>

          <div className="modal-body at-form">
            <div className="field">
              <span className="field-label">{t("rematch.dateRange")}</span>
              <div className="rp-range">
                <DatePicker
                  value={from}
                  onChange={(next) => {
                    setFrom(next);
                    if (to < next) setTo(next);
                  }}
                  max={todayIso()}
                  ariaLabel={t("rematch.fromDateAria")}
                  triggerStyle={fieldDateStyle}
                />
                <span aria-hidden className="rp-range-arrow">→</span>
                <DatePicker
                  value={to}
                  onChange={setTo}
                  min={from}
                  max={todayIso()}
                  ariaLabel={t("rematch.toDateAria")}
                  triggerStyle={fieldDateStyle}
                />
              </div>
            </div>

            <label className="rp-check">
              <input
                type="checkbox"
                checked={onlyUnidentified}
                onChange={(e) => setOnlyUnidentified(e.target.checked)}
              />
              <span>
                <span className="rp-check-title">{t("rematch.onlyUnidentified")}</span>
                <span className="rp-check-sub">
                  {t("rematch.onlyUnidentifiedHint")}
                </span>
              </span>
            </label>

            <label className="rp-check">
              <input
                type="checkbox"
                checked={recompute}
                onChange={(e) => setRecompute(e.target.checked)}
              />
              <span>
                <span className="rp-check-title">{t("rematch.recompute")}</span>
                <span className="rp-check-sub">
                  {t("rematch.recomputeHint")}
                </span>
              </span>
            </label>

            {last && (
              <dl className="rp-kv" aria-live="polite">
                <dt>{t("rematch.eventsScanned")}</dt>
                <dd className="mono">{last.events_scanned.toLocaleString()}</dd>
                <dt>{t("rematch.matchesAdded")}</dt>
                <dd className="mono tone-success">{last.matches_added.toLocaleString()}</dd>
                <dt>{t("rematch.matchesChanged")}</dt>
                <dd className="mono">{last.matches_changed.toLocaleString()}</dd>
                <dt>{t("rematch.attendanceRecomputed")}</dt>
                <dd className="mono">{last.attendance_recomputed.toLocaleString()}</dd>
              </dl>
            )}

            {err && (
              <div className="rp-alert" role="alert">
                {err}
              </div>
            )}
          </div>

          <div className="modal-foot">
            <span className="rp-modal-foot-note">
              {from === to
                ? t("rematch.oneDay", { date: from })
                : t("rematch.dateRangeDisplay", { from, to })}
            </span>
            <button type="button" className="btn" onClick={onClose} disabled={running}>
              {t("rematch.close")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void runOnce()}
              disabled={running}
            >
              <Icon name="refresh" size={12} />
              {running ? t("rematch.running") : last ? t("rematch.runAgain") : t("rematch.run")}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
