# Maugood — Google Sign-In & Microsoft SSO (Azure AD) Integration

**Audience:** implementers + operators integrating single sign-on with
Maugood's employee/attendance platform.
**Scope:** Microsoft SSO (Entra ID / Azure AD) — *shipped* (v1.0 P6);
Google Sign-In — *design to implement on the same pattern*; employee
validation, RBAC, and Active Directory synchronization.

> **Status legend**
> - ✅ **Implemented** — in the codebase today (`backend/maugood/auth/oidc.py`).
> - 🟡 **Design** — recommended approach, not yet built; follows the
>   implemented pattern so it drops in cleanly.

---

## 0. TL;DR — the load-bearing rules (read this first)

These are **hard red lines** already enforced for Microsoft and must be
kept for Google and any AD sync:

1. **Never auto-provision users from an IdP.** A successful Microsoft/Google
   sign-in that doesn't match an existing tenant `users` row (by
   lower-cased email) is **refused with HTTP 403** — no account is created.
2. **Never derive roles from IdP claims/groups.** Roles live in Maugood's
   own `user_roles` table and are managed through Maugood's admin UI. Entra
   groups / Google Workspace roles are **ignored** for authorization.
3. **Email is the only mapping key.** The IdP's verified `email` (fallback
   `preferred_username`) is lower-cased and matched against
   `users.email` (a case-insensitive `citext` column, unique per tenant).
4. **Everything is per-tenant.** SSO is configured, enabled, and audited
   per tenant. A user signs in *to a named tenant*; cross-tenant is
   impossible by construction.
5. **Secrets are encrypted at rest (Fernet) and never logged.** Client
   secrets, tokens, and codes never appear in logs, audit rows, exceptions,
   or API responses.

---

## 1. Concepts & data model

### 1.1 `users` vs `employees` — two different things

| Table | Purpose | Key columns |
| --- | --- | --- |
| `users` | **Login identities** — who can authenticate + their roles | `id`, `tenant_id`, `email` (citext, unique per tenant), `full_name`, `is_active` |
| `employees` | **Attendance subjects** — people the cameras identify | `id`, `tenant_id`, `employee_code`, `full_name`, `email`, `status` |
| `user_roles` | RBAC join | `(user_id, role_id, tenant_id)` |
| `roles` | Role catalog | `Admin`, `HR`, `Manager`, `Employee` (seeded per tenant) |

An `employee` is **not** automatically a `user`. To let a person **log
in** (SSO or password), a matching **`users`** row with at least one role
must exist. The two are linked by **lower-cased email** (the same join the
attendance router uses today: `func.lower(employees.c.email) == user.email`).

> A dedicated `employee_id ↔ user_id` FK join table is on the backlog
> (`docs/v1.x-backlog.md` B-1). Until then, **email is the join** — keep
> `users.email` and `employees.email` consistent.

### 1.2 Per-tenant SSO config (implemented for Microsoft)

Table **`tenant_oidc_config`** (one row per tenant):

| Column | Notes |
| --- | --- |
| `tenant_id` (PK, FK `public.tenants.id`) | scope |
| `entra_tenant_id` | Azure AD tenant GUID or verified domain |
| `client_id` | App registration (client) ID |
| `client_secret_encrypted` | **Fernet-encrypted** with `MAUGOOD_AUTH_FERNET_KEY` |
| `enabled` | master on/off for this tenant |
| `updated_at` | bookkeeping |

### 1.3 Environment variables

| Env var | Default | Purpose |
| --- | --- | --- |
| `MAUGOOD_AUTH_FERNET_KEY` | *(dev placeholder)* | Encrypts OIDC client secrets. **Separate** from `MAUGOOD_FERNET_KEY` (photos/RTSP). Rotate independently. |
| `MAUGOOD_OIDC_REDIRECT_BASE_URL` | `http://localhost:8000` | Public base URL; the redirect URI is `{base}/api/auth/oidc/callback`. In production this is your HTTPS hostname. |
| `MAUGOOD_OIDC_STATE_TTL_SECONDS` | `600` | Lifetime of the signed state cookie between `/login` and `/callback`. |
| `MAUGOOD_OIDC_CLOCK_SKEW_SECONDS` | `60` | Allowed clock skew when validating `exp`/`nbf`. |

