// Small shared bits for the AD Users surface.

import { useTranslation } from "react-i18next";

import { rolePillClass } from "../employees/EmployeesPage";
import { Switch } from "../employees/peopleUi";
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

// Stable per-name avatar colour. Hashes into the same palette the
// Employees page uses so a person looks the same on both surfaces.
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
  const { t } = useTranslation();
  if (codes.length === 0) {
    return (
      <span className="text-xs text-dim">
        {t("userManagement.noRole", { defaultValue: "No role" })}
      </span>
    );
  }
  return (
    <span className="pp-card-pills">
      {codes.map((c) => (
        <span key={c} className={`pill ${rolePillClass(c)}`}>
          {t(`role.${c}`, { defaultValue: c })}
        </span>
      ))}
    </span>
  );
}

/** Access on/off switch — the shared People-area Switch. */
export function AccessToggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  /** Accessible name for the switch. */
  label?: string;
}) {
  return (
    <Switch
      checked={checked}
      onChange={onChange}
      {...(disabled !== undefined ? { disabled } : {})}
      {...(label !== undefined ? { label } : {})}
    />
  );
}
