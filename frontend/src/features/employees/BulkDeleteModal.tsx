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
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 60,
          display: "grid",
          placeItems: "center",
        }}
      >
        <div
          className="card"
          style={{
            width: "min(520px, 92vw)",
            padding: 22,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Icon name="trash" size={16} />
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>
              {scope === "all"
                ? (t("employees.bulkDelete.titleAll") as string)
                : (t("employees.bulkDelete.titleSelected", {
                    count: selectedCount,
                  }) as string)}
            </h2>
          </div>

          {!result && (
            <>
              <p
                style={{
                  margin: 0,
                  color: "var(--text-secondary)",
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                {scope === "all"
                  ? (t("employees.bulkDelete.descAll") as string)
                  : (t("employees.bulkDelete.descSelected", {
                      count: selectedCount,
                    }) as string)}
              </p>

              <fieldset
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-sm)",
                  padding: 12,
                  margin: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <legend
                  style={{
                    fontSize: 11,
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    color: "var(--text-tertiary)",
                    padding: "0 4px",
                  }}
                >
                  {t("employees.bulkDelete.modeLabel") as string}
                </legend>
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
              </fieldset>

              {mode === "hard" && (
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span
                    style={{
                      fontSize: 11,
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      color: "var(--text-tertiary)",
                    }}
                  >
                    {t("employees.bulkDelete.phraseLabel", {
                      phrase: PDPL_PHRASE,
                    }) as string}
                  </span>
                  <input
                    type="text"
                    value={phrase}
                    onChange={(e) => setPhrase(e.target.value)}
                    placeholder={PDPL_PHRASE}
                    style={{
                      padding: "8px 10px",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-sm)",
                      fontSize: 13,
                      fontFamily: "var(--font-mono)",
                      background: "var(--bg)",
                      color: "var(--text)",
                    }}
                    autoFocus
                  />
                </label>
              )}

              {mutation.error && (
                <div
                  role="alert"
                  style={{
                    background: "var(--danger-soft)",
                    color: "var(--danger-text)",
                    padding: "8px 10px",
                    borderRadius: "var(--radius-sm)",
                    fontSize: 12.5,
                  }}
                >
                  {bulkDeleteError(mutation.error)}
                </div>
              )}

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button
                  className="btn"
                  onClick={onClose}
                  disabled={mutation.isPending}
                >
                  {t("common.cancel") as string}
                </button>
                <button
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
              <div
                style={{
                  background: "var(--success-soft)",
                  border: "1px solid var(--border)",
                  padding: "10px 12px",
                  borderRadius: "var(--radius-sm)",
                  fontSize: 13,
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                <div style={{ fontWeight: 600 }}>
                  {t("employees.bulkDelete.resultTitle") as string}
                </div>
                <div className="text-sm">
                  {t("employees.bulkDelete.resultCounts", {
                    deleted: result.deleted,
                    skipped: result.skipped,
                    requested: result.requested,
                  }) as string}
                </div>
              </div>

              {result.errors.length > 0 && (
                <div
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      padding: "8px 10px",
                      background: "var(--bg-sunken)",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    {t("employees.bulkDelete.errorsHeading", {
                      count: result.errors.length,
                    }) as string}
                  </div>
                  <div style={{ maxHeight: 180, overflowY: "auto" }}>
                    {result.errors.map((e) => (
                      <div
                        key={e.row}
                        style={{
                          padding: "6px 10px",
                          fontSize: 12,
                          borderTop: "1px solid var(--border)",
                        }}
                      >
                        <span className="mono">#{e.row}</span> · {e.message}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button className="btn btn-primary" onClick={onClose}>
                  <Icon name="check" size={12} />
                  {t("common.done") as string}
                </button>
              </div>
            </>
          )}
        </div>
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
      onClick={onSelect}
      style={{
        textAlign: "start",
        padding: "10px 12px",
        border: selected
          ? `1px solid ${danger ? "var(--danger-text)" : "var(--accent)"}`
          : "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        background: selected ? "var(--bg-sunken)" : "transparent",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 2,
        fontFamily: "var(--font-sans)",
      }}
    >
      <span
        style={{
          fontWeight: 600,
          fontSize: 13,
          color: danger && selected ? "var(--danger-text)" : "var(--text)",
        }}
      >
        {title}
      </span>
      <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{body}</span>
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
