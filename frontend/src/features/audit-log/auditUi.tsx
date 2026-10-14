// Shared Audit Log cells (actor avatar + name), used by the list rows
// and the detail drawer.

import { useTranslation } from "react-i18next";

import { Icon } from "../../shell/Icon";
import type { AuditEntry } from "./types";

function initials(name: string): string {
  const parts = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function ActorCell({ entry }: { entry: AuditEntry }) {
  const { t } = useTranslation();
  if (entry.actor_user_id === null) {
    return (
      <span className="al-actor">
        <span className="al-avatar is-system" aria-hidden>
          <Icon name="settings" size={13} />
        </span>
        <span className="al-actor-text">
          <span className="al-actor-name">{t("auditLog.systemActor", { defaultValue: "System" })}</span>
          {entry.actor_label && <span className="al-actor-sub">{entry.actor_label.replace(/_/g, " ")}</span>}
        </span>
      </span>
    );
  }
  const name = entry.actor_name || entry.actor_email || t("auditLog.deletedUser", { id: entry.actor_user_id, defaultValue: "User #{{id}}" });
  return (
    <span className="al-actor" title={entry.actor_email ?? undefined}>
      <span className="al-avatar" aria-hidden>
        {initials(name)}
      </span>
      <span className="al-actor-text">
        <span className="al-actor-name">{name}</span>
        {entry.actor_email && entry.actor_name && <span className="al-actor-sub">{entry.actor_email}</span>}
      </span>
    </span>
  );
}