Generate a Fernet key (stdlib only, works on a clean host):

```bash
python3 -c "import base64,os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())"
```

---

## 2. Microsoft SSO (Entra ID / Azure AD) — ✅ Implemented

Module: `backend/maugood/auth/oidc.py` · Router prefix: `/api/auth/oidc`
Frontend: **Settings → Authentication** (config) + **Login page**
("Sign in with Microsoft" CTA).

### 2.1 Azure portal — app registration (one-time, per tenant)

1. **Azure Portal → Microsoft Entra ID → App registrations → New
   registration.**
   - **Name:** e.g. `Maugood Attendance (Omran)`.
   - **Supported account types:** *Accounts in this organizational
     directory only* (single tenant) — recommended for an internal
     workforce app.
   - **Redirect URI:** platform **Web**, value:
     `https://<your-maugood-host>/api/auth/oidc/callback`
     (must exactly equal `MAUGOOD_OIDC_REDIRECT_BASE_URL` +
     `/api/auth/oidc/callback`).
2. **Certificates & secrets → New client secret.** Copy the **Value**
   immediately (shown once). Set a rotation reminder (e.g. 12–24 months).
3. **API permissions:** the default **Microsoft Graph → `openid`,
   `email`, `profile`, `User.Read`** (delegated) is sufficient. Sign-in
   needs *no* admin-consented app permissions — Maugood only reads the ID
   token, it does **not** call Graph for sign-in.
4. **Token configuration (recommended):** add the optional **`email`**
   claim to the ID token so the `email` claim is always present.
   (Maugood falls back to `preferred_username`/UPN if `email` is absent.)
5. Note three values for Maugood:
   - **Directory (tenant) ID** → `entra_tenant_id`
   - **Application (client) ID** → `client_id`
   - **Client secret Value** → `client_secret`

### 2.2 Configure in Maugood (Admin)

**UI:** Settings → Authentication → fill Entra tenant ID, Client ID,
Client secret → **Enable** → Save.

**API** (Admin session required):

```bash
# Read current config (secret is masked as has_secret: true/false)
curl -s https://<host>/api/auth/oidc/config -b cookies.txt

# Update + enable (client_secret is write-only; omit to keep existing)
curl -s -X PUT https://<host>/api/auth/oidc/config \
  -b cookies.txt -H 'Content-Type: application/json' \
  -d '{
        "entra_tenant_id": "00000000-0000-0000-0000-000000000000",
        "client_id":       "11111111-1111-1111-1111-111111111111",
        "client_secret":   "<secret-value>",
        "enabled":         true
      }'
```

**PUT validation:** when you enable it (or change the tenant ID), Maugood
**pings the Entra discovery endpoint first** and refuses to save a broken
config (`400 entra discovery validation failed`). Idempotent re-saves of a
valid config don't re-ping Microsoft.

Discovery URL used:
`https://login.microsoftonline.com/{entra_tenant_id}/v2.0/.well-known/openid-configuration`

### 2.3 Endpoints

