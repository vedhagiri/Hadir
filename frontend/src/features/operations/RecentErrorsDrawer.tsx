// Drawer that surfaces a worker's recent_errors deque + the last
// 20 audit_log rows tagged ``capture.worker.*``.

import { useTranslation } from "react-i18next";
import { DrawerShell } from "../../components/DrawerShell";

import { Icon } from "../../shell/Icon";
import { useWorkerErrors } from "./hooks";
import { SkeletonLines } from "../../components/Skeleton";
import { EmptyPanel } from "../../components/ListPageUi";
import { SectionLabel } from "../system/opsUi";

interface Props {
  cameraId: number;
  cameraName: string;
  onClose: () => void;
}

export function RecentErrorsDrawer({ cameraId, cameraName, onClose }: Props) {
  const { t } = useTranslation();
  const errors = useWorkerErrors(cameraId);

  return (
    <DrawerShell onClose={onClose}>
      <div className="drawer">
        <div className="drawer-head">
          <div>
            <div className="text-xs text-dim">{t("operations.errors.title") as string}</div>
            <div className="drawer-title" style={{ fontSize: 16, marginTop: 2 }}>{cameraName}</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t("common.close") as string}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="drawer-body">
          {errors.isLoading && <SkeletonLines lines={6} />}
          {errors.isError && (
            <EmptyPanel
              tone="danger"
              icon={<Icon name="info" size={30} />}
              title={t("operations.errors.loadFailed") as string}
              body={t("operations.errors.loadFailedBody", { defaultValue: "The worker's error buffer could not be read." })}
              actions={
                <button type="button" className="btn" onClick={() => void errors.refetch()}>
                  <Icon name="refresh" size={12} />
                  {t("common.retry", { defaultValue: "Retry" })}
                </button>
              }
            />
          )}
          {errors.data && (
            <>
              <SectionLabel>
                {t("operations.errors.recent") as string}
                {errors.data.recent_errors.length > 0 && ` · ${errors.data.recent_errors.length}`}
              </SectionLabel>
              {errors.data.recent_errors.length === 0 ? (
                <div className="text-sm text-dim" style={{ marginBottom: 16 }}>
                  {t("operations.errors.noneRecent") as string}
                </div>
              ) : (
                <ul className="ops-log-list">
                  {errors.data.recent_errors.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              )}

              <SectionLabel>
                {t("operations.errors.auditLog") as string}
                {errors.data.audit_log_errors.length > 0 && ` · ${errors.data.audit_log_errors.length}`}
              </SectionLabel>
              {errors.data.audit_log_errors.length === 0 ? (
                <div className="text-sm text-dim">{t("operations.errors.noneAudit") as string}</div>
              ) : (
                <ul className="ops-audit-list">
                  {errors.data.audit_log_errors.map((row) => (
                    <li key={row.id}>
                      <div className="mono text-xs text-dim">
                        {row.created_at ? new Date(row.created_at).toLocaleString() : "—"}
                      </div>
                      <div style={{ fontWeight: 600 }}>{row.action}</div>
                      {Object.keys(row.after).length > 0 && (
                        <div className="mono text-xs text-dim" style={{ marginTop: 2, wordBreak: "break-word" }}>
                          {JSON.stringify(row.after)}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              <a href={`/audit?action=capture.worker&entity_id=${cameraId}`} className="ops-link">
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
    </DrawerShell>
  );
}
