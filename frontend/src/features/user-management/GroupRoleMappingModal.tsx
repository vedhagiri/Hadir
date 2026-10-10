// Entra group → Maugood role mapping. Admin picks which security group
// grants which role during sync. Explicit + auditable.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ModalShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import { FormFooter, FormHeader, FormNotice, FormSection } from "../../components/FormKit";
import "../employees/people.css";
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
      <div className="pp-modal-host">
        <form
          role="dialog"
          aria-modal="true"
          aria-labelledby="group-role-title"
          className="modal fk-modal pp-fk-wide"
          onSubmit={(e) => {
            e.preventDefault();
            if (!put.isPending) void onSave();
          }}
        >
          <FormHeader
            titleId="group-role-title"
            icon={<Icon name="shield" size={18} />}
            title={t("userManagement.mappingTitle")}
            subtitle={t("userManagement.mappingSubtitle")}
            onClose={onClose}
          />

          <div className="fk-body">
            {error && <FormNotice tone="danger" title={error} />}
            {groups.isError && (
              <FormNotice tone="warning" title={t("userManagement.mappingGroupsFailed")} />
            )}

            <FormSection
              columns={1}
              title={t("userManagement.mappingRulesTitle", { defaultValue: "Mapping rules" })}
              description={t("userManagement.mappingRulesHelp", {
                defaultValue: "Members of a group get its role on the next sync. Rows without a group are ignored.",
              })}
              aside={
                rows.length > 0 ? (
                  <span className="pill pill-neutral">{rows.length}</span>
                ) : undefined
              }
            >
              {rows.length === 0 ? (
                <div className="pp-dashed-note pp-m0">{t("userManagement.mappingEmpty")}</div>
              ) : (
                <div className="pp-map-list">
                  <div className="pp-map-row pp-map-head" aria-hidden>
                    <span>{t("userManagement.mappingGroupCol", { defaultValue: "Entra group" })}</span>
                    <span />
                    <span>{t("userManagement.colRole")}</span>
                    <span />
                  </div>
                  {rows.map((row, i) => (
                    <div key={i} className="pp-map-row">
                      {groupOptions.length > 0 ? (
                        <select
                          className="select"
                          aria-label={t("userManagement.selectGroup")}
                          value={row.group_id}
                          onChange={(e) => {
                            const g = groupOptions.find((x) => x.id === e.target.value);
                            patchRow(i, {
                              group_id: e.target.value,
                              group_name: g?.name ?? row.group_name,
                            });
                          }}
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
                          className="input mono"
                          aria-label={t("userManagement.groupIdPlaceholder")}
                          value={row.group_id}
                          onChange={(e) => patchRow(i, { group_id: e.target.value })}
                          placeholder={t("userManagement.groupIdPlaceholder")}
                        />
                      )}
                      <span className="pp-map-arrow" aria-hidden>
                        <Icon name="chevronRight" size={14} />
                      </span>
                      <select
                        className="select"
                        aria-label={t("userManagement.colRole")}
                        value={row.role_code}
                        onChange={(e) => patchRow(i, { role_code: e.target.value })}
                      >
                        {ROLE_ORDER.map((r) => (
                          <option key={r} value={r}>
                            {t(`role.${r}`, { defaultValue: r })}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="icon-btn pp-text-danger"
                        aria-label={t("userManagement.removeMapping")}
                        title={t("userManagement.removeMapping")}
                        onClick={() => removeRow(i)}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div>
                <button type="button" className="btn btn-sm" onClick={addRow}>
                  <Icon name="plus" size={13} />
                  {t("userManagement.addMapping")}
                </button>
              </div>
            </FormSection>
          </div>

          <FormFooter
            onCancel={onClose}
            submitLabel={t("userManagement.saveMapping")}
            submitting={put.isPending}
            submittingLabel={t("userManagement.saving")}
            showRequiredNote={false}
          />
        </form>
      </div>
    </ModalShell>
  );
}
