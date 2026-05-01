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

import { ApiError } from "../api/client";
import { DatePicker } from "../components/DatePicker";
import { DrawerShell } from "../components/DrawerShell";
import { Icon } from "../shell/Icon";
import { toast } from "../shell/Toaster";
import {
  useAssignments,
  useCreatePolicy,
  useDeletePolicy,
  usePolicies,
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
  const policies = usePolicies();
  const assignments = useAssignments();
  const create = useCreatePolicy();
  const del = useDeletePolicy();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
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
      toast.success(`"${created.name}" created.`);
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { detail?: unknown } | null;
        const msg =
          typeof body?.detail === "string"
            ? body.detail
            : `Save failed (${err.status}).`;
        setError(msg);
        toast.error(msg);
      } else {
        setError("Save failed.");
        toast.error("Save failed.");
      }
    }
  };

  const onDelete = async (p: PolicyResponse) => {
    if (
      !confirm(
        `Soft-delete "${p.name}"? Existing attendance rows keep their original policy reference; resolution will skip this row from now on.`,
      )
    )
      return;
    try {
      await del.mutateAsync(p.id);
      toast.success(`"${p.name}" deleted.`);
    } catch (err) {
      if (err instanceof ApiError) {
        toast.error(`Delete failed (${err.status}).`);
      } else {
        toast.error("Delete failed.");
      }
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Shift policies</h1>
          <p className="page-sub">
            Fixed, Flex, Ramadan and custom · assign per dept,
            employee, or globally
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" disabled title="Coming soon">
            <Icon name="upload" size={12} />
            Import
          </button>
          <button
            className="btn btn-primary"
            onClick={() => setDrawerOpen(true)}
          >
            <Icon name="plus" size={12} />
            New policy
          </button>
        </div>
      </div>

      {policies.isLoading && (
        <p className="text-sm text-dim">Loading shift policies…</p>
      )}
      {policies.isError && (
        <p style={{ color: "var(--danger-text)" }}>
          Could not load shift policies.
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
              <h3 className="card-title">Policies</h3>
              <span className="text-xs text-dim">{policyList.length}</span>
            </div>
            <div style={{ padding: 4 }}>
              {policyList.length === 0 && (
                <div
                  className="text-sm text-dim"
                  style={{ padding: 16, textAlign: "center" }}
                >
                  No policies yet. Create one to get started.
                </div>
              )}
              {policyList.map((p) => {
                const isSelected = p.id === selectedId;
                const isActive = p.active_until === null;
                const rowAssignments = assignmentsByPolicy[p.id] ?? [];
                const subtitle = renderSubtitle(p, rowAssignments);
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
                        }}
                      >
                        {p.name}
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
                      {isActive ? "Active" : "Off"}
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
                Select a policy to view its shift window and flag rules.
              </div>
            ) : (
              <PolicyDetail
                policy={selected}
                assignments={assignmentsByPolicy[selected.id] ?? []}
                onDelete={() => onDelete(selected)}
              />
            )}
          </div>
        </div>
      )}

      {drawerOpen && (
        <DrawerShell onClose={() => setDrawerOpen(false)}>
          <div className="drawer">
            <div className="drawer-head">
              <div>
                <div className="mono text-xs text-dim">Shift policy</div>
                <div
                  style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}
                >
                  New policy
                </div>
              </div>
              <button
                className="icon-btn"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close"
              >
                <Icon name="x" size={14} />
              </button>
            </div>
            <div className="drawer-body">
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
        </DrawerShell>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Detail panel — shift window ribbon + fields + flag rules
// ---------------------------------------------------------------------------

function PolicyDetail({
  policy,
  assignments,
  onDelete,
}: {
  policy: PolicyResponse;
  assignments: AssignmentResponse[];
  onDelete: () => void;
}) {
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
            {!isActive && <span className="pill pill-neutral">Off</span>}
          </div>
        </div>
        <button
          className="btn btn-sm"
          disabled
          title="Edit drawer arrives next"
        >
          <Icon name="edit" size={11} /> Edit
        </button>
        <button
          className="icon-btn"
          aria-label="Delete policy"
          onClick={onDelete}
          title="Delete policy"
        >
          <Icon name="trash" size={13} />
        </button>
      </div>
      <p
        className="text-sm text-dim"
        style={{ marginTop: 0, marginBottom: 16 }}
      >
        Must complete {requiredHours} hours
        {assignments.length > 0 && (
          <>
            {" · "}
            {assignments.length} assigned
          </>
        )}
      </p>

      {/* SHIFT WINDOW — visual timeline ribbon */}
      <SectionLabel>Shift window</SectionLabel>
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
          label="In time"
          value={
            isFlexShape
              ? `${cfg.in_window_start ?? "—"} – ${cfg.in_window_end ?? "—"}`
              : (cfg.start ?? "—")
          }
          hint={
            isFlexShape
              ? "Flex range · earliest – latest acceptable"
              : undefined
          }
        />
        <DetailField
          label="Out time"
          value={
            isFlexShape
              ? `${cfg.out_window_start ?? "—"} – ${cfg.out_window_end ?? "—"}`
              : (cfg.end ?? "—")
          }
          hint={
            isFlexShape
              ? "Flex range · earliest – latest acceptable"
              : undefined
          }
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
        <DetailField label="Required hours" value={String(requiredHours)} />
        <DetailField
          label="Overtime threshold"
          value={
            cfg.grace_minutes !== undefined
              ? `+${cfg.grace_minutes}m`
              : "—"
          }
        />
      </div>

      {/* FLAG RULES */}
      <SectionLabel>Flag rules</SectionLabel>
      <FlagRulesList />
    </>
  );
}

function ShiftWindowRibbon({ policy }: { policy: PolicyResponse }) {
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
        label: "arrive",
        start: inS,
        end: inE,
        fill: "var(--info-soft)",
      });
    }
    if (inE !== null && outS !== null && inE < outS) {
      bands.push({
        label: `${cfg.required_hours ?? 8}h work`,
        start: inE,
        end: outS,
        fill: "var(--accent-soft)",
        accent: true,
      });
    }
    if (outS !== null && outE !== null) {
      bands.push({
        label: "depart",
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
        label: `${cfg.required_hours ?? 8}h shift`,
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
  // The four engine flags (P10 / P11). They're not per-policy
  // configurable today — surfaced as read-only "always on"
  // indicators that match the prototype's reference. Future work
  // could wire per-policy overrides via a proper toggle.
  const rows = [
    {
      label: "Late in",
      when: "In > start time",
      action: 'Flag "Late Nm" · notify manager',
    },
    {
      label: "Early out",
      when: "Out < end time",
      action: 'Flag "Early Nm" · notify manager',
    },
    {
      label: "Overtime",
      when: "Total > required + threshold",
      action: "Store OT · notify HR",
    },
    {
      label: "Absent",
      when: "No detection & not on leave/holiday",
      action: 'Flag "Absent" · include in daily report',
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
            On
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
): string {
  const range = renderTimeRange(p);
  const count = assignments.length;
  const noun = count === 1 ? "assignment" : "assignments";
  const bits: string[] = [p.type];
  if (range) bits.push(range);
  bits.push(`${count} ${noun}`);
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
}: {
  onSubmit: (input: {
    name: string;
    type: PolicyType;
    config: PolicyConfig;
    active_from: string;
  }) => Promise<void>;
  busy: boolean;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<PolicyType>("Fixed");
  const [activeFrom, setActiveFrom] = useState(
    new Date().toISOString().slice(0, 10),
  );
  // Fixed (also used by Ramadan + Custom-Fixed)
  const [start, setStart] = useState("07:30");
  const [end, setEnd] = useState("15:30");
  const [grace, setGrace] = useState(15);
  // Flex (also used by Custom-Flex)
  const [inStart, setInStart] = useState("07:30");
  const [inEnd, setInEnd] = useState("08:30");
  const [outStart, setOutStart] = useState("15:30");
  const [outEnd, setOutEnd] = useState("16:30");
  // Common
  const [requiredHours, setRequiredHours] = useState(8);
  // Ramadan / Custom — calendar range
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  // Custom — Fixed or Flex inner
  const [innerType, setInnerType] = useState<"Fixed" | "Flex">("Fixed");

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

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
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
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "2fr 1fr 1fr",
          gap: 10,
        }}
      >
        <FormField label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            style={inputStyle}
          />
        </FormField>
        <FormField label="Type">
          <select
            value={type}
            onChange={(e) => onTypeChange(e.target.value as PolicyType)}
            style={inputStyle}
          >
            <option value="Fixed">Fixed</option>
            <option value="Flex">Flex</option>
            <option value="Ramadan">Ramadan</option>
            <option value="Custom">Custom</option>
          </select>
        </FormField>
        <FormField label="Active from">
          <DatePicker
            value={activeFrom}
            onChange={setActiveFrom}
            ariaLabel="Active from"
            triggerStyle={{ width: "100%" }}
          />
        </FormField>
      </div>

      {/* Date-range picker — Ramadan + Custom only */}
      {(type === "Ramadan" || type === "Custom") && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 10,
          }}
        >
          <FormField label="Range start">
            <DatePicker
              value={rangeStart}
              onChange={setRangeStart}
              ariaLabel="Range start"
              triggerStyle={{ width: "100%" }}
            />
          </FormField>
          <FormField label="Range end">
            <DatePicker
              value={rangeEnd}
              onChange={setRangeEnd}
              min={rangeStart}
              ariaLabel="Range end"
              triggerStyle={{ width: "100%" }}
            />
          </FormField>
          {type === "Custom" && (
            <FormField label="Custom inner type">
              <select
                value={innerType}
                onChange={(e) =>
                  setInnerType(e.target.value as "Fixed" | "Flex")
                }
                style={inputStyle}
              >
                <option value="Fixed">Fixed (start/end + grace)</option>
                <option value="Flex">Flex (in/out windows)</option>
              </select>
            </FormField>
          )}
        </div>
      )}

      {isFixedShape ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr 1fr",
            gap: 10,
          }}
        >
          <FormField label="Start">
            <input
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              required
              style={inputStyle}
            />
          </FormField>
          <FormField label="End">
            <input
              type="time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              required
              style={inputStyle}
            />
          </FormField>
          <FormField label="Grace (min)">
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
          <FormField label="Required hours">
            <input
              type="number"
              min={1}
              max={24}
              value={requiredHours}
              onChange={(e) =>
                setRequiredHours(Number.parseInt(e.target.value, 10) || 1)
              }
              style={inputStyle}
            />
          </FormField>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr",
            gap: 10,
          }}
        >
          <FormField label="In window start">
            <input
              type="time"
              value={inStart}
              onChange={(e) => setInStart(e.target.value)}
              required
              style={inputStyle}
            />
          </FormField>
          <FormField label="In window end">
            <input
              type="time"
              value={inEnd}
              onChange={(e) => setInEnd(e.target.value)}
              required
              style={inputStyle}
            />
          </FormField>
          <FormField label="Out window start">
            <input
              type="time"
              value={outStart}
              onChange={(e) => setOutStart(e.target.value)}
              required
              style={inputStyle}
            />
          </FormField>
          <FormField label="Out window end">
            <input
              type="time"
              value={outEnd}
              onChange={(e) => setOutEnd(e.target.value)}
              required
              style={inputStyle}
            />
          </FormField>
          <FormField label="Required hours">
            <input
              type="number"
              min={1}
              max={24}
              value={requiredHours}
              onChange={(e) =>
                setRequiredHours(Number.parseInt(e.target.value, 10) || 1)
              }
              style={inputStyle}
            />
          </FormField>
        </div>
      )}

      <div
        style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}
      >
        <button
          type="submit"
          disabled={busy}
          className="btn btn-primary"
        >
          {busy ? "Saving…" : "Create policy"}
        </button>
      </div>
    </form>
  );
}

function FormField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--text-tertiary)",
        }}
      >
        {label}
      </span>
      {children}
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