| Method + path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/auth/oidc/status?tenant=<slug>` | anonymous | Does this tenant have SSO enabled? Drives the "Sign in with Microsoft" button. |
| `GET /api/auth/oidc/login?tenant=<slug>` | anonymous | Starts the flow — 302 to Entra. |
| `GET /api/auth/oidc/callback` | anonymous | Entra redirects back here. |
| `GET /api/auth/oidc/config` | Admin | Read config (secret masked). |
| `PUT /api/auth/oidc/config` | Admin | Update config (validates discovery). |

### 2.4 Login flow (end-to-end)

```
 Browser                     Maugood backend                 Entra ID
   │                              │                              │
   │ 1. GET /oidc/login?tenant=omran                            │
   ├─────────────────────────────►│                             │
   │                              │ resolve tenant slug→schema  │
   │                              │ load enabled config         │
   │                              │ discover() (cached 5m)      │
   │                              │ mint state+nonce, HMAC-sign │
   │ 2. 302 → Entra authorize URL │  → Set-Cookie maugood_oidc_state (signed)
   │◄─────────────────────────────┤                             │
   │ 3. GET authorize?client_id&redirect_uri&scope=openid email profile
   │      &response_type=code&response_mode=query&state&nonce   │
   ├──────────────────────────────────────────────────────────►│
   │ 4. user authenticates (+ MFA)                              │
   │◄──────────────────────────────────────────────────────────┤
   │ 5. 302 → /oidc/callback?code=…&state=…                     │
   ├─────────────────────────────►│                             │
   │                              │ verify signed state cookie  │
   │                              │ + state param match         │
   │                              │ 6. exchange code──────────► │
   │                              │◄────────── id_token + tokens │
   │                              │ 7. validate id_token:       │
   │                              │    iss, aud=client_id,      │
   │                              │    nonce, exp/nbf(+skew),   │
   │                              │    signature vs JWKS(cached)│
   │                              │ 8. email = claims.email     │
   │                              │    (fallback preferred_username), lower()
   │                              │ 9. SELECT users WHERE       │
   │                              │    tenant_id=? AND email=?  │
   │                              │    AND is_active            │
   │              ┌───────────────┴───────────────┐             │
   │       match found                     no match / inactive  │
   │              │                                │            │
   │  create_session() +                    403 "not registered │
   │  Set-Cookie maugood_session,            — contact admin"   │
   │  maugood_tenant; active_role =          + audit failure    │
   │  highest role (P7)                                          │
   │  audit auth.oidc.login.success                             │
   │ 10. 302 → /  (logged in)                                   │
   │◄─────────────────────────────┤                             │
```

**Security properties baked in:**
- **CSRF/replay:** HMAC-signed, TTL-bound `state` cookie
  (`maugood_oidc_state`, path-scoped to `/api/auth/oidc`); `state` param
  must match; `nonce` bound into the ID token.
- **Token authenticity:** ID token signature validated against the
  tenant's JWKS (cached 5 min), with `iss`/`aud`/`nonce`/`exp`/`nbf`
  checks and a configurable clock-skew leeway.
- **No secret leakage:** token-exchange errors deliberately omit response
  bodies; audit rows carry only `reason` / `email_attempted` / `ip`.
- **Session parity:** an SSO session is byte-for-byte the same as a
  password session (`maugood_session` + `maugood_tenant` cookies, sliding
  expiry, `active_role` seeded to the highest role).

### 2.5 Audit actions

- `auth.oidc.login.success` — `{ip, session_id, tenant_schema, email}`
- `auth.oidc.login.failure` — `{reason, email_attempted, ip}` where
  `reason ∈ {entra_error:*, state_mismatch, token_exchange_failed:*,
  no_id_token, id_token_invalid:*, no_email_claim, no_user_match,
  config_disabled}`

---

## 3. Google Sign-In — 🟡 Design (implement on the P6 pattern)

Google is a standards-compliant OpenID Connect provider, so it slots into
the **exact same flow** as Microsoft. Today the login page shows a
placeholder ("Google sign-in isn't enabled … configure under Settings →
Authentication"). The recommended implementation reuses `oidc.py` almost
verbatim.

### 3.1 Google Cloud Console — one-time setup (per tenant)

1. **Google Cloud Console → APIs & Services → OAuth consent screen.**
   - **User type:** *Internal* if the workforce uses Google Workspace
     (restricts to your domain — strongly recommended); else *External*.
   - Fill app name, support email, authorized domain(s).
   - Scopes: `openid`, `email`, `profile` (non-sensitive; no verification
     needed).
2. **Credentials → Create credentials → OAuth client ID.**
   - **Application type:** *Web application*.
   - **Authorized redirect URIs:**
     `https://<your-maugood-host>/api/auth/oidc/google/callback`
     *(or reuse `/api/auth/oidc/callback` with a `provider` in the signed
     state — see 3.3)*.
   - Copy **Client ID** and **Client secret**.
