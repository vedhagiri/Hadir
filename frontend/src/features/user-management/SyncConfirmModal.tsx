// Confirmation popup shown before running an Entra directory sync.
// Lets the operator choose whether synced users a group mapping doesn't
// cover should get the default Employee role. On confirm it runs the
// sync with `default_role` set accordingly.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ModalShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";

const ROLE_OPTIONS = ["Employee", "Manager", "HR", "Admin"] as const;

export function SyncConfirmModal({
  onClose,
  onConfirm,
  pending,
}: {
  onClose: () => void;
  // Receives the chosen default role (or null for "no default") and
  // whether to also create linked employee records.
  onConfirm: (defaultRole: string | null, createEmployees: boolean) => void;
  pending: boolean;
}) {
  const { t } = useTranslation();
  // "" is the "no default role" sentinel → sent as null.
  const [defaultRole, setDefaultRole] = useState<string>("Employee");
  const [createEmployees, setCreateEmployees] = useState(true);

  return (
    <ModalShell onClose={pending ? () => {} : onClose}>
      <div
        role="dialog"
        aria-label={t("userManagement.syncModal.title")}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 480,
          maxWidth: "96vw",
          maxHeight: "92vh",
          background: "var(--bg)",
          border: "1px solid var(--border-strong)",
          borderRadius: 16,
          zIndex: 60,
          boxShadow: "0 24px 64px rgba(0,0,0,0.18)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-elev)",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span
            style={{
              width: 34,
              height: 34,
              borderRadius: 9,
              background: "color-mix(in srgb, var(--accent) 12%, var(--bg))",
              color: "var(--accent)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <Icon name="refresh" size={16} />
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 14.5 }}>
              {t("userManagement.syncModal.title")}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 2 }}>
              {t("userManagement.syncModal.subtitle")}
            </div>
          </div>
        </div>

        <div style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Default role dropdown */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label
              htmlFor="sync-default-role"
              style={{ fontWeight: 600, fontSize: 13 }}
            >
              {t("userManagement.syncModal.defaultRoleLabel")}
            </label>
            <select
              id="sync-default-role"
              className="input"
              value={defaultRole}
              onChange={(e) => setDefaultRole(e.target.value)}
              disabled={pending}
            >
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
              <option value="">
                {t("userManagement.syncModal.noDefaultRole")}
              </option>
            </select>
            <span style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.45 }}>
              {t("userManagement.syncModal.defaultRoleHint")}
            </span>
          </div>

          {/* Create employee profile */}
          <label
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 12,
              padding: "12px 14px",
              borderRadius: 10,
              border: `1px solid ${createEmployees ? "var(--accent)" : "var(--border)"}`,
              background: createEmployees
                ? "color-mix(in srgb, var(--accent) 7%, var(--bg))"
                : "var(--bg)",
              cursor: "pointer",
              transition: "border-color 120ms ease, background 120ms ease",
            }}
          >
            <input
              type="checkbox"
              checked={createEmployees}
              onChange={(e) => setCreateEmployees(e.target.checked)}
              style={{ marginTop: 2, width: 16, height: 16, accentColor: "var(--accent)" }}
            />
            <span>
              <span style={{ display: "block", fontWeight: 600, fontSize: 13 }}>
                {t("userManagement.syncModal.createEmployeeTitle")}
              </span>
              <span
                style={{
                  display: "block",
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  marginTop: 3,
                  lineHeight: 1.45,
                }}
              >
                {t("userManagement.syncModal.createEmployeeHint")}
              </span>
            </span>
          </label>

          <p style={{ margin: 0, fontSize: 12, color: "var(--text-tertiary)", lineHeight: 1.5 }}>
            {t("userManagement.syncModal.note")}
          </p>
        </div>

        <div
          style={{
            padding: "14px 20px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
          }}
        >
          <button
            type="button"
            className="btn btn-sm"
            onClick={onClose}
            disabled={pending}
          >
            {t("userManagement.syncModal.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => onConfirm(defaultRole || null, createEmployees)}
            disabled={pending}
          >
            <Icon name="refresh" size={13} />
            {pending
              ? t("userManagement.syncing")
              : t("userManagement.syncModal.confirm")}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
