// Role-aware sidebar.
// Structure matches frontend/src/design/shell.jsx — brand header, scrolling
// nav list with section labels + items + badges, footer with the logged-in
// user's identity. The design's role switcher in the footer is deferred
// to v1.0 (PROJECT_CONTEXT §8) — we render a static identity card in its
// place and put the logout button in the topbar.

import { NavLink } from "react-router-dom";

import type { MeResponse, Role } from "../types";
import { Icon } from "./Icon";
import { NAV } from "./nav";

interface Props {
  role: Role;
  me: MeResponse;
}

function initialsFor(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  return ((parts[0] ?? "")[0]! + (parts[parts.length - 1] ?? "")[0]!).toUpperCase();
}

export function Sidebar({ role, me }: Props) {
  const items = NAV[role];
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-mark">ح</div>
        <div className="brand-name">Hadir</div>
        <div className="brand-tag">v0.1</div>
      </div>

      {/* Search is decorative in P4 — real search lands with employees (P6). */}
      <div className="topbar-search" style={{ width: "100%", margin: "0 0 6px" }}>
        <Icon name="search" size={13} />
        <input placeholder="Search…" />
        <span className="kbd">⌘K</span>
      </div>

      {items.map((it, i) => {
        if ("section" in it) {
          return (
            <div
              key={`s-${i}`}
              className="nav-label"
              style={{ marginTop: i === 0 ? 8 : 12 }}
            >
              {it.section}
            </div>
          );
        }
        return (
          <NavLink
            key={it.id}
            to={`/${it.id}`}
            className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
          >
            <Icon name={it.icon} size={14} />
            <span>{it.label}</span>
            {it.badge && <span className="nav-badge">{it.badge}</span>}
          </NavLink>
        );
      })}

      <div className="sidebar-footer">
        {/*
          TODO(v1.0): restore the role switcher from design/shell.jsx.
          Pilot uses the user's highest role only — PROJECT_CONTEXT §8.
        */}
        <div className="role-switcher" style={{ cursor: "default" }}>
          <div className="avatar">{initialsFor(me.full_name)}</div>
          <div className="role-col">
            <span className="role-label">{me.full_name}</span>
            <span className="role-sub">
              {role.toUpperCase()} · {me.email}
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}