3. **(Recommended) Domain restriction:** for Workspace tenants, validate
   the ID token's **`hd`** (hosted domain) claim equals your domain so
   only your org's Google accounts can even reach the email-match step.

### 3.2 Discovery & scopes

- Discovery URL: `https://accounts.google.com/.well-known/openid-configuration`
- `authorization_endpoint`: `https://accounts.google.com/o/oauth2/v2/auth`
- `token_endpoint`: `https://oauth2.googleapis.com/token`
- Scopes: `openid email profile`
- Issuer to validate: `https://accounts.google.com`
- Verify `email_verified == true` in the ID token before matching.

### 3.3 Recommended code change (minimal, additive)

Generalize the single-provider config into a provider-aware shape rather
than duplicating the module:

1. **Schema:** either add a `provider` discriminator + a Google row, or a
   sibling table. Recommended, least-churn:

   ```
   -- Migration 0091 (design): generalize tenant_oidc_config
   ALTER TABLE tenant_oidc_config ADD COLUMN provider text NOT NULL DEFAULT 'microsoft';
   -- allow (tenant_id, provider) instead of tenant_id PK
   -- new columns for Google: google_client_id, google_client_secret_encrypted,
   -- google_hosted_domain (nullable), google_enabled
   ```
   (Keep it schema-agnostic — no hardcoded `main`/`public`; add
   `maugood_app` grants; see `docs/…` migration rules.)

2. **Discovery template:** replace the hardcoded `_ENTRA_DISCOVERY_URL`
   with a per-provider lookup:
   ```python
   DISCOVERY = {
     "microsoft": "https://login.microsoftonline.com/{tenant_id}/v2.0/.well-known/openid-configuration",
     "google":    "https://accounts.google.com/.well-known/openid-configuration",
   }
   ```
   Google has no per-tenant path segment, so `discover("google")` ignores
   `tenant_id`.

3. **Endpoints:** add `GET /api/auth/oidc/google/login` +
   `.../google/callback` (or thread a `provider` param through the
   existing two). Everything after token validation — email extraction,
   the `users` lookup, session creation, audit — is **identical** and
   should be shared.

4. **Extra Google checks:** enforce `email_verified == true` and, when
   configured, `hd == <workspace-domain>` before the email match.

### 3.4 Google login flow

Identical to §2.4 with Google as the IdP. The only provider-specific
differences: discovery URL, issuer (`https://accounts.google.com`), the
`email_verified` check, and the optional `hd` domain gate. **Same
email-match, same no-auto-provision 403, same session creation.**

---

## 4. Employee validation & account mapping

> This section answers the "can an existing employee log in with
> Google/Microsoft?" questions directly.

### 4.1 Can an existing employee log in via SSO?

**Yes — if and only if there is a matching `users` row** (same tenant,
same lower-cased email, `is_active = true`) **with at least one role.**
Creating an `employees` row alone does **not** grant login.

### 4.2 How mapping is handled

- IdP returns a verified `email` (or UPN via `preferred_username`).
- Maugood lower-cases it and does:
  `SELECT … FROM users WHERE tenant_id = :t AND email = :email AND is_active`.
- `users.email` is `citext`, so matching is case-insensitive and unique
  per tenant.
- Keep `users.email` == the person's IdP primary email == (ideally)
  `employees.email`. If they diverge, SSO matches on `users.email`.

### 4.3 Email exists in Entra/Google but **not** in Maugood

**Sign-in is refused with HTTP 403** and the operator-actionable message:

> *"Your Microsoft account is not registered in Maugood. Contact your
> administrator."*

No account is created (no auto-provision). A failure audit row
(`auth.oidc.login.failure`, `reason=no_user_match`, `email_attempted`) is
written so admins can see who tried. **Fix:** an Admin creates the
`users` row (and assigns roles) via Maugood, then the person can sign in.

