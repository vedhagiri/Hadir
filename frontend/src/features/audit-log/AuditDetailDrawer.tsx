// Audit entry detail drawer. Read-only: the sentence, who / when / what,
// network origin when the payload carries it, a before → after diff of
// the JSON payload (changed fields highlighted), the raw JSON behind a
// disclosure, and a reminder that the log is append-only.

import { useMemo } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { DrawerShell } from "../../components/DrawerShell";
import { FormHeader } from "../../components/FormKit";
import { RelativeTime } from "../../components/RelativeTime";
import { Icon } from "../../shell/Icon";
import { useTenantDateTime } from "../../util/datetime";
import { ActorCell } from "./auditUi";
import { actionText, categoryText, entityHref, entityText, severityText } from "./catalog";
import type { AuditEntry } from "./types";

type Row = { key: string; before: string | undefined; after: string | undefined; changed: boolean };

const REDACTED = "[redacted]";

// Opaque tokens never need to be read in full (defence in depth — the
// API already redacts them).
const MASK_KEYS = new Set(["session_id", "token", "push_token", "refresh_token"]);

function show(v: unknown, key: string): string {
  if (v === null) return "null";
  if (typeof v === "string") return MASK_KEYS.has(key) && v.length > 10 ? `${v.slice(0, 6)}…` : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/** Flatten one level of nesting into dotted keys so a nested config
 *  change (``capture_config.min_face_quality_to_save``) shows as one row. */
function flatten(obj: Record<string, unknown> | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!obj) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length <= 20) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) out.set(`${k}.${k2}`, show(v2, k2));
    } else {
      out.set(k, show(v, k));
    }
  }
  return out;
}

function maskDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskDeep);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      o[k] = MASK_KEYS.has(k) && typeof x === "string" && x.length > 10 ? `${x.slice(0, 6)}…` : maskDeep(x);
    }
    return o;
  }
  return v;
}

