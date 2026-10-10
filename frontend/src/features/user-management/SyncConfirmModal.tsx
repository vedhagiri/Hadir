// Confirmation popup shown before running an Entra directory sync.
// Lets the operator choose whether synced users a group mapping doesn't
// cover should get the default Employee role. On confirm it runs the
// sync with `default_role` set accordingly.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ModalShell } from "../../components/DrawerShell";
import { Field, FormFooter, FormHeader, FormNotice, FormSection, SwitchField } from "../../components/FormKit";
import { Icon } from "../../shell/Icon";
import "../employees/people.css";

const ROLE_OPTIONS = ["Employee", "Manager", "HR", "Admin"] as const;

export function SyncConfirmModal({
  onClose,
  onConfirm,
  pending,
}: {
  onClose: () => void;
  // Receives the chosen default role (or null for "no default") and
  // whether to also create linked employee records.
  onConfirm: (defaultRole: string | null, createEmployees: boolean) => void;
  pending: boolean;
}) {
  const { t } = useTranslation();
  // "" is the "no default role" sentinel → sent as null.
  const [defaultRole, setDefaultRole] = useState<string>("Employee");
  const [createEmployees, setCreateEmployees] = useState(true);

  return (
    <ModalShell onClose={pending ? () => {} : onClose}>
      <div className="pp-modal-host">
        <form
          role="dialog"
          aria-modal="true"
          aria-labelledby="sync-confirm-title"
          className="modal fk-modal"
          onSubmit={(e) => {
            e.preventDefault();
            if (pending) return;
            onConfirm(defaultRole || null, createEmployees);
          }}
        >
          <FormHeader
            titleId="sync-confirm-title"
            icon={<Icon name="refresh" size={18} />}
            title={t("userManagement.syncModal.title")}
            subtitle={t("userManagement.syncModal.subtitle")}
            {...(pending ? {} : { onClose })}
          />

          <div className="fk-body">
            <FormSection
              columns={1}
              title={t("userManagement.syncModal.optionsTitle", { defaultValue: "Sync options" })}
              description={t("userManagement.syncModal.optionsHelp", {
                defaultValue: "Decide what new users get on their first sync. You can change any of it later.",
              })}
            >
              <Field
                label={t("userManagement.syncModal.defaultRoleLabel")}
                htmlFor="sync-default-role"
                help={t("userManagement.syncModal.defaultRoleHint")}
              >
                <select
                  id="sync-default-role"
                  className="select"
                  value={defaultRole}
                  onChange={(e) => setDefaultRole(e.target.value)}
                  disabled={pending}
                >
                  {ROLE_OPTIONS.map((r) => (
                    <option key={r} value={r}>
                      {t(`role.${r}`, { defaultValue: r })}
                    </option>
                  ))}
                  <option value="">{t("userManagement.syncModal.noDefaultRole")}</option>
                </select>
              </Field>

              <SwitchField
                id="sync-create-employees"
                label={t("userManagement.syncModal.createEmployeeTitle")}
                description={t("userManagement.syncModal.createEmployeeHint")}
                checked={createEmployees}
                onChange={setCreateEmployees}
                disabled={pending}
              />
            </FormSection>

            <FormNotice tone="info">{t("userManagement.syncModal.note")}</FormNotice>
          </div>

          <FormFooter
            onCancel={onClose}
            submitLabel={
              <>
                <Icon name="refresh" size={13} />
                {t("userManagement.syncModal.confirm")}
              </>
            }
            submitting={pending}
            submittingLabel={t("userManagement.syncing")}
            showRequiredNote={false}
          />
        </form>
      </div>
    </ModalShell>
  );
}