### 4.4 Duplicate / mismatched accounts

- **Duplicates are structurally impossible:** `users.email` is unique per
  `(tenant_id, email)`. You cannot have two Maugood users with the same
  email in one tenant.
- **Mismatch (IdP email ≠ Maugood email):** no match → 403. Resolution is
  to align the Maugood `users.email` to the person's IdP email (Admin
  edit), never to loosen the match.
- **Same email across tenants:** allowed and isolated — each tenant has
  its own `users` table and its own SSO config; a sign-in is always scoped
  to one tenant (the slug in the login URL).
- **Inactive user:** `is_active = false` → treated as no match (403).
  Deactivate a user to instantly block both SSO and password login.

### 4.5 Onboarding checklist (operator)

1. Create/confirm the **`employees`** record (for attendance).
2. Create the **`users`** record with the **same email** and assign
   role(s). *(Until the operator user-creation API lands — backlog B-1 —
   use the seed/admin tooling or the admin UI.)*
3. Ensure the person's IdP email matches.
4. They click **Sign in with Microsoft/Google** on the tenant login page.

---

## 5. Role-Based Access Control (RBAC)

### 5.1 Where roles come from — **always Maugood, never the IdP**

Roles (`Admin`, `HR`, `Manager`, `Employee`) live in Maugood's
`user_roles` table and are assigned through Maugood's admin surfaces.
**Entra group membership and Google Workspace roles are deliberately
ignored.** This is a hard red line (BRD FR-AUTH-006): the IdP proves
*identity*, Maugood decides *authorization*.

**Why:** it keeps a single, auditable source of truth for "who can do
what," prevents privilege escalation via directory-group changes outside
your control, and keeps RBAC working identically for password users and
SSO users.

### 5.2 Multi-role & active role (P7)

