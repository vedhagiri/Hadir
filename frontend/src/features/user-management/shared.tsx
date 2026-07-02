// Small shared bits for the AD Users surface.

import type { RoleCode } from "./types";

export const ROLE_META: Record<
  RoleCode,
  { label: string; desc: string }
> = {
  Admin: { label: "Admin", desc: "Full access including user management" },
  HR: { label: "HR", desc: "People, attendance, leave and approvals" },
  Manager: { label: "Manager", desc: "Team attendance and approvals" },
  Employee: { label: "Employee", desc: "Self-service access only" },
};

export const ROLE_ORDER: RoleCode[] = ["Admin", "HR", "Manager", "Employee"];

const AVATAR_COLORS = [
  "#0b6e4f",
  "#2563eb",
  "#7c3aed",
  "#b45309",
  "#be123c",
  "#0891b2",
  "#4f46e5",
];

export function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

export function avatarInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export function RoleBadges({ codes }: { codes: string[] }) {
  if (codes.length === 0) {
    return <span style={{ color: "var(--text-tertiary)", fontSize: 12 }}>No role</span>;
  }
  return (
    <span style={{ display: "inline-flex", gap: 5, flexWrap: "wrap" }}>
      {codes.map((c) => (
        <span
          key={c}
          className="pill pill-accent"
          style={{ fontSize: 10.5, letterSpacing: "0.02em" }}
        >
          {c}
        </span>
      ))}
    </span>
  );
}

export function AccessToggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      style={{
        position: "relative",
        width: 40,
        height: 22,
        flexShrink: 0,
        borderRadius: 999,
        border: "none",
        cursor: disabled ? "default" : "pointer",
        padding: 0,
        transition: "background 120ms ease",
        background: checked ? "var(--accent)" : "var(--border-strong)",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          insetInlineStart: checked ? 20 : 2,
          width: 18,
          height: 18,
          borderRadius: 999,
          background: "#fff",
          transition: "inset-inline-start 120ms ease",
          boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
        }}
      />
    </button>
  );
}
