// Bulk delete modal — Admin only. Two scopes (selected / all) and
// two modes (soft / hard). Hard mode requires the operator to type
// the PDPL confirmation phrase exactly; soft mode submits with one
// click. The page passes the selected ids in; the modal owns the
// confirmation state, the mutation lifecycle, and the result view.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "../../api/client";
import { ModalShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import {
  useBulkDeleteEmployees,
  type BulkDeleteResponse,
} from "./hooks";
import { Banner } from "./peopleUi";

const PDPL_PHRASE = "I CONFIRM PDPL DELETION";

interface Props {
  scope: "selected" | "all";
  selectedIds: number[];
  selectedCount: number;
  onClose: () => void;
  onSubmitted: (result: BulkDeleteResponse) => void;
}

export function BulkDeleteModal({
  scope,
  selectedIds,
  selectedCount,
  onClose,
  onSubmitted,
}: Props) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"soft" | "hard">("soft");
  const [phrase, setPhrase] = useState("");
  const mutation = useBulkDeleteEmployees();
  const result = mutation.data;

  const phraseOk = phrase === PDPL_PHRASE;
  const submitDisabled =
    mutation.isPending || (mode === "hard" && !phraseOk);

  const onSubmit = async () => {
    try {
      const payload: import("./hooks").BulkDeleteRequest = { scope, mode };
      if (scope === "selected") payload.ids = selectedIds;
      if (mode === "hard") payload.confirmation = PDPL_PHRASE;
      const r = await mutation.mutateAsync(payload);
      onSubmitted(r);
    } catch {
      // mutation.error renders below
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <div role="dialog" aria-modal="true" className="modal pp-modal pp-modal-wide">
        <div className="modal-head pp-modal-head">
          <span aria-hidden className="pp-modal-icon tone-danger">
            <Icon name="trash" size={15} />
          </span>
          <div className="pp-modal-head-text">
            <h2 className="modal-title">
              {scope === "all"
                ? (t("employees.bulkDelete.titleAll") as string)
                : (t("employees.bulkDelete.titleSelected", {
                    count: selectedCount,
                  }) as string)}
            </h2>
          </div>
        </div>

        {!result && (
          <>
            <div className="modal-body pp-stack" style={{ gap: 14 }}>
              <p className="text-sm text-dim" style={{ margin: 0, lineHeight: 1.5 }}>
                {scope === "all"
                  ? (t("employees.bulkDelete.descAll") as string)
                  : (t("employees.bulkDelete.descSelected", {
                      count: selectedCount,
                    }) as string)}
              </p>

              <div className="field" role="radiogroup" aria-label={t("employees.bulkDelete.modeLabel") as string}>
                <span className="field-label">
                  {t("employees.bulkDelete.modeLabel") as string}
                </span>
                <div className="pp-role-list">
                  <ModeOption
                    selected={mode === "soft"}
                    onSelect={() => setMode("soft")}
                    title={t("employees.bulkDelete.softTitle") as string}
                    body={t("employees.bulkDelete.softBody") as string}
                  />
                  <ModeOption
                    selected={mode === "hard"}
                    onSelect={() => setMode("hard")}
                    title={t("employees.bulkDelete.hardTitle") as string}
                    body={t("employees.bulkDelete.hardBody") as string}
                    danger
                  />
                </div>
              </div>

              {mode === "hard" && (
                <div className="field">
                  <label className="field-label" htmlFor="pp-bulk-phrase">
                    {t("employees.bulkDelete.phraseLabel", {
                      phrase: PDPL_PHRASE,
                    }) as string}
                  </label>
                  <input
                    id="pp-bulk-phrase"
                    className="input mono"
                    type="text"
                    value={phrase}
                    onChange={(e) => setPhrase(e.target.value)}
                    placeholder={PDPL_PHRASE}
                    autoFocus
                  />
                </div>
              )}

              {mutation.error && (
                <Banner tone="danger" role="alert" title={bulkDeleteError(mutation.error)} />
              )}
            </div>

            <div className="modal-foot">
              <button
                type="button"
                className="btn"
                onClick={onClose}
                disabled={mutation.isPending}
              >
                {t("common.cancel") as string}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={onSubmit}
                disabled={submitDisabled}
              >
                <Icon name="trash" size={12} />
                {mutation.isPending
                  ? (t("employees.bulkDelete.deleting") as string)
                  : (t("employees.bulkDelete.confirm") as string)}
              </button>
            </div>
          </>
        )}

        {result && (
          <>
            <div className="modal-body pp-stack" style={{ gap: 14 }}>
              <Banner tone="success" role="status" title={t("employees.bulkDelete.resultTitle") as string}>
                {t("employees.bulkDelete.resultCounts", {
                  deleted: result.deleted,
                  skipped: result.skipped,
                  requested: result.requested,
                }) as string}
              </Banner>

              {result.errors.length > 0 && (
                <div className="pp-error-list">
                  <div className="pp-error-list-head">
                    {t("employees.bulkDelete.errorsHeading", {
                      count: result.errors.length,
                    }) as string}
                  </div>
                  <div className="pp-error-list-body">
                    {result.errors.map((e) => (
                      <div key={e.row} className="pp-error-list-row">
                        <span className="mono">#{e.row}</span> · {e.message}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="modal-foot">
              <button type="button" className="btn btn-primary" onClick={onClose}>
                <Icon name="check" size={12} />
                {t("common.done") as string}
              </button>
            </div>
          </>
        )}
      </div>
    </ModalShell>
  );
}

function ModeOption({
  selected,
  onSelect,
  title,
  body,
  danger,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  body: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`radio-card${selected ? " active" : ""}`}
    >
      <div>
        <div className={`pp-mode-title${danger && selected ? " pp-text-danger" : ""}`}>{title}</div>
        <div className="pp-mode-sub">{body}</div>
      </div>
      {selected && <Icon name="check" size={16} />}
    </button>
  );
}

function bulkDeleteError(err: unknown): string {
  if (err instanceof ApiError) {
    const detail = (err.body as { detail?: unknown } | null)?.detail;
    if (typeof detail === "string" && detail.length > 0) return detail;
  }
  return "Bulk delete failed.";
}