A user may hold several roles. The session stores an **`active_role`**;
SSO seeds it to the user's highest role (`Admin > HR > Manager >
Employee`), same as password login. Users switch active role in the
top-bar; `POST /api/auth/switch-role` re-scopes their permissions and
audits `auth.role.switched`.

### 5.3 Manager scope

A Manager's visibility is the **union of `manager_assignments` +
`user_departments`** (`get_manager_visible_employee_ids`). Assign managers
in Maugood; this is independent of any directory hierarchy.

### 5.4 Managing role updates

- **Change a role:** Admin edits `user_roles` in Maugood. Takes effect on
  the user's next request (guards re-evaluate per request).
- **Revoke access:** remove roles or set `is_active = false` — blocks both
  SSO and password login immediately.
- **Do not** wire role changes to IdP group sync (see §6 for why AD sync
  should stay identity-only).

---

## 6. Active Directory (AD) integration & synchronization — 🟡 Design

"Azure AD" (Entra ID) is already your cloud directory; §2 covers
*authentication* against it. This section covers optional *directory
synchronization* — keeping Maugood's `users`/`employees` in step with the
directory.

### 6.1 On-prem AD vs Entra ID

- **On-prem Active Directory:** sync it up to **Entra ID** with **Azure
  AD Connect** (Microsoft's tool). Maugood then integrates with Entra only
  — it never talks LDAP directly. This is the recommended topology.
- **Entra ID (cloud):** Maugood can optionally run a **read-only Microsoft
  Graph sync** to reconcile its tables from a designated group.

### 6.2 Recommended sync model — *identity only, opt-in, non-authoritative for roles*

| Concern | Recommendation |
| --- | --- |
| **Source of truth for login-eligibility** | A designated Entra **security group** (e.g. `Maugood-Users`). Only its members are synced. |
| **Source of truth for roles** | **Maugood** — sync never sets roles (red line §5.1). New synced users land with **no role** (cannot act) until an Admin assigns one, *or* a default `Employee` role if the tenant opts in explicitly. |
| **Should only synced users log in?** | **Optional per-tenant toggle.** *Strict mode:* only users present in Maugood (whether synced or hand-created) can log in — which is already true (§4.3). Sync just automates the `users` row creation; the 403-on-no-match guard stays. |
| **Direction** | **One-way: Entra → Maugood.** Maugood never writes back to the directory. |

### 6.3 Lifecycle handling

| Directory event | Maugood action |
| --- | --- |
| **New member** of the sync group | Upsert a `users` row (email, full_name) `is_active=true`, **no role** (or default `Employee` if opted in). Optionally upsert a matching `employees` row. |
| **Account disabled** in Entra (`accountEnabled=false`) | Set `users.is_active=false` → blocks SSO + password instantly. Keep the row (audit history, attendance linkage). |
| **Removed from group** | Same as disabled (deactivate), *not* delete — preserves attendance/audit references. |
| **Deleted from directory** | Deactivate; optionally route to the **PDPL delete** flow (`POST /api/employees/{id}/gdpr-delete`) if data erasure is required. Never hard-delete silently. |
| **Attribute change** (name/email) | Update `users`/`employees`; email changes are sensitive (they're the SSO key) — log + audit them. |

### 6.4 Periodic synchronization — implementation

Mirror the existing scheduler pattern (`retention`, `lifecycle`,
`daily-clip-cleanup`): an APScheduler job iterating `public.tenants`, each
tenant inside a `tenant_context(schema)`.

- **Mechanism:** Microsoft Graph, app-only (client-credentials) token with
  `GroupMember.Read.All` + `User.Read.All` (**application** permissions,
  admin-consented). Use **delta queries**
  (`/groups/{id}/members/delta`) so each run only processes changes.
- **Cadence:** configurable per tenant (e.g. hourly or nightly). Nightly
  is plenty for attendance.
- **Idempotent & fail-closed:** upsert by email; a Graph failure for one
  tenant is logged and skipped — never blocks other tenants; never mass-
  deactivates on an empty/error response (guard: refuse to deactivate more
  than N% of users in one run).
- **Audit:** one `directory.synced` row per tenant per run with
  `{created, deactivated, updated}` counts. Never log tokens.
- **Config:** a per-tenant `tenant_directory_sync` table
  (`enabled`, `group_id`, `default_role` nullable, `cron`, `last_run_at`)
  + write-only app secret (Fernet), same conventions as
  `tenant_oidc_config`.

```
 APScheduler tick (per tenant, tenant_context(schema))
   │
   ├─ app-only Graph token (client credentials)
   ├─ GET /groups/{group_id}/members/delta   (delta link persisted)
   │     ├─ added   → upsert users(is_active=true, role=none|default)
   │     ├─ changed → update name/email (audit email change)
   │     └─ removed → users.is_active=false
   ├─ safety guard: abort if deactivations > N% of active users
   └─ audit directory.synced {created, updated, deactivated}
```

> **Design principle:** sync manages *who exists and whether they're
> enabled*. It never manages *what they can do* (roles). That stays with
> Maugood admins.

---

## 7. Recommended architecture (putting it together)

### 7.1 Component view

```
                 ┌──────────────────────────────────────────────┐
                 │                  Maugood                      │
                 │                                               │
  Microsoft ───► │  auth/oidc.py  ──┐                            │
  (Entra ID)     │                  │  email match (lower-case)  │
                 │  Google OIDC ────┼──► users (per tenant) ◄────┼── Admin UI (roles)
  (Google) ────► │  (same module)   │        │                   │
                 │                  │        └─ user_roles (RBAC) │
  Directory ───► │  directory sync ─┘        employees (attendance)
  (Graph delta)  │  (identity only, opt-in)                      │
                 └──────────────────────────────────────────────┘
   IdP proves IDENTITY.            Maugood owns AUTHORIZATION + lifecycle.
