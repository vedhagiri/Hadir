// Shift Policies — master/detail layout (matches the prototype
// reference at docs/scripts/shift_policy_screen/01-shift-policy-list-view.png).
//
// Left column: compact list of every policy with type/range/assignment-
// count + Active/Off pill.
// Right column: detail panel for the selected policy — visual shift-
// window timeline, in/out fields, required + overtime, flag rules.
//
// "+ New policy" opens the existing PolicyForm in a modal; the
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
import { DrawerShell } from "../components/DrawerShell";
import {
  ChoiceCards,
  Field,
  FormFooter,
  FormHeader,
  FormNotice,
  FormSection,
} from "../components/FormKit";
import { EmptyPanel, StatCard, StatGrid } from "../components/ListPageUi";
import {
  FormFootBar,
  FormModal,
  SectionLabel,
  SoftPill,
  WF_ICON,
  WfSvg,
  errorDetail,
} from "../requests/workflowUi";
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
import { SkeletonCards, SkeletonPanel } from "../components/Skeleton";

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
  // Edit modal — opens with a specific policy preloaded into the form.
  // ``null`` keeps it closed; ``PolicyResponse`` opens it pre-filled.
  const [editing, setEditing] = useState<PolicyResponse | null>(null);
  // Delete-confirmation modal. ``null`` keeps it closed; setting it
  // to a policy opens the modal with Soft / Permanent options.
  const [deleting, setDeleting] = useState<PolicyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Group filter driven by the summary cards ("" = every group).
  const [groupFilter, setGroupFilter] = useState<"" | PolicyGroup>("");

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

  const groupCounts = useMemo(() => {
    const c: Record<PolicyGroup, number> = { standard: 0, ramadan: 0, custom: 0 };
    for (const p of policyList) c[policyGroup(p.type)] += 1;
    return c;
  }, [policyList]);
  const visiblePolicies = groupFilter
    ? policyList.filter((p) => policyGroup(p.type) === groupFilter)
    : policyList;

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

  const newPolicyBtn = (
    <button type="button" className="btn btn-primary" onClick={() => setDrawerOpen(true)}>
      <Icon name="plus" size={12} />
      {t("policies.newPolicy")}
    </button>
  );

  return (
    <div className="wf-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("policies.title")}</h1>
          <p className="page-sub">{t("policies.sub")}</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => setImportOpen(true)} title={t("policies.importTitle")}>
            <Icon name="upload" size={12} />
            {t("policies.import")}
          </button>
          {newPolicyBtn}
        </div>
      </div>

      {policies.isLoading ? (
        <>
          <SkeletonCards count={4} />
          <div className="wf-split">
            <SkeletonPanel lines={5} />
            <SkeletonPanel lines={9} />
          </div>
        </>
      ) : policies.isError ? (
        <div className="card">
          <EmptyPanel
            tone="danger"
            icon={<WfSvg>{WF_ICON.alert}</WfSvg>}
            title={t("policies.loadError")}
            body={errorDetail(policies.error, t("common.errorGeneric"))}
            actions={
              <button type="button" className="btn" onClick={() => void policies.refetch()}>
                <Icon name="refresh" size={12} /> {t("common.retry", { defaultValue: "Retry" })}
              </button>
            }
          />
        </div>
      ) : policyList.length === 0 ? (
        <div className="card">
          <EmptyPanel
            tone="accent"
            icon={<WfSvg>{WF_ICON.clock}</WfSvg>}
            title={t("policies.emptyTitle", { defaultValue: "No shift policies yet" })}
            body={t("policies.empty")}
            actions={newPolicyBtn}
          />
        </div>
      ) : (
        <>
          <StatGrid>
            <StatCard
              tone="info"
              icon={<path d="M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />}
              label={t("policies.stats.all", { defaultValue: "All policies" })}
              value={policyList.length}
              sub={t("policies.stats.allSub", {
                defaultValue: "{{n}} active",
                n: policyList.filter((p) => p.active_until === null).length,
              })}
              active={groupFilter === ""}
              onClick={() => setGroupFilter("")}
            />
            {POLICY_GROUPS.map((g) => (
              <StatCard
                key={g}
                tone={g === "standard" ? "success" : g === "ramadan" ? "warning" : "neutral"}
                icon={GROUP_ICON[g]}
                label={groupLabel(g, t)}
                value={groupCounts[g]}
                sub={groupSub(g, t)}
                active={groupFilter === g}
                onClick={() => setGroupFilter(groupFilter === g ? "" : g)}
              />
            ))}
          </StatGrid>

          <div className="wf-split">
            {/* Left — list, grouped Standard / Ramadan / Custom */}
            <div className="card">
              <div className="card-head wf-row wf-row-between">
                <h3 className="card-title">{t("policies.listTitle")}</h3>
                <span className="text-xs text-dim mono">
                  {groupFilter
                    ? `${visiblePolicies.length} / ${policyList.length}`
                    : policyList.length}
                </span>
              </div>
              <div className="wf-list-pad">
                {visiblePolicies.length === 0 && (
                  <EmptyPanel
                    tone="neutral"
                    icon={<WfSvg>{WF_ICON.search}</WfSvg>}
                    title={t("policies.emptyGroup.title", { defaultValue: "No {{group}} policies", group: groupFilter ? groupLabel(groupFilter, t) : "" })}
                    body={t("policies.emptyGroup.body", { defaultValue: "Pick another group above or create a policy of this type." })}
                    actions={
                      <button type="button" className="btn" onClick={() => setGroupFilter("")}>
                        {t("policies.emptyGroup.clear", { defaultValue: "Show all policies" })}
                      </button>
                    }
                  />
                )}
                {POLICY_GROUPS.map((g) => {
                  const rows = visiblePolicies.filter((p) => policyGroup(p.type) === g);
                  if (rows.length === 0) return null;
                  return (
                    <div key={g} style={{ marginBottom: 4 }}>
                      <div className="wf-group-head">
                        <span>{groupLabel(g, t)}</span>
                        <span className="mono">{rows.length}</span>
                      </div>
                      {rows.map((p) => {
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
                            aria-pressed={isSelected}
                            className="wf-policy-row"
                          >
                            <div className="wf-grow">
                              <div className="wf-policy-row-name">
                                <span>{p.name}</span>
                                {isDefault && (
                                  <span title={t("policies.defaultTitle")}>
                                    <SoftPill tone="accent" dot={false}>
                                      {t("policies.default")}
                                    </SoftPill>
                                  </span>
                                )}
                              </div>
                              <div className="wf-policy-row-sub">{subtitle}</div>
                            </div>
                            <span style={{ flexShrink: 0 }}>
                              <SoftPill tone={isActive ? "success" : "neutral"}>
                                {isActive ? t("policies.active") : t("policies.off")}
                              </SoftPill>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Right — detail */}
            <div className="card">
              <div className="card-body">
                {selected === null ? (
                  <EmptyPanel
                    icon={<WfSvg>{WF_ICON.clock}</WfSvg>}
                    title={t("policies.selectTitle", { defaultValue: "Pick a policy" })}
                    body={t("policies.selectPrompt")}
                  />
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
          </div>
        </>
      )}

      {drawerOpen && (
        <PolicyForm
          onSubmit={onCreate}
          busy={create.isPending}
          onClose={() => setDrawerOpen(false)}
          serverError={error}
        />
      )}
      {editing && (
        <PolicyEditModal
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
    </div>
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
    <FormModal
      onClose={onClose}
      busy={busy}
      size="md"
      icon={<Icon name="trash" size={18} />}
      eyebrow={t("policies.deleteModal.label")}
      title={t("policies.deleteModal.title", { name: policy.name })}
      subtitle={t("policies.deleteModal.body")}
      footer={
        <FormFootBar>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
        </FormFootBar>
      }
    >
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
    </FormModal>
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
    <div className={`wf-option${danger ? " is-danger" : ""}`}>
      <div className="wf-option-title">{title}</div>
      <div className="text-xs wf-muted wf-option-desc">{description}</div>
      {error && <FormNotice tone="danger">{error}</FormNotice>}
      <div className="wf-row wf-row-end">
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

function PolicyEditModal({
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
    <PolicyForm
      onSubmit={onSave}
      busy={patch.isPending}
      initial={policy}
      onClose={onClose}
      serverError={error}
    />
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
      <div className="wf-detail-head">
        <div className="wf-grow wf-row">
          <h2 className="wf-detail-title">{policy.name}</h2>
          <SoftPill tone="info" dot={false}>{policy.type}</SoftPill>
          {isDefault && (
            <span title={t("policies.detail.defaultPillTitle")}>
              <SoftPill tone="accent">{t("policies.default")}</SoftPill>
            </span>
          )}
          {!isActive && <SoftPill tone="neutral">{t("policies.off")}</SoftPill>}
        </div>
        {!isDefault && isActive && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={onSetDefault}
            disabled={settingDefault}
            title={t("policies.detail.setAsDefaultTitle")}
          >
            <Icon name="check" size={11} />{" "}
            {settingDefault ? t("policies.detail.settingDefault") : t("policies.detail.setAsDefault")}
          </button>
        )}
        <button type="button" className="btn btn-sm" onClick={onEdit} title={t("policies.detail.editTitle")}>
          <Icon name="edit" size={11} /> {t("policies.detail.edit")}
        </button>
        <button
          type="button"
          className="icon-btn wf-danger-text"
          aria-label={t("policies.detail.deleteAria")}
          onClick={onDelete}
          title={t("policies.detail.deleteTitle")}
        >
          <Icon name="trash" size={13} />
        </button>
      </div>
      <p className="text-sm wf-muted" style={{ marginTop: 0, marginBottom: 10 }}>
        {t("policies.detail.mustComplete", { n: requiredHours })}
        {assignments.length > 0 && (
          <>
            {" · "}
            {t("policies.detail.assigned", { n: assignments.length })}
          </>
        )}
      </p>
      <div style={{ marginBottom: 16 }}>
        <AssignmentChips assignments={assignments} />
      </div>

      {/* SHIFT WINDOW — visual timeline ribbon */}
      <SectionLabel>{t("policies.detail.shiftWindow")}</SectionLabel>
      <ShiftWindowRibbon policy={policy} />

      {/* IN/OUT + REQUIRED + OVERTIME */}
      <div className="wf-detail-grid">
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
    accent?: boolean;
  }> = [];

  if (isFlex) {
    const inS = minutesOf(cfg.in_window_start);
    const inE = minutesOf(cfg.in_window_end);
    const outS = minutesOf(cfg.out_window_start);
    const outE = minutesOf(cfg.out_window_end);
    if (inS !== null && inE !== null) {
      bands.push({ label: t("policies.detail.bandArrive"), start: inS, end: inE });
    }
    if (inE !== null && outS !== null && inE < outS) {
      bands.push({
        label: t("policies.detail.bandWork", { n: cfg.required_hours ?? 8 }),
        start: inE,
        end: outS,
        accent: true,
      });
    }
    if (outS !== null && outE !== null) {
      bands.push({ label: t("policies.detail.bandDepart"), start: outS, end: outE });
    }
  } else {
    const s = minutesOf(cfg.start);
    const e = minutesOf(cfg.end);
    if (s !== null && e !== null) {
      bands.push({
        label: t("policies.detail.bandShift", { n: cfg.required_hours ?? 8 }),
        start: s,
        end: e,
        accent: true,
      });
    }
  }

  return (
    <div className="wf-ribbon">
      {/* Hour ticks */}
      {Array.from({ length: HOURS_END - HOURS_START + 1 }).map((_, i) => {
        const hour = HOURS_START + i;
        const left = (i / (HOURS_END - HOURS_START)) * 100;
        return (
          <div
            key={hour}
            className="wf-ribbon-tick"
            style={{ insetInlineStart: `${left}%`, opacity: hour % 3 === 0 ? 0.9 : 0.4 }}
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
            className={`wf-ribbon-band${b.accent ? " is-accent" : ""}`}
            style={{ insetInlineStart: `${left}%`, width: `${width}%` }}
          >
            {b.label}
          </div>
        );
      })}
      {/* Hour labels along the bottom */}
      <div className="wf-ribbon-hours" aria-hidden>
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
    <div className="wf-rules">
      {rows.map((r) => (
        <div key={r.label} className="wf-rule">
          <div className="wf-rule-name">{r.label}</div>
          <div className="text-xs text-dim">{r.when}</div>
          <div className="text-xs">{r.action}</div>
          <SoftPill tone="success">{t("policies.detail.flagOn")}</SoftPill>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Policy groups (summary cards + grouped list)
// ---------------------------------------------------------------------------

type PolicyGroup = "standard" | "ramadan" | "custom";
const POLICY_GROUPS: PolicyGroup[] = ["standard", "ramadan", "custom"];

function policyGroup(type: PolicyType): PolicyGroup {
  if (type === "Ramadan") return "ramadan";
  if (type === "Custom") return "custom";
  return "standard";
}

function groupLabel(g: PolicyGroup, t: TFunction): string {
  if (g === "ramadan") return t("policies.groups.ramadan", { defaultValue: "Ramadan" });
  if (g === "custom") return t("policies.groups.custom", { defaultValue: "Custom" });
  return t("policies.groups.standard", { defaultValue: "Standard" });
}

function groupSub(g: PolicyGroup, t: TFunction): string {
  if (g === "ramadan") return t("policies.groups.ramadanSub", { defaultValue: "Ramadan-hours shifts" });
  if (g === "custom") return t("policies.groups.customSub", { defaultValue: "Date-range overrides" });
  return t("policies.groups.standardSub", { defaultValue: "Fixed and Flex shifts" });
}

const GROUP_ICON: Record<PolicyGroup, React.ReactNode> = {
  standard: <><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M8 2v4M16 2v4M3 10h18" /></>,
  ramadan: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />,
  custom: <><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" /></>,
};

/** Assignment scope chips: "Company default", "2 departments", "5 employees". */
function AssignmentChips({ assignments }: { assignments: AssignmentResponse[] }) {
  const { t } = useTranslation();
  const tenant = assignments.filter((a) => a.scope_type === "tenant").length;
  const dept = assignments.filter((a) => a.scope_type === "department").length;
  const emp = assignments.filter((a) => a.scope_type === "employee").length;
  if (assignments.length === 0) {
    return (
      <SoftPill tone="neutral" dot={false}>
        {t("policies.chips.unassigned", { defaultValue: "Not assigned yet" })}
      </SoftPill>
    );
  }
  return (
    <div className="wf-row">
      {tenant > 0 && (
        <SoftPill tone="accent">{t("policies.chips.company", { defaultValue: "Whole company" })}</SoftPill>
      )}
      {dept > 0 && (
        <SoftPill tone="info">
          {t("policies.chips.departments", { defaultValue: "Departments · {{n}}", n: dept })}
        </SoftPill>
      )}
      {emp > 0 && (
        <SoftPill tone="info">
          {t("policies.chips.employees", { defaultValue: "Employees · {{n}}", n: emp })}
        </SoftPill>
      )}
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
// Detail-side primitive (read-only field row)
// ---------------------------------------------------------------------------

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
    <div className="field">
      <div className="field-label">{label}</div>
      <div className="wf-detail-field-value">{value}</div>
      {hint && <div className="field-help">{hint}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PolicyForm — mounted inside the New-policy / Edit modals.
//
// Carried over from the v1.0 P9 build so the existing validators +
// Ramadan-default pre-fill continue to work. Only the outer surface
// changed (design `.field` / `.input` / `.select` classes).
// ---------------------------------------------------------------------------

function PolicyForm({
  onSubmit,
  busy,
  initial,
  onClose,
  serverError,
}: {
  onSubmit: (input: {
    name: string;
    type: PolicyType;
    config: PolicyConfig;
    active_from: string;
  }) => Promise<void>;
  busy: boolean;
  initial?: PolicyResponse | null | undefined;
  onClose: () => void;
  /** Non-field server error, shown as a notice at the top of the body. */
  serverError?: string | null | undefined;
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
    e.stopPropagation();

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

  const isRange = type === "Ramadan" || type === "Custom";
  const typeLabel: Record<PolicyType, string> = {
    Fixed: "Fixed",
    Flex: "Flex",
    Ramadan: "Ramadan",
    Custom: "Custom",
  };

  return (
    <DrawerShell onClose={onClose}>
      <form className="drawer fk-drawer" onSubmit={submit}>
        <FormHeader
          icon={<Icon name="clock" size={18} />}
          title={isEdit ? t("policies.form.editTitle", { defaultValue: "Edit shift policy" }) : t("policies.form.newTitle", { defaultValue: "New shift policy" })}
          subtitle={
            isEdit
              ? t("policies.form.editSubtitle", {
                  defaultValue: "Change the rules of {{name}}. Attendance recomputes with the new values.",
                  name: initial?.name ?? "",
                })
              : t("policies.form.newSubtitle", {
                  defaultValue: "Define when employees are expected at work and how lateness is judged.",
                })
          }
          onClose={onClose}
        />
        <div className="drawer-body fk-body">
          {serverError && <FormNotice tone="danger">{serverError}</FormNotice>}

          <FormSection
            step={1}
            title={t("policies.form.sectionIdentity")}
            description={t("policies.form.identityDesc", { defaultValue: "A name people will recognise, and the day it takes effect." })}
          >
            <Field label={t("policies.form.fieldName")} htmlFor="pol-name" required error={errors.name}>
              <input
                id="pol-name"
                type="text"
                className="input"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  clearError("name");
                }}
                required
                maxLength={120}
                aria-invalid={!!errors.name}
                placeholder={t("policies.form.namePlaceholder", { defaultValue: "e.g. Head office day shift" })}
              />
            </Field>
            <Field label={t("policies.form.fieldActiveFrom")} required>
              <DatePicker
                value={activeFrom}
                onChange={setActiveFrom}
                ariaLabel={t("policies.form.fieldActiveFrom")}
                triggerStyle={{ width: "100%" }}
              />
            </Field>
          </FormSection>

          <FormSection
            step={2}
            title={t("policies.form.fieldType")}
            description={
              isEdit
                ? t("policies.form.typeLockedTitle")
                : t("policies.form.typeDesc", { defaultValue: "How attendance is judged. The fields below change with the type." })
            }
          >
            <ChoiceCards<PolicyType>
              label={t("policies.form.fieldType")}
              value={type}
              onChange={isEdit ? () => undefined : onTypeChange}
              options={(["Fixed", "Flex", "Ramadan", "Custom"] as PolicyType[]).map((v) => ({
                value: v,
                title: typeLabel[v],
                disabled: isEdit && v !== type,
                icon: <Icon name={TYPE_ICON[v]} size={16} />,
                description: t(`policies.form.typeDesc${v}`, { defaultValue: TYPE_DESC[v] }),
              }))}
            />
          </FormSection>

          {/* Date-range picker — Ramadan + Custom only */}
          {isRange && (
            <FormSection
              step={3}
              title={t("policies.form.sectionDateRange")}
              description={t("policies.form.dateRangeDesc", { defaultValue: "The calendar days this policy overrides the regular one." })}
            >
              <Field label={t("policies.form.fieldRangeStart")} required error={errors.rangeStart}>
                <DatePicker
                  value={rangeStart}
                  onChange={(v) => {
                    setRangeStart(v);
                    clearError("rangeStart");
                  }}
                  ariaLabel={t("policies.form.fieldRangeStart")}
                  triggerStyle={{ width: "100%" }}
                />
              </Field>
              <Field label={t("policies.form.fieldRangeEnd")} required error={rangeEndError}>
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
              </Field>
              {type === "Custom" && (
                <Field label={t("policies.form.fieldInnerType")} required span={2}>
                  <ChoiceCards<"Fixed" | "Flex">
                    label={t("policies.form.fieldInnerType")}
                    value={innerType}
                    onChange={setInnerType}
                    options={[
                      { value: "Fixed", title: t("policies.form.innerFixed") },
                      { value: "Flex", title: t("policies.form.innerFlex") },
                    ]}
                  />
                </Field>
              )}
            </FormSection>
          )}

          <FormSection
            step={isRange ? 4 : 3}
            title={t("policies.form.sectionShiftWindow")}
            description={
              isFixedShape
                ? t("policies.form.shiftFixedDesc", { defaultValue: "Start and end of the working day. Arrivals within the grace minutes are not late." })
                : t("policies.form.shiftFlexDesc", { defaultValue: "When people may arrive and leave. The day counts if the required hours are met." })
            }
          >
            {isFixedShape ? (
              <>
                <Field label={t("policies.form.fieldStart")} htmlFor="pol-start" required>
                  <input id="pol-start" type="time" className="input" value={start} onChange={(e) => setStart(e.target.value)} required />
                </Field>
                <Field label={t("policies.form.fieldEnd")} htmlFor="pol-end" required>
                  <input id="pol-end" type="time" className="input" value={end} onChange={(e) => setEnd(e.target.value)} required />
                </Field>
                <Field label={t("policies.form.fieldGrace")} htmlFor="pol-grace" help={t("policies.form.graceHelp", { defaultValue: "0 to 180 minutes" })}>
                  <input
                    id="pol-grace"
                    type="number"
                    className="input"
                    min={0}
                    max={180}
                    value={grace}
                    onChange={(e) =>
                      setGrace(Number.parseInt(e.target.value, 10) || 0)
                    }
                  />
                </Field>
                <Field label={t("policies.form.fieldRequiredHours")} htmlFor="pol-hours" required help={t("policies.form.hoursHelp", { defaultValue: "1 to 24 hours" })}>
                  <input
                    id="pol-hours"
                    type="number"
                    className="input"
                    min={1}
                    max={24}
                    value={requiredHours}
                    onChange={(e) =>
                      setRequiredHours(Number.parseInt(e.target.value, 10) || 1)
                    }
                    required
                  />
                </Field>
              </>
            ) : (
              <>
                <Field label={t("policies.form.fieldInWindowStart")} htmlFor="pol-in-start" required>
                  <input id="pol-in-start" type="time" className="input" value={inStart} onChange={(e) => setInStart(e.target.value)} required />
                </Field>
                <Field label={t("policies.form.fieldInWindowEnd")} htmlFor="pol-in-end" required>
                  <input id="pol-in-end" type="time" className="input" value={inEnd} onChange={(e) => setInEnd(e.target.value)} required />
                </Field>
                <Field label={t("policies.form.fieldOutWindowStart")} htmlFor="pol-out-start" required>
                  <input id="pol-out-start" type="time" className="input" value={outStart} onChange={(e) => setOutStart(e.target.value)} required />
                </Field>
                <Field label={t("policies.form.fieldOutWindowEnd")} htmlFor="pol-out-end" required>
                  <input id="pol-out-end" type="time" className="input" value={outEnd} onChange={(e) => setOutEnd(e.target.value)} required />
                </Field>
                <Field label={t("policies.form.fieldRequiredHours")} htmlFor="pol-hours" required help={t("policies.form.hoursHelp", { defaultValue: "1 to 24 hours" })}>
                  <input
                    id="pol-hours"
                    type="number"
                    className="input"
                    min={1}
                    max={24}
                    value={requiredHours}
                    onChange={(e) =>
                      setRequiredHours(Number.parseInt(e.target.value, 10) || 1)
                    }
                    required
                  />
                </Field>
              </>
            )}
          </FormSection>
        </div>
        <FormFooter
          onCancel={onClose}
          submitLabel={isEdit ? t("policies.form.saveChanges") : t("policies.form.createPolicy")}
          submittingLabel={t("policies.form.saving")}
          submitting={busy}
          canSubmit={isValid}
        />
      </form>
    </DrawerShell>
  );
}

const TYPE_ICON: Record<PolicyType, "clock" | "activity" | "moon" | "sparkles"> = {
  Fixed: "clock",
  Flex: "activity",
  Ramadan: "moon",
  Custom: "sparkles",
};

const TYPE_DESC: Record<PolicyType, string> = {
  Fixed: "Set start and end times with a grace period.",
  Flex: "Arrive and leave within windows; the hours must add up.",
  Ramadan: "Shorter fixed hours for a date range.",
  Custom: "Fixed or Flex rules for a specific date range.",
};
