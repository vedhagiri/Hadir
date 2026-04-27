// Drawer that surfaces a worker's recent_errors deque + the last
// 20 audit_log rows tagged ``capture.worker.*``.

import { useTranslation } from "react-i18next";

import { Icon } from "../../shell/Icon";
import { useWorkerErrors } from "./hooks";

interface Props {
  cameraId: number;
  cameraName: string;
  onClose: () => void;
}

export function RecentErrorsDrawer({ cameraId, cameraName, onClose }: Props) {
  const { t } = useTranslation();
  const errors = useWorkerErrors(cameraId);

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          <div>
            <div className="mono text-xs text-dim">
              {t("operations.errors.title") as string}
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>
              {cameraName}
            </div>
          </div>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label={t("common.close") as string}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="drawer-body">
          {errors.isLoading && (
            <div className="text-sm text-dim">
              {t("common.loading") as string}
            </div>
          )}
          {errors.isError && (
            <div
              className="text-sm"
              style={{ color: "var(--danger-text)" }}
            >
              {t("operations.errors.loadFailed") as string}
            </div>
          )}
          {errors.data && (
            <>
              <SectionLabel>
                {t("operations.errors.recent") as string}
                {errors.data.recent_errors.length > 0 &&
                  ` · ${errors.data.recent_errors.length}`}
              </SectionLabel>
              {errors.data.recent_errors.length === 0 ? (
                <div className="text-sm text-dim" style={{ marginBottom: 16 }}>
                  {t("operations.errors.noneRecent") as string}
                </div>
              ) : (
                <ul
                  style={{
                    listStyle: "none",
                    padding: 0,
                    margin: "0 0 16px 0",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    overflow: "hidden",
                  }}
                >
                  {errors.data.recent_errors.map((line, i) => (
                    <li
                      key={i}
                      style={{
                        padding: "6px 10px",
                        fontFamily: "var(--font-mono)",
                        fontSize: 11.5,
                        color: "var(--text)",
                        borderBottom:
                          i < errors.data.recent_errors.length - 1
                            ? "1px solid var(--border)"
                            : "none",
                        background:
                          i % 2 === 0 ? "transparent" : "var(--bg-sunken)",
                      }}
                    >
                      {line}
                    </li>
                  ))}
                </ul>
              )}

              <SectionLabel>
                {t("operations.errors.auditLog") as string}
                {errors.data.audit_log_errors.length > 0 &&
                  ` · ${errors.data.audit_log_errors.length}`}
              </SectionLabel>
              {errors.data.audit_log_errors.length === 0 ? (
                <div className="text-sm text-dim">
                  {t("operations.errors.noneAudit") as string}
                </div>
              ) : (
                <ul
                  style={{
                    listStyle: "none",
                    padding: 0,
                    margin: 0,
                  }}
                >
                  {errors.data.audit_log_errors.map((row) => (
                    <li
                      key={row.id}
                      style={{
                        padding: "8px 10px",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-sm)",
                        marginBottom: 6,
                        fontSize: 12,
                      }}
                    >
                      <div className="mono text-xs text-dim">
                        {row.created_at
                          ? new Date(row.created_at).toLocaleString()
                          : "—"}
                      </div>
                      <div style={{ fontWeight: 500 }}>{row.action}</div>
                      {Object.keys(row.after).length > 0 && (
                        <div
                          className="mono text-xs text-dim"
                          style={{ marginTop: 2, wordBreak: "break-word" }}
                        >
                          {JSON.stringify(row.after)}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              <a
                href={`/audit?action=capture.worker&entity_id=${cameraId}`}
                style={{
                  display: "inline-block",
                  marginTop: 12,
                  fontSize: 12,
                  color: "var(--accent)",
                  textDecoration: "underline",
                }}
              >
                {t("operations.errors.viewFullLog") as string}
              </a>
            </>
          )}
        </div>
        <div className="drawer-foot">
          <button className="btn" onClick={onClose}>
            {t("common.close") as string}
          </button>
        </div>
      </div>
    </>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
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