```

### 7.2 The golden path (recommended for Omran-style deployments)

1. **Authentication:** Microsoft SSO (Entra) as the primary CTA; password
   login as fallback for non-directory accounts (e.g. contractors).
   Add Google only if a subset of users are on Google Workspace.
2. **Provisioning:** enable **opt-in directory sync** from a
   `Maugood-Users` Entra group so `users` rows are created/deactivated
   automatically. New users get **no role** until an Admin grants one.
3. **Authorization:** roles assigned in Maugood only. Managers scoped via
   assignments/departments.
4. **Offboarding:** disabling a directory account (or removing from the
   group) deactivates the Maugood user within one sync cycle; SSO + login
   are blocked immediately at the `is_active` check regardless.
5. **Data erasure:** route true deletions through the PDPL delete flow.

### 7.3 Security checklist (production)

- [ ] HTTPS everywhere; `MAUGOOD_OIDC_REDIRECT_BASE_URL` is the public
      HTTPS host; cookies `Secure` (`MAUGOOD_SESSION_COOKIE_SECURE=true`).
- [ ] Redirect URIs in Azure/Google **exactly** match the configured
      callback URL.
- [ ] `MAUGOOD_AUTH_FERNET_KEY` set to a strong, rotated key, distinct
      from the photo/RTSP key; stored in a secrets manager, not in git.
- [ ] Client secrets rotated on a schedule; PUT config re-validates
      discovery on change.
- [ ] Single-tenant app registration (or verified `hd` for Google) so
      only your org's accounts can authenticate.
- [ ] Optional `email` claim enabled in Entra; `email_verified` enforced
      for Google.
- [ ] No role/group claims trusted for authorization.
- [ ] Sync (if enabled) is one-way, delta-based, fail-closed, with a
      mass-deactivation guard, and audited.
- [ ] Failure audits reviewed periodically for `no_user_match` (people
      trying to sign in who aren't provisioned).

### 7.4 What to build to complete this (delta from today)

| Item | Effort | Notes |
| --- | --- | --- |
| Google Sign-In | Small | Generalize `oidc.py` to a `provider` discriminator (§3.3); reuse the whole post-token pipeline. |
| Operator user-creation API/UI | Medium | Backlog B-1 — needed so admins can provision `users` without seed scripts. |
| `employee_id ↔ user_id` join table | Medium | Replace the email-join with an explicit FK; removes the "emails must match" foot-gun. |
| Directory sync (Graph delta) | Medium | New scheduler + `tenant_directory_sync` config; identity-only. |

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| "Sign in with Microsoft" button doesn't appear | `status` probe returns `enabled=false` | Config incomplete/disabled, or wrong tenant slug in the login URL. |
| 403 "not registered — contact administrator" | No matching active `users` row | Create the `users` row with the person's IdP email + a role. |
| `400 entra discovery validation failed` on save | Wrong `entra_tenant_id` or no network to Microsoft | Verify the tenant GUID/domain; check egress. |
| `502 oidc token exchange failed` | Wrong client secret / redirect URI mismatch | Re-check secret; ensure Azure/Google redirect URI == `{base}/api/auth/oidc/callback`. |
| `400 invalid id_token` | Clock skew, wrong audience, or stale JWKS | Check server time; confirm `client_id`; JWKS auto-refreshes every 5 min. |
| Works in dev, fails in prod | `MAUGOOD_OIDC_REDIRECT_BASE_URL` still `localhost` | Set it to the public HTTPS host and register that redirect URI. |

---

## 9. Reference — related docs & code

- Implementation: `backend/maugood/auth/oidc.py`
- Config table: `tenant_oidc_config` (`backend/maugood/db.py`)
- Settings: `backend/maugood/config.py` (`auth_fernet_key`,
  `oidc_redirect_base_url`, `oidc_state_ttl_seconds`,
  `oidc_clock_skew_seconds`)
- Existing operator guides: `docs/microsoft-integration-guide.md`,
  `docs/microsoft-login-setup.md`, `docs/microsoft-login-beginner-guide.md`
- RBAC / roles: `.claude/skills/role-management`
- Backlog items referenced: `docs/v1.x-backlog.md` (B-1)