function pick(entry: AuditEntry, key: string): string | null {
  for (const blob of [entry.after, entry.before]) {
    const v = blob?.[key];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

export function AuditDetailDrawer({
  entry,
  onClose,
  onPrev,
  onNext,
}: {
  entry: AuditEntry;
  onClose: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
}) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const href = entityHref(entry);

  const rows = useMemo((): Row[] => {
    const b = flatten(entry.before);
    const a = flatten(entry.after);
    const keys = Array.from(new Set([...b.keys(), ...a.keys()]));
    const both = entry.before !== null && entry.after !== null;
    return keys
      .map((key) => ({ key, before: b.get(key), after: a.get(key), changed: both && b.get(key) !== a.get(key) }))
      .sort((x, y) => Number(y.changed) - Number(x.changed));
  }, [entry]);
  const hasBoth = entry.before !== null && entry.after !== null;
  // The API replaces secrets (session ids, tokens, passwords…) with
  // "[redacted]" before they ever reach the browser.
  const val = (v: string | undefined) =>
    v === undefined ? (
      "—"
    ) : v === REDACTED ? (
      <span className="al-hidden">
        <Icon name="eyeOff" size={12} />
        {t("auditLog.detail.hidden", { defaultValue: "hidden for security" })}
      </span>
    ) : (
      v
    );
  const changedCount = rows.filter((r) => r.changed).length;
  const ip = pick(entry, "ip") ?? pick(entry, "ip_address");
  const ua = pick(entry, "user_agent");
  const utc = new Date(entry.created_at).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  const sevTone = entry.severity === "high" ? "danger" : entry.severity === "warning" ? "warning" : "neutral";

  return (
    <DrawerShell onClose={onClose}>
      <div className="drawer fk-drawer al-drawer" role="dialog" aria-labelledby="al-detail-title">
        <FormHeader
          titleId="al-detail-title"
          icon={<Icon name="shield" size={18} />}
          eyebrow={categoryText(t, entry.category)}
          title={actionText(t, entry.action)}
          subtitle={<bdi className="al-ltr">{`${dt.formatDate(entry.created_at)} ${dt.formatTimeWithSeconds(entry.created_at)}`}</bdi>}
          actions={
            entry.severity !== "info" ? (
              <span className={`pill pill-${sevTone}`}>
                <span aria-hidden className="pill-dot" />
                {severityText(t, entry.severity)}
              </span>
            ) : undefined
          }
          onClose={onClose}
        />

        <div className="drawer-body al-drawer-body">
          <dl className="al-facts">
            <Fact label={t("auditLog.detail.who", { defaultValue: "Who" })}>
              <ActorCell entry={entry} />
            </Fact>
            <Fact label={t("auditLog.detail.when", { defaultValue: "When" })}>
              <bdi className="mono">{dt.formatTimeWithSeconds(entry.created_at)}</bdi>
              <span className="al-dim">
                {" · "}
                <bdi>{dt.formatDate(entry.created_at)}</bdi>
              </span>
              {Date.now() - new Date(entry.created_at).getTime() < 6 * 86_400_000 && (
                <span className="al-dim">
                  {" · "}
                  <RelativeTime iso={entry.created_at} />
                </span>
              )}
              <div className="al-fact-sub mono">
                <bdi className="al-ltr">{utc}</bdi>
              </div>
            </Fact>
            <Fact label={t("auditLog.detail.what", { defaultValue: "What" })}>
              <div>{actionText(t, entry.action)}</div>
              <div className="al-fact-sub mono">{entry.action}</div>
            </Fact>
            <Fact label={t("auditLog.detail.record", { defaultValue: "Record" })}>
              {href ? (
                <Link to={href} className="al-entity-link">
                  {entityText(t, entry)}
                  <Icon name="chevronRight" size={11} />
                </Link>
              ) : (
                entityText(t, entry)
              )}
            </Fact>
            {ip && (
              <Fact label={t("auditLog.detail.ip", { defaultValue: "IP address" })}>
                <span className="mono">{ip}</span>
              </Fact>
            )}
            {ua && (
              <Fact label={t("auditLog.detail.ua", { defaultValue: "Browser" })}>
                <span className="al-break">{ua}</span>
              </Fact>
            )}
            <Fact label={t("auditLog.detail.entryId", { defaultValue: "Entry ID" })}>
              <span className="mono">#{entry.id}</span>
            </Fact>
          </dl>

          <section>
            <h3 className="al-section-title">
              {hasBoth
                ? t("auditLog.detail.changes", { defaultValue: "Changes" })
                : t("auditLog.detail.details", { defaultValue: "Details" })}
              {hasBoth && (
                <span className="al-section-meta">
                  {t("auditLog.detail.changedCount", { n: changedCount, defaultValue: "{{n}} field(s) changed" })}
                </span>
              )}
            </h3>
            {rows.length === 0 ? (
              <p className="al-dim al-nodata">{t("auditLog.detail.noPayload", { defaultValue: "No extra details were recorded for this event." })}</p>
            ) : (
              <div className="al-diff-wrap">
                <table className="al-diff">
                  <thead>
                    <tr>
                      <th>{t("auditLog.detail.field", { defaultValue: "Field" })}</th>
                      {hasBoth || entry.before !== null ? <th>{t("auditLog.detail.before", { defaultValue: "Before" })}</th> : null}
                      {hasBoth || entry.after !== null ? <th>{t("auditLog.detail.after", { defaultValue: "After" })}</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key} className={r.changed ? "is-changed" : undefined}>
                        <td className="mono al-diff-key">{r.key}</td>
                        {(hasBoth || entry.before !== null) && <td dir="auto" className={`al-diff-val${r.changed ? " is-old" : ""}`}>{val(r.before)}</td>}
                        {(hasBoth || entry.after !== null) && <td dir="auto" className={`al-diff-val${r.changed ? " is-new" : ""}`}>{val(r.after)}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <details className="al-raw">
            <summary>{t("auditLog.detail.raw", { defaultValue: "Raw JSON" })}</summary>
            <div className="al-raw-grid">
              <div>
                <div className="al-raw-label">{t("auditLog.detail.before", { defaultValue: "Before" })}</div>
                <pre>{entry.before === null ? "—" : JSON.stringify(maskDeep(entry.before), null, 2)}</pre>
              </div>
              <div>
                <div className="al-raw-label">{t("auditLog.detail.after", { defaultValue: "After" })}</div>
                <pre>{entry.after === null ? "—" : JSON.stringify(maskDeep(entry.after), null, 2)}</pre>
              </div>
            </div>
          </details>

          <p className="al-lock">
            <Icon name="shield" size={13} />
            {t("auditLog.detail.appendOnly", {
              defaultValue: "This entry is permanent. The audit log is append-only and can't be edited or deleted.",
            })}
          </p>
        </div>

        <div className="drawer-foot al-drawer-foot">
          <div className="al-drawer-nav">
            <button type="button" className="btn btn-sm" onClick={onPrev ?? undefined} disabled={!onPrev}>
              <Icon name="chevronLeft" size={12} />
              {t("auditLog.detail.newer", { defaultValue: "Newer" })}
            </button>
            <button type="button" className="btn btn-sm" onClick={onNext ?? undefined} disabled={!onNext}>
              {t("auditLog.detail.older", { defaultValue: "Older" })}
              <Icon name="chevronRight" size={12} />
            </button>
          </div>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.close", { defaultValue: "Close" })}
          </button>
        </div>
      </div>
    </DrawerShell>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="al-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
