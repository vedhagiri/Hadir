// User Details drawer — Overview / Roles & Permissions / Login Activity.
// Mirrors the EmployeeViewDrawer tab structure (DrawerShell + .drawer +
// tab strip + .drawer-body). Role change + access toggle go through the
// shared /api/users PATCH.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { DrawerShell } from "../../components/DrawerShell";
import { RelativeTime } from "../../components/RelativeTime";
import { Icon } from "../../shell/Icon";
import {
  AccessToggle,
  ROLE_META,
  ROLE_ORDER,
  avatarColor,
  avatarInitials,
} from "./shared";
import { useLoginActivity, usePatchUser } from "./hooks";
import type { AdUser, RoleCode } from "./types";

type Tab = "overview" | "roles" | "login";

export function UserDetailsDrawer({
  user,
  onClose,
}: {
  user: AdUser;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("overview");

  return (
    <DrawerShell onClose={onClose}>
      <div className="drawer" role="dialog" aria-label={t("userManagement.drawerTitle")}>
        <div className="drawer-head" style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "var(--text-tertiary)",
              }}
            >
              {t("userManagement.drawerTitle")}
            </span>
            <button
              type="button"
              className="icon-btn"
              aria-label={t("common.close", { defaultValue: "Close" })}
              onClick={onClose}
              style={{ fontSize: 18, lineHeight: 1 }}
            >
              ×
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span
              style={{
                width: 46,
                height: 46,
                borderRadius: "50%",
                background: avatarColor(user.full_name),
                color: "#fff",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 15,
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {avatarInitials(user.full_name)}
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 17, fontWeight: 700 }}>{user.full_name}</div>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {user.email}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Pill
              tone={user.ad_status === "active" ? "green" : "muted"}
              icon="shield"
            >
              {user.ad_status === "active"
                ? t("userManagement.adActive")
                : t("userManagement.adDisabled")}
            </Pill>
            <Pill tone={user.is_active ? "green" : "muted"} icon="check">
              {user.is_active
                ? t("userManagement.accessOn")
                : t("userManagement.accessOff")}
            </Pill>
            {user.source === "entra" && (
              <Pill tone="blue" icon="refresh">
                {t("userManagement.synced")}
              </Pill>
            )}
          </div>
        </div>

        <nav
          style={{
            display: "flex",
            gap: 4,
            padding: "0 16px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          {(["overview", "roles", "login"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={tab === k}
              onClick={() => setTab(k)}
              style={{
                background: "none",
                border: "none",
                padding: "10px 10px",
                fontSize: 13,
                fontWeight: tab === k ? 600 : 400,
                color: tab === k ? "var(--text)" : "var(--text-secondary)",
                borderBottom:
                  tab === k ? "2px solid var(--accent)" : "2px solid transparent",
                cursor: "pointer",
              }}
            >
              {t(`userManagement.tab_${k}`)}
            </button>
          ))}
        </nav>

        <div className="drawer-body">
          {tab === "overview" && <OverviewTab user={user} />}
          {tab === "roles" && <RolesTab user={user} />}
          {tab === "login" && <LoginTab user={user} />}
        </div>
      </div>
    </DrawerShell>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function OverviewTab({ user }: { user: AdUser }) {
  const { t } = useTranslation();
  const patch = usePatchUser();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <Section title={t("userManagement.basicInfo")}>
        <Row label={t("userManagement.displayName")} value={user.full_name} />
        <Row label={t("userManagement.email")} value={user.email} mono />
        {user.upn && <Row label={t("userManagement.upn")} value={user.upn} mono />}
      </Section>

      <Section title={t("userManagement.activeDirectory")}>
        <Row label={t("userManagement.department")} value={user.department ?? "—"} />
        <Row label={t("userManagement.jobTitle")} value={user.job_title ?? "—"} />
        <Row
          label={t("userManagement.adStatus")}
          value={
            user.ad_status === "active"
              ? t("userManagement.adActive")
              : t("userManagement.adDisabled")
          }
        />
        <Row
          label={t("userManagement.msObject")}
          value={user.ms_object_id ?? "—"}
          mono
        />
        <Row
          label={t("userManagement.lastSynced")}
          value={user.last_synced_at ? <RelativeTime iso={user.last_synced_at} /> : "—"}
        />
      </Section>

      <Section title={t("userManagement.applicationAccess")}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "12px 14px",
            borderRadius: 10,
            background: user.is_active
              ? "color-mix(in srgb, #0a8a52 8%, var(--bg))"
              : "var(--bg-sunken)",
            border: `1px solid ${user.is_active ? "var(--success-border)" : "var(--border)"}`,
          }}
        >
          <div>
            <div style={{ fontWeight: 600, fontSize: 13 }}>
              {user.is_active
                ? t("userManagement.accessEnabled")
                : t("userManagement.accessDisabled")}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
              {t("userManagement.accessHint")}
            </div>
          </div>
          <AccessToggle
            checked={user.is_active}
            onChange={() =>
              void patch.mutateAsync({ userId: user.id, is_active: !user.is_active })
            }
            disabled={patch.isPending}
          />
        </div>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Roles & Permissions
// ---------------------------------------------------------------------------

