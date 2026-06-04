// Shift Policies — master/detail layout (matches the prototype
// reference at docs/scripts/shift_policy_screen/01-shift-policy-list-view.png).
//
// Left column: compact list of every policy with type/range/assignment-
// count + Active/Off pill.
// Right column: detail panel for the selected policy — visual shift-
// window timeline, in/out fields, required + overtime, flag rules.
//
// "+ New policy" opens the existing PolicyForm in a drawer; the
// inline-form approach from the v1.0 P9 build was too noisy for the
// prototype's clean two-column shell.
//
// Reuses existing hooks: usePolicies, useAssignments,
// useCreatePolicy, useDeletePolicy. Assignment edit is reachable
// from this page in a follow-up — for now it surfaces the count.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { ApiError } from "../api/client";
import { DatePicker } from "../components/DatePicker";
import { ModalShell } from "../components/DrawerShell";
import { Icon } from "../shell/Icon";
import { toast } from "../shell/Toaster";
import { PolicyImportModal } from "./PolicyImportModal";
import {
  useAssignments,
  useCreatePolicy,
  useDeletePolicy,
  usePatchPolicy,
  usePolicies,
  useSetPolicyAsDefault,
} from "./hooks";
import type {
  AssignmentResponse,
  PolicyConfig,
  PolicyResponse,
  PolicyType,
} from "./types";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function PoliciesPage() {
  const { t } = useTranslation();
  const policies = usePolicies();
  const assignments = useAssignments();
  const create = useCreatePolicy();
  const del = useDeletePolicy();
  const setDefault = useSetPolicyAsDefault();
  // Three-step import modal (drag-and-drop + preview + confirm) —
  // matches the employees import flow. Replaces the prior inline
  // hidden-file-input that imported in one shot with no preview.
  const [importOpen, setImportOpen] = useState(false);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Edit drawer — opens with a specific policy preloaded into the form.
  // ``null`` keeps it closed; ``PolicyResponse`` opens it pre-filled.
  const [editing, setEditing] = useState<PolicyResponse | null>(null);
  // Delete-confirmation modal. ``null`` keeps it closed; setting it
  // to a policy opens the modal with Soft / Permanent options.
  const [deleting, setDeleting] = useState<PolicyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const policyList = policies.data ?? [];
  const assignmentList = assignments.data ?? [];

  // Auto-select the first policy when the list loads or after a
  // create/delete shifts the index.
  useEffect(() => {
    if (
      selectedId === null &&
      policyList.length > 0 &&
      policyList[0]
    ) {
      setSelectedId(policyList[0].id);
      return;
    }
    if (
      selectedId !== null &&
      !policyList.some((p) => p.id === selectedId) &&
      policyList.length > 0 &&
      policyList[0]
    ) {
      setSelectedId(policyList[0].id);
    }
  }, [policyList, selectedId]);

  const assignmentsByPolicy = useMemo(() => {
    const map: Record<number, AssignmentResponse[]> = {};
    for (const a of assignmentList) {
      (map[a.policy_id] ??= []).push(a);
    }
    return map;
  }, [assignmentList]);

  // The tenant-default policy id is the policy_id of the
  // ``scope_type='tenant'`` assignment row. The resolver picks it as
  // tier-5 fallback (after Custom / Ramadan / employee / department).
  // At most one row is expected; if multiple exist, we treat the first
  // as authoritative — the backend Set-as-default endpoint dedupes
  // on every write.
  const defaultPolicyId = useMemo(() => {
    const row = assignmentList.find(
      (a) => a.scope_type === "tenant" && a.scope_id === null,
    );
    return row ? row.policy_id : null;
  }, [assignmentList]);

  const onSetDefault = async (policyId: number) => {
    setError(null);
    try {
      await setDefault.mutateAsync(policyId);
      const name =
        policyList.find((p) => p.id === policyId)?.name ?? "policy";
      toast.success(t("policies.toast.isNowDefault", { name }));
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? typeof (err.body as { detail?: unknown })?.detail === "string"
            ? String((err.body as { detail?: unknown }).detail)
            : t("policies.toast.setDefaultFailed", { status: err.status })
          : t("policies.toast.setDefaultFailedGeneric");
      setError(msg);
      toast.error(msg);
    }
  };

  const selected = policyList.find((p) => p.id === selectedId) ?? null;

  const onCreate = async (input: {
    name: string;
    type: PolicyType;
    config: PolicyConfig;
    active_from: string;
  }) => {
    setError(null);
    try {
      const created = await create.mutateAsync(input);
      setDrawerOpen(false);
      setSelectedId(created.id);
      toast.success(t("policies.toast.created", { name: created.name }));
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { detail?: unknown } | null;
        const msg =
          typeof body?.detail === "string"
            ? body.detail
            : t("policies.toast.saveFailedStatus", { status: err.status });
        setError(msg);
        toast.error(msg);
      } else {
        setError(t("policies.toast.saveFailed"));
        toast.error(t("policies.toast.saveFailed"));
      }
    }
  };

  // Soft delete: flips ``active_until`` to yesterday on the server.
  // History is preserved; the resolver skips the row going forward.
  // Hard delete: drops the row outright. Server pre-checks for
  // attendance_records references and 409s with a count if any
  // remain — we surface that count to the operator.
  const onDelete = async (
    p: PolicyResponse,
    hard: boolean,
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    try {
      await del.mutateAsync({ policyId: p.id, hard });
      toast.success(
        hard
          ? t("policies.toast.permanentlyDeleted", { name: p.name })
          : t("policies.toast.archived", { name: p.name }),
      );
      setDeleting(null);
      return { ok: true };
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { detail?: unknown } | null;
        let reason = t("policies.toast.deleteFailed", { status: err.status });
        if (err.status === 409 && body?.detail && typeof body.detail === "object") {
          const detail = body.detail as {
            message?: string;
            attendance_records?: number;
          };
          if (typeof detail.message === "string") {
            reason = detail.message;
          }
        } else if (typeof body?.detail === "string") {
          reason = body.detail;
        }
        toast.error(reason);
        return { ok: false, reason };
      }
      const fallback = t("policies.toast.deleteFailedGeneric");
      toast.error(fallback);
      return { ok: false, reason: fallback };
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("policies.title")}</h1>
          <p className="page-sub">{t("policies.sub")}</p>
        </div>
        <div className="page-actions">
          <button
            className="btn"
            onClick={() => setImportOpen(true)}
            title={t("policies.importTitle")}
          >
            <Icon name="upload" size={12} />
            {t("policies.import")}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => setDrawerOpen(true)}
          >
            <Icon name="plus" size={12} />
            {t("policies.newPolicy")}
          </button>
        </div>
      </div>

      {policies.isLoading && (
        <p className="text-sm text-dim">{t("policies.loading")}</p>
      )}
      {policies.isError && (
        <p style={{ color: "var(--danger-text)" }}>
          {t("policies.loadError")}
        </p>
      )}

      {!policies.isLoading && !policies.isError && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(280px, 1fr) minmax(0, 2fr)",
            gap: 16,
            alignItems: "start",
          }}
        >
          {/* Left — list */}
          <div className="card">
            <div className="card-head">
              <h3 className="card-title">{t("policies.listTitle")}</h3>
              <span className="text-xs text-dim">{policyList.length}</span>
            </div>
            <div style={{ padding: 4 }}>
              {policyList.length === 0 && (
                <div
                  className="text-sm text-dim"
                  style={{ padding: 16, textAlign: "center" }}
                >
                  {t("policies.empty")}
                </div>
              )}
              {policyList.map((p) => {
                const isSelected = p.id === selectedId;
                const isActive = p.active_until === null;
                const isDefault = p.id === defaultPolicyId;
                const rowAssignments = assignmentsByPolicy[p.id] ?? [];
                const subtitle = renderSubtitle(p, rowAssignments, t);
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setSelectedId(p.id)}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      width: "100%",
                      textAlign: "start",
                      background: isSelected
                        ? "var(--accent-soft)"
                        : "transparent",
                      border: "none",
                      borderRadius: "var(--radius-sm)",
                      padding: "10px 12px",
                      cursor: "pointer",
                      color: isSelected
                        ? "var(--accent-text)"
                        : "var(--text)",
                      transition:
                        "background 120ms ease-out, color 120ms ease-out",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: isSelected ? 600 : 500,
                          fontSize: 13.5,
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          flexWrap: "wrap",
                        }}
                      >
                        <span>{p.name}</span>
                        {isDefault && (
                          <span
                            className="pill pill-accent"
                            title={t("policies.defaultTitle")}
                            style={{
                              fontSize: 9.5,
                              padding: "1px 6px",
                              letterSpacing: "0.02em",
                              textTransform: "uppercase",
                              fontWeight: 700,
                            }}
                          >
                            {t("policies.default")}
                          </span>
                        )}
                      </div>
                      <div
                        className="mono text-xs text-dim"
                        style={{ marginTop: 2, lineHeight: 1.4 }}
                      >
                        {subtitle}
                      </div>
                    </div>
                    <span
                      className={`pill ${
                        isActive ? "pill-success" : "pill-neutral"
                      }`}
                      style={{
                        flexShrink: 0,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        fontSize: 10.5,
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          display: "inline-block",
                          width: 6,
                          height: 6,
                          borderRadius: "50%",
                          background: isActive
                            ? "var(--success)"
                            : "var(--text-tertiary)",
                        }}
                      />
                      {isActive ? t("policies.active") : t("policies.off")}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right — detail */}
          <div className="card" style={{ padding: 18 }}>
            {selected === null ? (
              <div
                className="text-sm text-dim"
                style={{ padding: 32, textAlign: "center" }}
              >
                {t("policies.selectPrompt")}
              </div>
            ) : (
              <PolicyDetail
                policy={selected}
                assignments={assignmentsByPolicy[selected.id] ?? []}
                isDefault={selected.id === defaultPolicyId}
                onSetDefault={() => onSetDefault(selected.id)}
                settingDefault={setDefault.isPending}
                onDelete={() => setDeleting(selected)}
                onEdit={() => setEditing(selected)}
              />
            )}
          </div>
        </div>
      )}

      {drawerOpen && (
        <ModalShell onClose={() => setDrawerOpen(false)}>
          <div
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 60,
              display: "grid",
              placeItems: "center",
              padding: 16,
            }}
          >
            <div
              className="card"
              role="dialog"
              aria-modal="true"
              aria-label={t("policies.newModal.ariaLabel")}
              style={{
                width: "min(620px, 96vw)",
                maxHeight: "86vh",
                overflow: "auto",
              }}
            >
              <div className="card-head">
                <div>
                  <div className="mono text-xs text-dim">{t("policies.newModal.label")}</div>
                  <h3 className="card-title" style={{ marginTop: 2 }}>
                    {t("policies.newModal.title")}
                  </h3>
                </div>
                <button
                  className="icon-btn"
                  onClick={() => setDrawerOpen(false)}
                  aria-label={t("common.close")}
                  title={t("common.close")}
                  disabled={create.isPending}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
              <div className="card-body">
                {error && (
                  <div
                    role="alert"
                    style={{
                      background: "var(--danger-soft)",
                      color: "var(--danger-text)",
                      border: "1px solid var(--border)",
                      padding: "8px 10px",
                      borderRadius: "var(--radius-sm)",
                      fontSize: 12.5,
                      marginBottom: 12,
                    }}
                  >
                    {error}
                  </div>
                )}
                <PolicyForm onSubmit={onCreate} busy={create.isPending} />
              </div>
            </div>
          </div>
        </ModalShell>
      )}
      {editing && (
        <PolicyEditDrawer
          policy={editing}
          onClose={() => setEditing(null)}
        />
      )}
      {importOpen && (
        <PolicyImportModal onClose={() => setImportOpen(false)} />
      )}
      {deleting && (
        <DeletePolicyModal
          policy={deleting}
          busy={del.isPending}
          onClose={() => setDeleting(null)}
          onConfirm={(hard) => onDelete(deleting, hard)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// DeletePolicyModal — two-option confirm. Soft delete is the default
// and presented as the safe choice; permanent delete is the danger
// path with the server's reference-count error surfaced inline when
// the request comes back 409.
// ---------------------------------------------------------------------------

function DeletePolicyModal({
  policy,
  busy,
  onClose,
  onConfirm,
}: {
  policy: PolicyResponse;
  busy: boolean;
  onClose: () => void;
  onConfirm: (
    hard: boolean,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
}) {
  const { t } = useTranslation();
  const [hardError, setHardError] = useState<string | null>(null);
  const [pending, setPending] = useState<"soft" | "hard" | null>(null);

  const run = async (hard: boolean) => {
    setHardError(null);
    setPending(hard ? "hard" : "soft");
    const result = await onConfirm(hard);
    setPending(null);
    if (!result.ok && hard) {
      setHardError(result.reason);
    }
  };

  return (
    <ModalShell onClose={busy ? () => {} : onClose}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 60,
          display: "grid",
          placeItems: "center",
          padding: 16,
        }}
      >
        <div
          className="card"
          role="dialog"
          aria-modal="true"
          aria-label={t("policies.deleteModal.ariaLabel", { name: policy.name })}
          style={{
            width: "min(540px, 96vw)",
            maxHeight: "86vh",
            overflow: "auto",
          }}
        >
          <div className="card-head">
            <div>
              <div className="mono text-xs text-dim">{t("policies.deleteModal.label")}</div>
              <h3 className="card-title" style={{ marginTop: 2 }}>
                {t("policies.deleteModal.title", { name: policy.name })}
              </h3>
            </div>
            <button
              className="icon-btn"
              onClick={onClose}
              aria-label={t("common.close")}
              title={t("common.close")}
              disabled={busy}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
          <div className="card-body" style={{ display: "grid", gap: 12 }}>
            <p
              className="text-sm text-dim"
              style={{ margin: 0, lineHeight: 1.5 }}
            >
              {t("policies.deleteModal.body")}
            </p>

            <DeleteOption
              title={t("policies.deleteModal.softTitle")}
              description={t("policies.deleteModal.softDesc")}
              actionLabel={t("policies.deleteModal.softAction")}
              workingLabel={t("policies.deleteModal.working")}
              actionClass="btn"
              busy={pending === "soft"}
              disabled={busy}
              onClick={() => run(false)}
            />

            <DeleteOption
              title={t("policies.deleteModal.hardTitle")}
              description={t("policies.deleteModal.hardDesc")}
              actionLabel={t("policies.deleteModal.hardAction")}
              workingLabel={t("policies.deleteModal.working")}
              actionClass="btn btn-danger"
              busy={pending === "hard"}
              disabled={busy}
              danger
              onClick={() => run(true)}
              error={hardError}
            />
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

function DeleteOption({
  title,
  description,
  actionLabel,
  workingLabel,
  actionClass,
  busy,
  disabled,
  danger = false,
  onClick,
  error,
}: {
  title: string;
  description: string;
  actionLabel: string;
  workingLabel: string;
  actionClass: string;
  busy: boolean;
  disabled: boolean;
  danger?: boolean;
  onClick: () => void;
  error?: string | null;
}) {
  return (
    <div
      style={{
        border: `1px solid ${danger ? "var(--danger)" : "var(--border)"}`,
        borderRadius: "var(--radius-sm)",
        padding: 12,
        background: danger ? "var(--danger-soft)" : "var(--bg)",
        display: "grid",
        gap: 8,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 13.5 }}>{title}</div>
      <div
        className="text-xs text-dim"
        style={{ lineHeight: 1.5, margin: 0 }}
      >
        {description}
      </div>
      {error && (
        <div
          role="alert"
          style={{
            background: "var(--bg)",
            border: "1px solid var(--danger)",
            color: "var(--danger-text)",
            padding: "6px 8px",
            borderRadius: "var(--radius-sm)",
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          className={actionClass}
          onClick={onClick}
          disabled={disabled || busy}
        >
          {busy ? workingLabel : actionLabel}
        </button>
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Edit modal — centered popup (not a side drawer per operator request).
// Same form as create, seeded with the current policy's values + a
// ``usePatchPolicy`` save handler. The ``type`` field is locked because
// the server's PolicyPatchInput does not accept a type change (delete
// + recreate is the right path if the operator actually wants to
// switch types).
// ---------------------------------------------------------------------------

function PolicyEditDrawer({
  policy,
  onClose,
}: {
  policy: PolicyResponse;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const patch = usePatchPolicy(policy.id);
  const [error, setError] = useState<string | null>(null);

  const onSave = async (input: {
    name: string;
    type: PolicyType;
    config: PolicyConfig;
    active_from: string;
  }) => {
    setError(null);
    try {
      // PolicyPatchInput accepts name + config + active_from + active_until.
      // ``type`` is ignored on the server but the form still carries it;
      // we drop it explicitly here to keep the request shape honest.
      const updated = await patch.mutateAsync({
        name: input.name,
        config: input.config,
        active_from: input.active_from,
      });
      toast.success(t("policies.toast.updated", { name: updated.name }));
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { detail?: unknown } | null;
        const msg =
          typeof body?.detail === "string"
            ? body.detail
            : t("policies.toast.saveFailedStatus", { status: err.status });
        setError(msg);
        toast.error(msg);
      } else {
        setError(t("policies.toast.saveFailed"));
        toast.error(t("policies.toast.saveFailed"));
      }
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
          padding: 16,
        }}
      >
        <div
          className="card"
          role="dialog"
          aria-modal="true"
          aria-label={t("policies.editModal.ariaLabel", { name: policy.name })}
          style={{
            width: "min(620px, 96vw)",
            maxHeight: "86vh",
            overflow: "auto",
          }}
        >
          <div className="card-head">
            <div>
              <div className="mono text-xs text-dim">{t("policies.editModal.label")}</div>
              <h3
                className="card-title"
                style={{ marginTop: 2 }}
              >
                {t("policies.editModal.title", { name: policy.name })}
              </h3>
            </div>
            <button
              className="icon-btn"
              onClick={onClose}
              aria-label={t("common.close")}
              title={t("common.close")}
              disabled={patch.isPending}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
          <div className="card-body">
            {error && (
              <div
                role="alert"
                style={{
                  background: "var(--danger-soft)",
                  color: "var(--danger-text)",
                  border: "1px solid var(--border)",
                  padding: "8px 10px",
                  borderRadius: "var(--radius-sm)",
                  fontSize: 12.5,
                  marginBottom: 12,
                }}
              >
                {error}
              </div>
            )}
            <PolicyForm
              onSubmit={onSave}
              busy={patch.isPending}
              initial={policy}
            />
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Detail panel — shift window ribbon + fields + flag rules
// ---------------------------------------------------------------------------

function PolicyDetail({
  policy,
  assignments,
  isDefault,
  onSetDefault,
  settingDefault,
  onDelete,
  onEdit,
}: {
  policy: PolicyResponse;
  assignments: AssignmentResponse[];
  isDefault: boolean;
  onSetDefault: () => void;
  settingDefault: boolean;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const cfg = policy.config;
  const requiredHours = cfg.required_hours ?? 8;
  const isActive = policy.active_until === null;
  const isFlexShape =
    policy.type === "Flex" ||
    (policy.type === "Custom" && cfg.inner_type === "Flex");

  return (
    <>
      {/* Header — name + type pill + actions */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 4,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <h2
              style={{ margin: 0, fontSize: 18, fontWeight: 600 }}
            >
              {policy.name}
            </h2>
            <span className="pill pill-accent">{policy.type}</span>
            {isDefault && (
              <span
                className="pill pill-accent"
                title={t("policies.detail.defaultPillTitle")}
                style={{
                  fontSize: 10.5,
                  padding: "2px 8px",
                  letterSpacing: "0.02em",
                  textTransform: "uppercase",
                  fontWeight: 700,
                }}
              >
                {t("policies.default")}
              </span>
            )}
            {!isActive && <span className="pill pill-neutral">{t("policies.off")}</span>}
          </div>
        </div>
        {!isDefault && isActive && (
          <button
            className="btn btn-sm"
            onClick={onSetDefault}
            disabled={settingDefault}
            title={t("policies.detail.setAsDefaultTitle")}
          >
            <Icon name="check" size={11} />{" "}
            {settingDefault ? t("policies.detail.settingDefault") : t("policies.detail.setAsDefault")}
          </button>
        )}
        <button
          className="btn btn-sm"
          onClick={onEdit}
          title={t("policies.detail.editTitle")}
        >
          <Icon name="edit" size={11} /> {t("policies.detail.edit")}
        </button>
        <button
          className="icon-btn"
          aria-label={t("policies.detail.deleteAria")}
          onClick={onDelete}
          title={t("policies.detail.deleteTitle")}
        >
          <Icon name="trash" size={13} />
        </button>
      </div>
      <p
        className="text-sm text-dim"
        style={{ marginTop: 0, marginBottom: 16 }}
      >
        {t("policies.detail.mustComplete", { n: requiredHours })}
        {assignments.length > 0 && (
          <>
            {" · "}
            {t("policies.detail.assigned", { n: assignments.length })}
          </>
        )}
      </p>

      {/* SHIFT WINDOW — visual timeline ribbon */}
      <SectionLabel>{t("policies.detail.shiftWindow")}</SectionLabel>
      <ShiftWindowRibbon policy={policy} />

      {/* IN/OUT + REQUIRED + OVERTIME */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
          marginTop: 16,
        }}
      >
        <DetailField
          label={t("policies.detail.inTime")}
          value={
            isFlexShape
              ? `${cfg.in_window_start ?? "—"} – ${cfg.in_window_end ?? "—"}`
              : (cfg.start ?? "—")
          }
          hint={isFlexShape ? t("policies.detail.flexHint") : undefined}
        />
        <DetailField
          label={t("policies.detail.outTime")}
          value={
            isFlexShape
              ? `${cfg.out_window_start ?? "—"} – ${cfg.out_window_end ?? "—"}`
              : (cfg.end ?? "—")
          }
          hint={isFlexShape ? t("policies.detail.flexHint") : undefined}
        />
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
          marginTop: 12,
          marginBottom: 16,
        }}
      >
        <DetailField label={t("policies.detail.requiredHours")} value={String(requiredHours)} />
        <DetailField
          label={t("policies.detail.overtimeThreshold")}
          value={
            cfg.grace_minutes !== undefined
              ? `+${cfg.grace_minutes}m`
              : "—"
          }
        />
      </div>

      {/* FLAG RULES */}
      <SectionLabel>{t("policies.detail.flagRules")}</SectionLabel>
      <FlagRulesList />
    </>
  );
}

function ShiftWindowRibbon({ policy }: { policy: PolicyResponse }) {
  const { t } = useTranslation();
  // Render a 06:00 → 18:00 timeline with tinted bands marking the
  // policy's effective window. For Fixed/Ramadan/Custom-Fixed the
  // band is start..end. For Flex it's the union of arrive (in_window)
  // and depart (out_window) brackets with a "work" middle.
  const HOURS_START = 6;
  const HOURS_END = 18;
  const TOTAL_MIN = (HOURS_END - HOURS_START) * 60;

  const cfg = policy.config;
  const isFlex =
    policy.type === "Flex" ||
    (policy.type === "Custom" && cfg.inner_type === "Flex");

  const minutesOf = (hhmm?: string): number | null => {
    if (!hhmm) return null;
    const [h, m] = hhmm.split(":").map((s) => parseInt(s, 10));
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return (h ?? 0) * 60 + (m ?? 0);
  };

  const pct = (mm: number) =>
    Math.max(
      0,
      Math.min(100, ((mm - HOURS_START * 60) / TOTAL_MIN) * 100),
    );

  // Build the bands.
  const bands: Array<{
    label: string;
    start: number;
    end: number;
    fill: string;
    accent?: boolean;
  }> = [];

  if (isFlex) {
    const inS = minutesOf(cfg.in_window_start);
    const inE = minutesOf(cfg.in_window_end);
    const outS = minutesOf(cfg.out_window_start);
    const outE = minutesOf(cfg.out_window_end);
    if (inS !== null && inE !== null) {
      bands.push({
        label: t("policies.detail.bandArrive"),
        start: inS,
        end: inE,
        fill: "var(--info-soft)",
      });
    }
    if (inE !== null && outS !== null && inE < outS) {
      bands.push({
        label: t("policies.detail.bandWork", { n: cfg.required_hours ?? 8 }),
        start: inE,
        end: outS,
        fill: "var(--accent-soft)",
        accent: true,
      });
    }
    if (outS !== null && outE !== null) {
      bands.push({
        label: t("policies.detail.bandDepart"),
        start: outS,
        end: outE,
        fill: "var(--info-soft)",
      });
    }
  } else {
    const s = minutesOf(cfg.start);
    const e = minutesOf(cfg.end);
    if (s !== null && e !== null) {
      bands.push({
        label: t("policies.detail.bandShift", { n: cfg.required_hours ?? 8 }),
        start: s,
        end: e,
        fill: "var(--accent-soft)",
        accent: true,
      });
    }
  }

  return (
    <div
      style={{
        position: "relative",
        height: 64,
        marginTop: 4,
        background: "var(--bg-sunken)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        padding: "8px 0 0 0",
        overflow: "hidden",
      }}
    >
      {/* Hour ticks */}
      {Array.from({ length: HOURS_END - HOURS_START + 1 }).map((_, i) => {
        const hour = HOURS_START + i;
        const left = (i / (HOURS_END - HOURS_START)) * 100;
        return (
          <div
            key={hour}
            style={{
              position: "absolute",
              insetInlineStart: `${left}%`,
              top: 0,
              bottom: 18,
              width: 1,
              background: "var(--border)",
              opacity: hour % 3 === 0 ? 0.7 : 0.3,
            }}
            aria-hidden
          />
        );
      })}
      {/* Bands */}
      {bands.map((b, i) => {
        const left = pct(b.start);
        const width = pct(b.end) - left;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              insetInlineStart: `${left}%`,
              width: `${width}%`,
              top: 8,
              bottom: 22,
              background: b.fill,
              border: b.accent
                ? "1px solid var(--accent)"
                : "1px solid transparent",
              borderRadius: 4,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              color: b.accent
                ? "var(--accent-text)"
                : "var(--text-secondary)",
              fontWeight: 500,
              overflow: "hidden",
              whiteSpace: "nowrap",
            }}
          >
            {b.label}
          </div>
        );
      })}
      {/* Hour labels along the bottom */}
      <div
        style={{
          position: "absolute",
          insetInlineStart: 0,
          insetInlineEnd: 0,
          bottom: 4,
          display: "flex",
          justifyContent: "space-between",
          fontSize: 10,
          color: "var(--text-tertiary)",
          fontFamily: "var(--font-mono)",
          padding: "0 4px",
        }}
        aria-hidden
      >
        {[6, 8, 10, 12, 14, 16, 18].map((h) => (
          <span key={h}>{String(h).padStart(2, "0")}:00</span>
        ))}
      </div>
    </div>
  );
}

function FlagRulesList() {
  const { t } = useTranslation();
  const rows = [
    {
      label: t("policies.flags.lateIn.label"),
      when: t("policies.flags.lateIn.when"),
      action: t("policies.flags.lateIn.action"),
    },
    {
      label: t("policies.flags.earlyOut.label"),
      when: t("policies.flags.earlyOut.when"),
      action: t("policies.flags.earlyOut.action"),
    },
    {
      label: t("policies.flags.overtime.label"),
      when: t("policies.flags.overtime.when"),
      action: t("policies.flags.overtime.action"),
    },
    {
      label: t("policies.flags.absent.label"),
      when: t("policies.flags.absent.when"),
      action: t("policies.flags.absent.action"),
    },
  ];
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        overflow: "hidden",
        marginTop: 4,
      }}
    >
      {rows.map((r, i) => (
        <div
          key={r.label}
          style={{
            display: "grid",
            gridTemplateColumns: "120px 1fr 1.5fr auto",
            alignItems: "center",
            gap: 12,
            padding: "10px 12px",
            borderTop: i === 0 ? "none" : "1px solid var(--border)",
            fontSize: 12.5,
          }}
        >
          <div style={{ fontWeight: 600 }}>{r.label}</div>
          <div className="mono text-xs text-dim">{r.when}</div>
          <div className="text-xs">{r.action}</div>
          <span
            className="pill pill-success"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 10.5,
            }}
          >
            <span
              aria-hidden
              style={{
                display: "inline-block",
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--success)",
              }}
            />
            {t("policies.detail.flagOn")}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// List-row subtitle helpers
// ---------------------------------------------------------------------------

function renderSubtitle(
  p: PolicyResponse,
  assignments: AssignmentResponse[],
  t: TFunction,
): string {
  const range = renderTimeRange(p);
  const count = assignments.length;
  const bits: string[] = [p.type];
  if (range) bits.push(range);
  bits.push(t("policies.assignment", { count }));
  return bits.join(" · ");
}

function renderTimeRange(p: PolicyResponse): string | null {
  const cfg = p.config;
  if (
    p.type === "Fixed" ||
    p.type === "Ramadan" ||
    (p.type === "Custom" && cfg.inner_type !== "Flex")
  ) {
    if (cfg.start && cfg.end) return `${cfg.start} – ${cfg.end}`;
  }
  if (
    p.type === "Flex" ||
    (p.type === "Custom" && cfg.inner_type === "Flex")
  ) {
    if (
      cfg.in_window_start &&
      cfg.in_window_end &&
      cfg.out_window_start &&
      cfg.out_window_end
    ) {
      return `${cfg.in_window_start}–${cfg.in_window_end} → ${cfg.out_window_start}–${cfg.out_window_end}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Detail-side primitives (read-only field row + section label)
// ---------------------------------------------------------------------------

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        color: "var(--text-tertiary)",
        marginTop: 16,
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

function DetailField({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string | undefined;
}) {
  return (
    <div>
      <div
        className="text-xs"
        style={{
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--text-tertiary)",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        className="mono"
        style={{
          fontSize: 14,
          fontWeight: 500,
          padding: "8px 10px",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          background: "var(--bg-elev)",
          color: "var(--text)",
        }}
      >
        {value}
      </div>
      {hint && (
        <div className="text-xs text-dim" style={{ marginTop: 4 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PolicyForm — mounted inside the New-policy drawer.
//
// Carried over from the v1.0 P9 build verbatim so the existing
// validators + Ramadan-default pre-fill continue to work. Only the
// outer surface changed (was an inline form, now sits in a drawer).
// ---------------------------------------------------------------------------

function PolicyForm({
  onSubmit,
  busy,
  initial,
  submitLabel,
}: {
  onSubmit: (input: {
    name: string;
    type: PolicyType;
    config: PolicyConfig;
    active_from: string;
  }) => Promise<void>;
  busy: boolean;
  initial?: PolicyResponse | null | undefined;
  submitLabel?: string | undefined;
}) {
  const { t } = useTranslation();
  const isEdit = !!initial;
  const cfg0 = initial?.config ?? {};
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<PolicyType>(initial?.type ?? "Flex");
  const [activeFrom, setActiveFrom] = useState(
    initial?.active_from ?? new Date().toISOString().slice(0, 10),
  );
  // Fixed (also used by Ramadan + Custom-Fixed)
  const [start, setStart] = useState(cfg0.start ?? "07:30");
  const [end, setEnd] = useState(cfg0.end ?? "15:30");
  const [grace, setGrace] = useState(cfg0.grace_minutes ?? 15);
  // Flex (also used by Custom-Flex)
  const [inStart, setInStart] = useState(cfg0.in_window_start ?? "07:30");
  const [inEnd, setInEnd] = useState(cfg0.in_window_end ?? "08:30");
  const [outStart, setOutStart] = useState(cfg0.out_window_start ?? "15:30");
  const [outEnd, setOutEnd] = useState(cfg0.out_window_end ?? "16:30");
  // Common
  const [requiredHours, setRequiredHours] = useState(
    cfg0.required_hours ?? 8,
  );
  // Ramadan / Custom — calendar range
  const [rangeStart, setRangeStart] = useState(cfg0.start_date ?? "");
  const [rangeEnd, setRangeEnd] = useState(cfg0.end_date ?? "");
  // Custom — Fixed or Flex inner
  const [innerType, setInnerType] = useState<"Fixed" | "Flex">(
    cfg0.inner_type ?? "Fixed",
  );

  // Client-side validation for the fields the server requires but that
  // can't be enforced by native ``required`` (the date-range pickers are
  // custom components). Without this, an empty Ramadan/Custom range
  // submits and returns an opaque server error.
  const [errors, setErrors] = useState<{
    name?: string;
    rangeStart?: string;
    rangeEnd?: string;
  }>({});
  const clearError = (key: "name" | "rangeStart" | "rangeEnd") =>
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));

  const onTypeChange = (next: PolicyType) => {
    setType(next);
    if (next === "Ramadan" && !rangeStart) {
      setRangeStart("2026-02-18");
      setRangeEnd("2026-03-19");
      setStart("08:00");
      setEnd("14:00");
      setRequiredHours(6);
    }
  };

  const isFixedShape =
    type === "Fixed" ||
    type === "Ramadan" ||
    (type === "Custom" && innerType === "Fixed");

  // Live validity of every required field — drives the submit button's
  // disabled state so "Create policy" only enables once the form can
  // actually be saved. Mirrors the on-submit validation below.
  const isValid = (() => {
    if (!name.trim()) return false;
    if (!activeFrom) return false;
    if (isFixedShape) {
      if (!start || !end) return false;
    } else {
      if (!inStart || !inEnd || !outStart || !outEnd) return false;
    }
    if (!requiredHours || requiredHours < 1) return false;
    if (type === "Ramadan" || type === "Custom") {
      if (!rangeStart || !rangeEnd) return false;
      if (rangeEnd < rangeStart) return false;
    }
    return true;
  })();

  // Live range-order error so the user sees *why* the button is disabled
  // when both dates are filled but out of order (not just on submit).
  const rangeEndError =
    errors.rangeEnd ??
    ((type === "Ramadan" || type === "Custom") &&
    rangeStart &&
    rangeEnd &&
    rangeEnd < rangeStart
      ? t("policies.form.errorRangeEndOrder")
      : undefined);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();

    // Validate required fields the browser can't catch on its own.
    const nextErrors: typeof errors = {};
    if (!name.trim()) nextErrors.name = t("policies.form.errorNameRequired");
    if (type === "Ramadan" || type === "Custom") {
      if (!rangeStart) nextErrors.rangeStart = t("policies.form.errorRangeStartRequired");
      if (!rangeEnd) nextErrors.rangeEnd = t("policies.form.errorRangeEndRequired");
      if (rangeStart && rangeEnd && rangeEnd < rangeStart) {
        nextErrors.rangeEnd = t("policies.form.errorRangeEndOrder");
      }
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    setErrors({});

    const fixedFields = {
      start,
      end,
      grace_minutes: grace,
      required_hours: requiredHours,
    } as const;
    const flexFields = {
      in_window_start: inStart,
      in_window_end: inEnd,
      out_window_start: outStart,
      out_window_end: outEnd,
      required_hours: requiredHours,
    } as const;

    let config: PolicyConfig;
    if (type === "Fixed") {
      config = { ...fixedFields };
    } else if (type === "Flex") {
      config = { ...flexFields };
    } else if (type === "Ramadan") {
      config = {
        ...fixedFields,
        start_date: rangeStart,
        end_date: rangeEnd,
      };
    } else {
      config =
        innerType === "Flex"
          ? {
              ...flexFields,
              start_date: rangeStart,
              end_date: rangeEnd,
              inner_type: "Flex",
            }
          : {
              ...fixedFields,
              start_date: rangeStart,
              end_date: rangeEnd,
              inner_type: "Fixed",
            };
    }

    void onSubmit({
      name: name.trim(),
      type,
      config,
      active_from: activeFrom,
    });
  };

  return (
    <form
      onSubmit={submit}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <SectionCaption>{t("policies.form.sectionIdentity")}</SectionCaption>
      <div style={grid2}>
        <FormField label={t("policies.form.fieldName")} required error={errors.name} span>
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              clearError("name");
            }}
            required
            maxLength={120}
            aria-invalid={!!errors.name}
            style={{
              ...inputStyle,
              borderColor: errors.name
                ? "var(--danger-text, #dc2626)"
                : "var(--border)",
            }}
          />
        </FormField>
        <FormField label={t("policies.form.fieldType")} required>
          <select
            value={type}
            onChange={(e) => onTypeChange(e.target.value as PolicyType)}
            disabled={isEdit}
            title={isEdit ? t("policies.form.typeLockedTitle") : undefined}
            style={{
              ...inputStyle,
              cursor: isEdit ? "not-allowed" : "pointer",
              opacity: isEdit ? 0.7 : 1,
            }}
          >
            <option value="Fixed">Fixed</option>
            <option value="Flex">Flex</option>
            <option value="Ramadan">Ramadan</option>
            <option value="Custom">Custom</option>
          </select>
        </FormField>
        <FormField label={t("policies.form.fieldActiveFrom")} required>
          <DatePicker
            value={activeFrom}
            onChange={setActiveFrom}
            ariaLabel={t("policies.form.fieldActiveFrom")}
            triggerStyle={{ width: "100%" }}
          />
        </FormField>
      </div>

      {/* Date-range picker — Ramadan + Custom only */}
      {(type === "Ramadan" || type === "Custom") && (
        <>
          <SectionCaption>{t("policies.form.sectionDateRange")}</SectionCaption>
          <div style={grid2}>
            <FormField label={t("policies.form.fieldRangeStart")} required error={errors.rangeStart}>
              <DatePicker
                value={rangeStart}
                onChange={(v) => {
                  setRangeStart(v);
                  clearError("rangeStart");
                }}
                ariaLabel={t("policies.form.fieldRangeStart")}
                triggerStyle={{ width: "100%" }}
              />
            </FormField>
            <FormField label={t("policies.form.fieldRangeEnd")} required error={rangeEndError}>
              <DatePicker
                value={rangeEnd}
                onChange={(v) => {
                  setRangeEnd(v);
                  clearError("rangeEnd");
                }}
                min={rangeStart}
                ariaLabel={t("policies.form.fieldRangeEnd")}
                triggerStyle={{ width: "100%" }}
              />
            </FormField>
            {type === "Custom" && (
              <FormField label={t("policies.form.fieldInnerType")} required span>
                <select
                  value={innerType}
                  onChange={(e) =>
                    setInnerType(e.target.value as "Fixed" | "Flex")
                  }
                  style={inputStyle}
                >
                  <option value="Fixed">{t("policies.form.innerFixed")}</option>
                  <option value="Flex">{t("policies.form.innerFlex")}</option>
                </select>
              </FormField>
            )}
          </div>
        </>
      )}

      <SectionCaption>{t("policies.form.sectionShiftWindow")}</SectionCaption>
      {isFixedShape ? (
        <div style={grid2}>
          <FormField label={t("policies.form.fieldStart")} required>
            <input
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              required
              style={inputStyle}
            />
          </FormField>
          <FormField label={t("policies.form.fieldEnd")} required>
            <input
              type="time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              required
              style={inputStyle}
            />
          </FormField>
          <FormField label={t("policies.form.fieldGrace")}>
            <input
              type="number"
              min={0}
              max={180}
              value={grace}
              onChange={(e) =>
                setGrace(Number.parseInt(e.target.value, 10) || 0)
              }
              style={inputStyle}
            />
          </FormField>
          <FormField label={t("policies.form.fieldRequiredHours")} required>
            <input
              type="number"
              min={1}
              max={24}
              value={requiredHours}
              onChange={(e) =>
                setRequiredHours(Number.parseInt(e.target.value, 10) || 1)
              }
              required
              style={inputStyle}
            />
          </FormField>
        </div>
      ) : (
        <div style={grid2}>
          <FormField label={t("policies.form.fieldInWindowStart")} required>
            <input
              type="time"
              value={inStart}
              onChange={(e) => setInStart(e.target.value)}
              required
              style={inputStyle}
            />
          </FormField>
          <FormField label={t("policies.form.fieldInWindowEnd")} required>
            <input
              type="time"
              value={inEnd}
              onChange={(e) => setInEnd(e.target.value)}
              required
              style={inputStyle}
            />
          </FormField>
          <FormField label={t("policies.form.fieldOutWindowStart")} required>
            <input
              type="time"
              value={outStart}
              onChange={(e) => setOutStart(e.target.value)}
              required
              style={inputStyle}
            />
          </FormField>
          <FormField label={t("policies.form.fieldOutWindowEnd")} required>
            <input
              type="time"
              value={outEnd}
              onChange={(e) => setOutEnd(e.target.value)}
              required
              style={inputStyle}
            />
          </FormField>
          <FormField label={t("policies.form.fieldRequiredHours")} required span>
            <input
              type="number"
              min={1}
              max={24}
              value={requiredHours}
              onChange={(e) =>
                setRequiredHours(Number.parseInt(e.target.value, 10) || 1)
              }
              required
              style={inputStyle}
            />
          </FormField>
        </div>
      )}

      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
          marginTop: 4,
        }}
      >
        <button
          type="submit"
          disabled={busy || !isValid}
          title={!isValid ? t("policies.form.submitRequired") : undefined}
          className="btn btn-primary"
        >
          {busy
            ? t("policies.form.saving")
            : (submitLabel ?? (isEdit ? t("policies.form.saveChanges") : t("policies.form.createPolicy")))}
        </button>
      </div>
    </form>
  );
}

function FormField({
  label,
  required,
  error,
  span,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string | undefined;
  span?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        ...(span ? { gridColumn: "1 / -1" } : {}),
      }}
    >
      <span
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--text-tertiary)",
        }}
      >
        {label}
        {required && (
          <span
            aria-hidden
            title="Required"
            style={{ color: "var(--danger-text, #dc2626)", marginInlineStart: 3 }}
          >
            *
          </span>
        )}
      </span>
      {children}
      {error && (
        <span
          role="alert"
          style={{ fontSize: 11, color: "var(--danger-text, #dc2626)" }}
        >
          {error}
        </span>
      )}
    </label>
  );
}

const inputStyle = {
  padding: "6px 8px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  fontSize: 13,
  background: "var(--bg)",
  color: "var(--text)",
  fontFamily: "var(--font-sans)",
  outline: "none",
} as const;

const grid2 = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 12,
} as const;

function SectionCaption({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10.5,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "var(--text-tertiary)",
        fontWeight: 700,
        marginTop: 6,
        paddingBottom: 4,
        borderBottom: "1px solid var(--border)",
      }}
    >
      {children}
    </div>
  );
}
