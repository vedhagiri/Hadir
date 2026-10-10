// Settings → Request reasons. Admin-only CRUD on the reason category
// list employees see when filing a new request. Two segmented tables
// (Exception / Leave) so the operator can extend each list separately.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "../api/client";
import { Icon } from "../shell/Icon";
import {
  useCreateReasonCategory,
  useDeleteReasonCategory,
  usePatchReasonCategory,
  useReasonCategoriesAll,
} from "./hooks";
import type { ReasonCategory, RequestType } from "./types";
import { SkeletonTable } from "../components/Skeleton";
import { EmptyPanel } from "../components/ListPageUi";
import { Field, FormFooter, FormNotice, FormSection } from "../components/FormKit";
import { ConfirmModal, SettingsFormModal } from "../settings/settingsUi";
import { Alert, SectionHead, SoftPill, TableCard, WF_ICON, WfSvg, errorDetail } from "./workflowUi";

export function ReasonCategoriesPage() {
  const { t } = useTranslation();
  const all = useReasonCategoriesAll(true);
  const [error, setError] = useState<string | null>(null);

  const exceptionRows = (all.data ?? []).filter(
    (c) => c.request_type === "exception",
  );
  const leaveRows = (all.data ?? []).filter(
    (c) => c.request_type === "leave",
  );

  return (
    <div className="wf-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("reasonCategories.title")}</h1>
          <p className="page-sub">{t("reasonCategories.subtitle")}</p>
        </div>
      </div>

      {error && <Alert>{error}</Alert>}

      {all.isLoading ? (
        <>
          <SkeletonTable rows={4} cols={4} />
          <SkeletonTable rows={4} cols={4} />
        </>
      ) : all.error ? (
        <div className="card">
          <EmptyPanel
            tone="danger"
            icon={<WfSvg>{WF_ICON.alert}</WfSvg>}
            title={t("reasonCategories.loadFailed")}
            body={errorDetail(all.error, t("common.errorGeneric"))}
            actions={
              <button type="button" className="btn" onClick={() => void all.refetch()}>
                <Icon name="refresh" size={12} /> {t("common.retry", { defaultValue: "Retry" })}
              </button>
            }
          />
        </div>
      ) : (
        <>
          <CategoryTable
            title={t("reasonCategories.exceptionTitle")}
            requestType="exception"
            rows={exceptionRows}
            onError={setError}
          />
          <CategoryTable
            title={t("reasonCategories.leaveTitle")}
            requestType="leave"
            rows={leaveRows}
            onError={setError}
          />
        </>
      )}
    </div>
  );
}

