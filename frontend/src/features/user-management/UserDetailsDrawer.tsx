// User Details drawer — Overview / Roles & Permissions / Login Activity.
// Mirrors the EmployeeViewDrawer tab structure (DrawerShell + .drawer +
// tab strip + .drawer-body). Role change + access toggle go through the
// shared /api/users PATCH.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { DrawerShell } from "../../components/DrawerShell";
import { RelativeTime } from "../../components/RelativeTime";
import { Icon } from "../../shell/Icon";
import { ChoiceCards, FormHeader, FormNotice, FormSection, SwitchField } from "../../components/FormKit";
import { DrawerTabs } from "../employees/peopleUi";
import {
  ROLE_META,
  ROLE_ORDER,
  avatarColor,
  avatarInitials,
} from "./shared";
import { useLoginActivity, usePatchUser } from "./hooks";
import type { AdUser, RoleCode } from "./types";

type Tab = "overview" | "roles" | "login";

const ROLE_ICON: Record<RoleCode, "shield" | "users" | "user" | "clipboard"> = {
  Admin: "shield",
  HR: "clipboard",
  Manager: "users",
  Employee: "user",
};

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
      <div className="drawer fk-drawer" role="dialog" aria-labelledby="user-details-title">
        <FormHeader
          titleId="user-details-title"
          icon={
            <span
              className="pp-head-avatar"
              style={{ background: avatarColor(user.full_name) }}
            >
              {avatarInitials(user.full_name)}
            </span>
          }
          eyebrow={t("userManagement.drawerTitle")}
          title={user.full_name}
          subtitle={
            <>
              <span className="pp-head-email" title={user.email}>{user.email}</span>
              <span className="pp-drawer-pills pp-head-pills">
                <span className={`pill ${user.ad_status === "active" ? "pill-success" : "pill-neutral"}`}>
                  <Icon name="shield" size={11} />
                  {user.ad_status === "active"
                    ? t("userManagement.adActive")
                    : t("userManagement.adDisabled")}
                </span>
                <span className={`pill ${user.is_active ? "pill-success" : "pill-neutral"}`}>
                  <Icon name="check" size={11} />
                  {user.is_active
                    ? t("userManagement.accessOn")
                    : t("userManagement.accessOff")}
                </span>
                {user.source === "entra" && (
                  <span className="pill pill-info">
                    <Icon name="refresh" size={11} />
                    {t("userManagement.synced")}
                  </span>
                )}
              </span>
            </>
          }
          onClose={onClose}
        />

        <DrawerTabs<Tab>
          label={t("userManagement.drawerTitle")}
          value={tab}
          onChange={setTab}
          tabs={(["overview", "roles", "login"] as const).map((k) => ({
            key: k,
            label: t(`userManagement.tab_${k}`),
          }))}
        />

        <div className="drawer-body fk-body">
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
    <>
      <FormSection columns={1} title={t("userManagement.basicInfo")}>
        <div className="pp-kv">
          <Row label={t("userManagement.displayName")} value={user.full_name} />
          <Row label={t("userManagement.email")} value={user.email} />
          {user.upn && <Row label={t("userManagement.upn")} value={user.upn} mono />}
        </div>
      </FormSection>

      <FormSection columns={1} title={t("userManagement.activeDirectory")}>
        <div className="pp-kv">
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
        </div>
      </FormSection>

      <FormSection
        columns={1}
        title={t("userManagement.applicationAccess")}
        description={t("userManagement.accessApplyNow", {
          defaultValue: "Takes effect immediately and is written to the audit log.",
        })}
      >
        <SwitchField
          id="user-access-toggle"
          label={
            user.is_active
              ? t("userManagement.accessEnabled")
              : t("userManagement.accessDisabled")
          }
          description={t("userManagement.accessHint")}
          checked={user.is_active}
          onChange={() =>
            void patch.mutateAsync({ userId: user.id, is_active: !user.is_active })
          }
          disabled={patch.isPending}
        />
      </FormSection>
    </>
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
    <>
      <FormSection
        columns={1}
        title={t("userManagement.changeRole")}
        description={t("userManagement.changeRoleHelp", {
          defaultValue: "One role per user. The change applies immediately and is audited.",
        })}
        aside={
          current ? (
            <span className="pill pill-accent">
              {t("userManagement.currentRole")}: {t(`role.${current}`, { defaultValue: current })}
            </span>
          ) : (
            <span className="pill pill-neutral">{t("userManagement.noRole")}</span>
          )
        }
      >
        {!current && <FormNotice tone="info">{t("userManagement.noRoleDesc")}</FormNotice>}
        <ChoiceCards<RoleCode>
          label={t("userManagement.changeRole")}
          value={(current ?? "") as RoleCode}
          onChange={setRole}
          options={ROLE_ORDER.map((code) => ({
            value: code,
            title: t(`role.${code}`, { defaultValue: ROLE_META[code].label }),
            description: ROLE_META[code].desc,
            icon: <Icon name={ROLE_ICON[code]} size={15} />,
            disabled: patch.isPending,
          }))}
        />
      </FormSection>
    </>
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
    <>
      <div className="pp-stat-row">
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
      <FormSection columns={1} title={t("userManagement.loginDetails")}>
        <div className="pp-kv">
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
        </div>
      </FormSection>
      <FormSection columns={1} title={t("userManagement.systemInfo")}>
        <div className="pp-kv">
          <Row label={t("userManagement.userId")} value={String(user.id)} mono />
          <Row label={t("userManagement.msObject")} value={user.ms_object_id ?? "—"} mono />
          <Row label={t("userManagement.createdBy")} value={d?.created_by ?? "AD Sync"} />
        </div>
      </FormSection>
    </>
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
    <div className="pp-kv-row">
      <span className="pp-kv-label">{label}</span>
      <span className={`pp-kv-value${mono ? " mono text-xs" : ""}`}>{value}</span>
    </div>
  );
}

function Stat({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}