function RolesTab({ user }: { user: AdUser }) {
  const { t } = useTranslation();
  const patch = usePatchUser();
  const current = user.role_codes[0] as RoleCode | undefined;

  const setRole = (code: RoleCode) => {
    if (patch.isPending) return;
    void patch.mutateAsync({ userId: user.id, role_codes: [code] });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div
        className="card"
        style={{ padding: 16, display: "flex", flexDirection: "column", gap: 6 }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "var(--text-tertiary)",
            }}
          >
            {t("userManagement.currentRole")}
          </span>
          {current ? (
            <span className="pill pill-accent">{current}</span>
          ) : (
            <span style={{ color: "var(--text-tertiary)", fontSize: 12 }}>
              {t("userManagement.noRole")}
            </span>
          )}
        </div>
        <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
          {current ? ROLE_META[current].desc : t("userManagement.noRoleDesc")}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--text-tertiary)",
            marginBottom: 4,
          }}
        >
          {t("userManagement.changeRole")}
        </span>
        {ROLE_ORDER.map((code) => {
          const active = current === code;
          return (
            <button
              key={code}
              type="button"
              onClick={() => setRole(code)}
              disabled={patch.isPending}
              style={{
                textAlign: "start",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                padding: "12px 14px",
                marginBottom: 8,
                borderRadius: 10,
                border: `1px solid ${active ? "var(--accent-border, var(--accent))" : "var(--border)"}`,
                background: active
                  ? "color-mix(in srgb, var(--accent) 8%, var(--bg))"
                  : "var(--bg)",
                cursor: patch.isPending ? "default" : "pointer",
              }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>
                  {ROLE_META[code].label}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 1 }}>
                  {ROLE_META[code].desc}
                </div>
              </div>
              {active && <Icon name="check" size={16} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Login Activity
// ---------------------------------------------------------------------------

function LoginTab({ user }: { user: AdUser }) {
  const { t } = useTranslation();
  const act = useLoginActivity(user.id);
  const d = act.data;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "flex", gap: 12 }}>
        <Stat value={String(d?.total_logins ?? user.login_count)} label={t("userManagement.totalLogins")} />
        <Stat
          value={
            user.last_login_at ? (
              <RelativeTime iso={user.last_login_at} />
            ) : (
              t("userManagement.never")
            )
          }
          label={t("userManagement.lastLogin")}
        />
      </div>
      <Section title={t("userManagement.loginDetails")}>
        <Row
          label={t("userManagement.authProvider")}
          value={providerLabel(user.auth_provider)}
        />
        <Row label={t("userManagement.loginCount")} value={String(user.login_count)} />
        <Row
          label={t("userManagement.accountStatus")}
          value={
            user.is_active
              ? t("userManagement.accessGranted")
              : t("userManagement.accessDisabled")
          }
        />
      </Section>
      <Section title={t("userManagement.systemInfo")}>
        <Row label={t("userManagement.userId")} value={String(user.id)} mono />
        <Row label={t("userManagement.msObject")} value={user.ms_object_id ?? "—"} mono />
        <Row label={t("userManagement.createdBy")} value={d?.created_by ?? "AD Sync"} />
      </Section>
    </div>
  );
}

function providerLabel(p: string | null): string {
  if (p === "microsoft") return "Microsoft SSO";
  if (p === "google") return "Google SSO";
  if (p === "password") return "Local password";
  return "—";
}

// ---------------------------------------------------------------------------
// Presentational bits
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--text-tertiary)",
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>{children}</div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 14,
        padding: "9px 0",
        borderBottom: "1px solid var(--border)",
        fontSize: 13,
      }}
    >
      <span style={{ color: "var(--text-secondary)", flexShrink: 0 }}>{label}</span>
      <span
        className={mono ? "mono" : undefined}
        style={{
          textAlign: "end",
          wordBreak: "break-all",
          fontSize: mono ? 12 : 13,
        }}
      >
        {value}
      </span>
    </div>
  );
}

function Stat({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <div
      className="card"
      style={{ flex: 1, padding: "14px 16px", textAlign: "center" }}
    >
      <div style={{ fontSize: 20, fontWeight: 700, color: "var(--accent)" }}>{value}</div>
      <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 2 }}>
        {label}
      </div>
    </div>
  );
}

function Pill({
  children,
  tone,
  icon,
}: {
  children: React.ReactNode;
  tone: "green" | "blue" | "muted";
  icon: "shield" | "check" | "refresh";
}) {
  const styles: Record<string, { bg: string; fg: string; bd: string }> = {
    green: {
      bg: "var(--success-soft)",
      fg: "var(--success-text)",
      bd: "var(--success-border)",
    },
    blue: {
      bg: "color-mix(in srgb, #2563eb 10%, var(--bg))",
      fg: "#2563eb",
      bd: "color-mix(in srgb, #2563eb 30%, var(--border))",
    },
    muted: {
      bg: "var(--bg-sunken)",
      fg: "var(--text-tertiary)",
      bd: "var(--border)",
    },
  };
  const s = styles[tone]!;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 11,
        fontWeight: 600,
        padding: "3px 9px",
        borderRadius: 999,
        background: s.bg,
        color: s.fg,
        border: `1px solid ${s.bd}`,
      }}
    >
      <Icon name={icon} size={11} />
      {children}
    </span>
  );
}