function CategoryTable({
  title,
  requestType,
  rows,
  onError,
}: {
  title: string;
  requestType: RequestType;
  rows: ReasonCategory[];
  onError: (msg: string | null) => void;
}) {
  const { t } = useTranslation();
  const create = useCreateReasonCategory();
  const patch = usePatchReasonCategory();
  const del = useDeleteReasonCategory();

  const [showCreate, setShowCreate] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ReasonCategory | null>(null);

  const closeCreate = () => {
    setShowCreate(false);
    setFormError(null);
  };

  const submit = async () => {
    if (!code.trim() || !name.trim()) return;
    onError(null);
    setFormError(null);
    try {
      await create.mutateAsync({
        request_type: requestType,
        code: code.trim(),
        name: name.trim(),
      });
      setCode("");
      setName("");
      setShowCreate(false);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : t("reasonCategories.saveFailed"));
    }
  };
  const typeLabel =
    requestType === "leave"
      ? t("settingsUi.forms.reasons.leave", { defaultValue: "leave" })
      : t("settingsUi.forms.reasons.exception", { defaultValue: "exception" });

  return (
    <section className="wf-stack">
      <SectionHead
        title={title}
        sub={t("reasonCategories.countSub", {
          defaultValue: "{{active}} of {{total}} shown to employees",
          active: rows.filter((r) => r.active).length,
          total: rows.length,
        })}
        actions={
          <button type="button" className="btn btn-sm" onClick={() => setShowCreate(true)}>
            <Icon name="plus" size={12} /> {t("reasonCategories.addBtn")}
          </button>
        }
      />
      {showCreate && (
        <SettingsFormModal
          titleId={`rc-create-title-${requestType}`}
          icon={<Icon name="clipboard" size={18} />}
          title={t("settingsUi.forms.reasons.addTitle", { defaultValue: "Add {{type}} reason", type: typeLabel })}
          subtitle={t("settingsUi.forms.reasons.addSub", {
            defaultValue: "Employees pick this reason when they file {{type}} requests. New reasons are shown straight away.",
            type: typeLabel,
          })}
          onClose={closeCreate}
          onSubmit={() => void submit()}
          footer={
            <FormFooter
              onCancel={closeCreate}
              submitLabel={t("settingsUi.forms.reasons.addCta", { defaultValue: "Add reason" })}
              submittingLabel={t("reasonCategories.saving")}
              submitting={create.isPending}
              canSubmit={code.trim() !== "" && name.trim() !== ""}
            />
          }
        >
          {formError && <FormNotice tone="danger">{formError}</FormNotice>}
          <FormSection
            title={t("settingsUi.forms.reasons.section", { defaultValue: "Reason" })}
            description={t("settingsUi.forms.reasons.sectionDesc", {
              defaultValue: "A short unique code plus the label employees see.",
            })}
          >
            <Field label={t("reasonCategories.fieldCode")} required htmlFor={`rc-code-${requestType}`}>
              <input
                id={`rc-code-${requestType}`}
                className="input mono"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={t("reasonCategories.codePlaceholder")}
                required
              />
            </Field>
            <Field label={t("reasonCategories.fieldName")} required htmlFor={`rc-name-${requestType}`}>
              <input
                id={`rc-name-${requestType}`}
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("reasonCategories.namePlaceholder")}
                required
              />
            </Field>
          </FormSection>
        </SettingsFormModal>
      )}
      {deleting && (
        <ConfirmModal
          titleId="rc-delete-title"
          title={t("settingsUi.forms.reasons.deleteTitle", { defaultValue: "Delete reason" })}
          subtitle={deleting.name}
          confirmLabel={t("reasonCategories.delete")}
          busy={del.isPending}
          onConfirm={() => del.mutate(deleting.id, { onSettled: () => setDeleting(null) })}
          onClose={() => setDeleting(null)}
        >
          <p className="st-confirm-text">{t("reasonCategories.confirmDelete", { code: deleting.code })}</p>
        </ConfirmModal>
      )}
      {rows.length === 0 ? (
        <div className="card">
          <EmptyPanel
            tone="accent"
            icon={<WfSvg>{WF_ICON.file}</WfSvg>}
            title={t("reasonCategories.emptyTitle", { defaultValue: "No reasons in this list" })}
            body={t("reasonCategories.empty")}
            actions={
              <button type="button" className="btn" onClick={() => setShowCreate(true)}>
                <Icon name="plus" size={12} /> {t("reasonCategories.addBtn")}
              </button>
            }
          />
        </div>
      ) : (
        <TableCard>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 80 }}>{t("reasonCategories.colOrder")}</th>
                <th>{t("reasonCategories.colCode")}</th>
                <th>{t("reasonCategories.colName")}</th>
                <th>{t("reasonCategories.colStatus")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono text-xs">{r.display_order}</td>
                  <td className="mono wf-nowrap">{r.code}</td>
                  <td>{r.name}</td>
                  <td>
                    <SoftPill tone={r.active ? "success" : "neutral"}>
                      {r.active ? t("reasonCategories.statusActive") : t("reasonCategories.statusInactive")}
                    </SoftPill>
                  </td>
                  <td className="wf-nowrap" style={{ textAlign: "end" }}>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() =>
                        patch.mutate({
                          id: r.id,
                          input: { active: !r.active },
                        })
                      }
                      disabled={patch.isPending}
                    >
                      {r.active ? t("reasonCategories.hide") : t("reasonCategories.activate")}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost wf-danger-text"
                      onClick={() => setDeleting(r)}
                      disabled={del.isPending}
                    >
                      <Icon name="trash" size={11} /> {t("reasonCategories.delete")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableCard>
      )}
    </section>
  );
}
