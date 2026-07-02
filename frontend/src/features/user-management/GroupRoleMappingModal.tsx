// Entra group → Maugood role mapping. Admin picks which security group
// grants which role during sync. Explicit + auditable.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ModalShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import { ROLE_ORDER } from "./shared";
import { useEntraGroups, useGroupRoles, usePutGroupRoles } from "./hooks";
import type { GroupRoleEntry } from "./types";

export function GroupRoleMappingModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const existing = useGroupRoles();
  const groups = useEntraGroups(true);
  const put = usePutGroupRoles();

  const [rows, setRows] = useState<GroupRoleEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (existing.data && !hydrated) {
      setRows(existing.data.entries);
      setHydrated(true);
    }
  }, [existing.data, hydrated]);

  const addRow = () =>
    setRows((r) => [...r, { group_id: "", group_name: "", role_code: "Employee" }]);
  const removeRow = (i: number) => setRows((r) => r.filter((_, idx) => idx !== i));
  const patchRow = (i: number, patch: Partial<GroupRoleEntry>) =>
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));

  const onSave = async () => {
    setError(null);
    const clean = rows.filter((r) => r.group_id.trim());
    try {
      await put.mutateAsync({ entries: clean });
      onClose();
    } catch {
      setError(t("userManagement.mappingSaveFailed"));
    }
  };

  const groupOptions = groups.data ?? [];

  return (
    <ModalShell onClose={onClose}>
      <div
        role="dialog"
        aria-label={t("userManagement.mappingTitle")}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 620,
          maxWidth: "96vw",
          maxHeight: "92vh",
          background: "var(--bg)",
          border: "1px solid var(--border-strong)",
          borderRadius: 16,
          zIndex: 60,
          boxShadow: "0 24px 64px rgba(0,0,0,0.18)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-elev)",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 14.5 }}>
              {t("userManagement.mappingTitle")}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 2 }}>
              {t("userManagement.mappingSubtitle")}
            </div>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label={t("common.close", { defaultValue: "Close" })}
            onClick={onClose}
            style={{ fontSize: 18, lineHeight: 1 }}
          >
            ×
          </button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
          {groups.isError && (
            <div style={{ fontSize: 12, color: "var(--warning-text, #b45309)" }}>
              {t("userManagement.mappingGroupsFailed")}
            </div>
          )}

          {rows.length === 0 && (
            <div style={{ fontSize: 13, color: "var(--text-secondary)", padding: "8px 0" }}>
              {t("userManagement.mappingEmpty")}
            </div>
          )}

          {rows.map((row, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {groupOptions.length > 0 ? (
                <select
                  className="input"
                  value={row.group_id}
                  onChange={(e) => {
                    const g = groupOptions.find((x) => x.id === e.target.value);
                    patchRow(i, {
                      group_id: e.target.value,
                      group_name: g?.name ?? row.group_name,
                    });
                  }}
                  style={{ flex: 2 }}
                >
                  <option value="">{t("userManagement.selectGroup")}</option>
                  {groupOptions.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name || g.id}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="input"
                  value={row.group_id}
                  onChange={(e) => patchRow(i, { group_id: e.target.value })}
                  placeholder={t("userManagement.groupIdPlaceholder")}
                  style={{ flex: 2 }}
                />
              )}
              <Icon name="chevronRight" size={14} />
              <select
                className="input"
                value={row.role_code}
                onChange={(e) => patchRow(i, { role_code: e.target.value })}
                style={{ flex: 1 }}
              >
                {ROLE_ORDER.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-sm"
                aria-label={t("userManagement.removeMapping")}
                onClick={() => removeRow(i)}
                style={{ color: "var(--danger-text)", borderColor: "var(--danger-border)" }}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          ))}

          <button
            type="button"
            className="btn btn-sm"
            onClick={addRow}
            style={{ alignSelf: "flex-start", marginTop: 4 }}
          >
            <Icon name="plus" size={13} />
            {t("userManagement.addMapping")}
          </button>

          {error && (
            <div
              role="alert"
              style={{
                background: "var(--danger-soft)",
                color: "var(--danger-text)",
                padding: "8px 12px",
                borderRadius: "var(--radius-sm)",
                fontSize: 12.5,
              }}
            >
              {error}
            </div>
          )}
        </div>

        <div
          style={{
            padding: "14px 20px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-elev)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <button type="button" className="btn" onClick={onClose} disabled={put.isPending}>
            {t("userManagement.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void onSave()}
            disabled={put.isPending}
          >
            {put.isPending ? t("userManagement.saving") : t("userManagement.saveMapping")}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
