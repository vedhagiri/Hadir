// Users page (Admin) — its own top-level sidebar nav item (/users).
// Shows the AD Users directory synced from Microsoft Entra: sync,
// search/filter, per-user access toggle, and role management via the
// details drawer. (Moved out of Settings; AD Users only.) The page
// header (title + Sync / Group mapping actions) is rendered by
// AdUsersView because the actions drive state that lives there.

import { AdUsersView } from "./AdUsersPage";

export function UsersPage() {
  return <AdUsersView />;
}
