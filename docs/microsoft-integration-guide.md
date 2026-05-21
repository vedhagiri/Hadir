# Microsoft integration guide — Maugood

End-to-end guide for the two Microsoft-side integrations Maugood
ships:

1. **Sign in with Microsoft** (Entra ID / Azure AD OIDC) — phase **P6**
2. **Outbound mail via Microsoft Graph** — phase **P18**

Both are already implemented in the codebase. This document explains
the Azure-side configuration an operator has to do, the Maugood-side
config flow, the runtime architecture, and the production checklist.

The two features share one thing only: the same
`MAUGOOD_AUTH_FERNET_KEY` is used to encrypt the OIDC `client_secret`
and the Graph `client_secret` at rest. They are otherwise independent
— you can run either alone, both, or neither.

---

## Part 0 — Shared prerequisites

### Environment variables

These two settings power both features. Set them in
`backend/.env` (dev) or the deploy environment (prod):

| Variable | Purpose | Notes |
| --- | --- | --- |
| `MAUGOOD_AUTH_FERNET_KEY` | Encrypts OIDC `client_secret` + Graph `client_secret` at rest in Postgres | **Distinct from `MAUGOOD_FERNET_KEY`** (which protects RTSP URLs + photo crops + attachments). Generate with `python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`. |
| `MAUGOOD_OIDC_REDIRECT_BASE_URL` | The public origin Entra redirects back to after sign-in | In dev: `http://localhost:8000`. In production: **must be `https://...`** — the production-config guard at `maugood/security.py:90-94` refuses to start the app otherwise. |

In `MAUGOOD_ENV=production`, `check_production_config` (in
`maugood/security.py`) fails fast at boot if either of these is left
at their dev defaults.

### Why a separate Fernet key?

The RTSP/photo key (`MAUGOOD_FERNET_KEY`) and the Microsoft-secrets
key (`MAUGOOD_AUTH_FERNET_KEY`) live in different env vars so an
operator can rotate one without re-encrypting the other. The
photo-encryption key rotation is a multi-hour batch job; rotating
the OIDC/Graph secret is a one-row update per tenant.

### Per-tenant configuration model — **red line**

Both features are configured **per tenant**, never globally:

- Each tenant row in `public.tenants` is independent.
- OIDC config lives in `tenant_oidc_config` (one row per tenant
  schema).
- Email config lives in `email_config` (one row per tenant schema).
- Two tenants can target completely different Azure App
  Registrations, different Entra directories, different
  send-from mailboxes.

You should never share an Entra App Registration across multiple
Maugood tenants. That would re-introduce a tenant-isolation hole —
Tenant A's Admin could in principle harvest auth codes from Tenant
B's users.

---

## Part 1 — Sign in with Microsoft (Entra ID OIDC)

### What you get

- A "Sign in with Microsoft" button on the Maugood login page
  (shown automatically when the tenant has OIDC enabled).
- Authorization Code flow against the tenant's Entra directory.
- Server-side validation of the returned ID token against the
  cached JWKS.
- Email-match against existing `users` rows. **No auto-provision.**
  An unrecognized Microsoft account returns 403, not "welcome,
  please pick a department."

### What you don't get

- **No role/permission derivation from Entra claims.** Roles come
  from Maugood's `user_roles` table only. The Entra-side group
  membership is ignored on purpose — see "Why no auto-provision /
  no claim-driven roles" below.
- **No SCIM / directory sync.** Provisioning a user is still
  "Admin creates the row in Maugood." Microsoft just authenticates
  them.
- **No refresh tokens.** Maugood's own session cookie does the
  sliding-expiry work. The Entra refresh token is discarded
  immediately after the initial code exchange — we only ever need
  the ID token.

---

### 1.1  Azure App Registration

Do this once per Maugood tenant.

1. **Azure portal → Microsoft Entra ID → App registrations → New
   registration.**
   - Name: `Maugood — <tenant slug>` (e.g. `Maugood — Inaisys`)
   - **Supported account types:** see "Single vs multi-tenant"
     below. For an internal-only deployment pick
     "Accounts in this organizational directory only (single
     tenant)".
   - **Redirect URI:** Web → exactly
     `{MAUGOOD_OIDC_REDIRECT_BASE_URL}/api/auth/oidc/callback`,
     e.g. `https://maugood.example.com/api/auth/oidc/callback`.
     The path is fixed at `/api/auth/oidc/callback` — see
     `maugood/auth/oidc.py:455-457` (`_redirect_uri()`).
2. **Capture three values** from the **Overview** tab:
   - **Application (client) ID** → goes into Maugood `client_id`.
   - **Directory (tenant) ID** → goes into Maugood
     `entra_tenant_id`. For multi-tenant apps use the literal
     string `common`.
3. **Certificates & secrets → Client secrets → New client
   secret.**
   - Description: `maugood-oidc-<env>-<YYYYMMDD>` so rotation is
     auditable.
   - Expiry: ≤ 12 months. **Calendar a reminder.** When the secret
     expires, the OIDC callback will start failing with `502 oidc
     token exchange failed` — see "Rotation" below.
   - Copy the **Value** column (not Secret ID) immediately — Azure
     hides it after the page reload.
4. **API permissions → Add a permission → Microsoft Graph →
   Delegated permissions.**
   - `openid`, `email`, `profile`. That's the entire list.
   - These are user-consent-capable, so most Entra directories
     won't require an Admin to grant tenant-wide consent. If your
     tenant restricts user consent ("Admin consent required for
     all apps"), click **Grant admin consent** here.
5. **Token configuration (optional but recommended) → Add
   optional claim → ID → `email`.**
   - Some Entra directories don't populate the `email` claim by
     default. Without this opt-in, Maugood falls back to
     `preferred_username` (which is usually the UPN). That fallback
     works but means the comparison is `upn.lower() == users.email`
     which can break if the user's mail address differs from their
     UPN. Adding the optional `email` claim makes the match
     deterministic.

That's the Azure side. There is **no manifest editing**, no
custom token lifetime policy, no conditional-access exception
required.

---

### 1.2  Single-tenant vs Multi-tenant

This is the most-misunderstood Azure knob. Two different things
share the word "tenant":

| Term | What it means |
| --- | --- |
| **Maugood tenant** | A row in `public.tenants` — one customer org. E.g. "Inaisys", "Omran". |
| **Entra tenant** | An Azure directory — one Microsoft account universe. E.g. `inaisys.onmicrosoft.com`. |

The two are usually 1:1 but don't have to be. The App
Registration's **Supported account types** controls who can sign
in:

- **Single tenant** ("Accounts in this organizational directory
  only") — only users in *that* Entra directory can sign in.
  Maugood stores `entra_tenant_id = "<guid>"` (the Directory ID).
  Best for: corporate internal deployment.
- **Multi-tenant** ("Accounts in any organizational directory") —
  any Entra directory's users can sign in. Maugood stores
  `entra_tenant_id = "common"`. Best for: SaaS deployment where
  multiple customer orgs share one Maugood instance, each pointing
  at their own Entra. **You still need per-Maugood-tenant App
  Registrations** — multi-tenant here just means "the App
  Registration accepts users from outside its home directory."
- **Personal Microsoft accounts** — never set this for Maugood.
  Outlook.com identities are not associated with a corporate
  directory and shouldn't get attendance access.

For Omran's pilot the recommendation is **single tenant** —
explicit, auditable, and the easiest to lock down with conditional
access if HR ever needs it later.

---

### 1.3  Maugood-side per-tenant config

The config is stored in `tenant_oidc_config`. Columns (see
`maugood/db.py` for the canonical definition):

| Column | Holds | Notes |
| --- | --- | --- |
| `entra_tenant_id` | Directory ID (GUID) or `"common"` | Plaintext — not secret. |
| `client_id` | Application (client) ID | Plaintext. |
| `client_secret_encrypted` | Fernet-encrypted client secret | Encrypted with `MAUGOOD_AUTH_FERNET_KEY`. Write-only via the API — never returned. |
| `enabled` | Boolean | When false, the LoginPage hides the Microsoft button and `/api/auth/oidc/login` returns 400. |
| `updated_at` | TIMESTAMPTZ | Bumped on every PATCH. |

Two API surfaces touch this table:

- **Tenant Admin** flow: Maugood Settings → Authentication →
  Microsoft. Endpoints
  `GET /api/auth/oidc/config` + `PUT /api/auth/oidc/config`.
- **Super-Admin** flow: Super-Admin → Tenant X → Microsoft.
  Endpoints `GET/PATCH /api/super-admin/tenants/{id}/oidc-config`.

Both PATCH paths perform a **pre-save discovery probe** — they
fetch `https://login.microsoftonline.com/{entra_tenant_id}/v2.0/.well-known/openid-configuration`
and refuse to persist if Entra returns 404 or a malformed JSON.
This catches the common "I typed the GUID wrong" / "you sent
your Maugood tenant slug instead of the Entra Directory ID"
mistake before it bricks the login button.

**Secret-write contract:** the JSON field `client_secret` is
*write-only*. Sending `""` or `null` means "leave the stored
secret untouched"; sending a string replaces it. The PATCH
response only carries `has_secret: true|false` so an admin can
tell whether a secret was ever set without ever leaking the
plaintext value back.

---

### 1.4  Runtime flow — request lifecycle

This is the actual code path. Read `maugood/auth/oidc.py` start
to finish — it's ~860 lines and the entire flow lives in one
file.

```
┌─────────────────────────────────────────────────────────────────────┐
│ Browser → GET /api/auth/oidc/status?tenant=<slug>                    │
│   • Anonymous. Returns {enabled, has_config}.                        │
│   • LoginPage uses this to decide whether to show the Microsoft btn. │
│                                                                      │
│ Browser → GET /api/auth/oidc/login?tenant=<slug>                     │
│   1. Resolve <slug> → (tenant_id, schema_name) via public.tenants.   │
│   2. Load tenant_oidc_config inside tenant_context(schema).          │
│   3. Discover Entra endpoints (cached for 1 hour).                   │
│   4. Generate random state + nonce.                                  │
│   5. Sign a state-cookie payload                                     │
│      ({tenant_schema, tenant_id, state, nonce, ts}) with HMAC.       │
│   6. Set state cookie (httponly, path=/api/auth/oidc, samesite=lax). │
│   7. 302 to Entra's authorize endpoint.                              │
│                                                                      │
│ Browser → Entra → user signs in / consents → Entra → Browser         │
│                                                                      │
│ Browser → GET /api/auth/oidc/callback?code=…&state=…                 │
│   1. Verify state-cookie signature + match the `state` param.        │
│   2. Re-load tenant config + decrypt client_secret.                  │
│   3. POST to token endpoint with                                     │
│      grant_type=authorization_code, code, redirect_uri,              │
│      client_id, client_secret.                                       │
│   4. Validate the returned id_token:                                 │
│      - signature against cached JWKS,                                │
│      - issuer matches discovery,                                     │
│      - audience matches client_id,                                   │
│      - nonce matches the signed state-cookie value,                  │
│      - not expired.                                                  │
│   5. Extract email (`email` claim, falling back to                   │
│      `preferred_username`). Lower-case.                              │
│   6. SELECT FROM users WHERE tenant_id=… AND email=…                 │
│   7. If no row: audit `auth.oidc.login.failure` + 403.               │
│   8. Otherwise create_session(...) — identical shape to local        │
│      login.                                                          │
│   9. Set maugood_session + maugood_tenant cookies.                   │
│  10. 302 to / (which the SPA routes to /dashboard).                  │
│                                                                      │
│  Throughout: every failure audits as `auth.oidc.login.failure` with  │
│  a structured `reason` field for the security review.                │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.5  Why no auto-provision / no claim-driven roles — **red line**

Two requirements drove this:

- **No auto-provision.** If a Microsoft account were enough to
  create a Maugood user row, then anyone in the Entra directory
  could log in by inertia — an HR analyst who'd never been
  onboarded to Maugood would get an Employee account the moment
  they clicked "Sign in with Microsoft." That's not a feature,
  that's an access leak. Provisioning stays an explicit Admin
  action (`POST /api/employees`, `POST /api/users`).
- **No claim-driven roles.** Some Azure setups expose group
  membership as a token claim (`groups: [...]`). Tempting to map
  "Maugood-HR" group → HR role. **Don't.** Roles are Maugood's
  source of truth; the Entra side is just authentication. If a
  rogue Entra Admin creates a group called "Maugood-Admin" and
  drops their own user into it, you'd inherit the breach without
  ever realising. Maugood-side role assignments are immune to
  that.

If you ever need to lift either red line, do it via Maugood's own
flows (an HR-bulk-add screen, an LDAP-sync background job that
runs under explicit operator credentials), not via OIDC claims.

### 1.6  Frontend flow

The LoginPage uses `useTenantOidcStatus` (in `frontend/src/auth/`)
to probe `/api/auth/oidc/status?tenant=<slug>` whenever the user
types or paste a tenant slug. If enabled:

- "Sign in with Microsoft" becomes the **primary** CTA (per P6
  spec).
- The local email + password form moves below as a secondary
  option (preserved so HR / break-glass accounts that aren't
  tied to Entra still work).

Clicking the Microsoft button does
`window.location.href = '/api/auth/oidc/login?tenant=<slug>'`
— a full-page navigation, not an XHR. The state cookie wouldn't
survive a SPA route hop, and AuthN flows want to be top-level
navigations for browser-security reasons.

After the callback redirects to `/`, the SPA's
`AuthProvider.useMe()` fetches `/api/auth/me`, populates the
cache, and `ProtectedRoute` lets the user through to
`/dashboard`.

### 1.7  Rotation + monitoring

**Secret rotation cadence:** every Azure client secret expires
(24 months max, recommended ≤ 12 months). Calendar a quarterly
audit:

1. Azure → App Registration → Certificates & secrets → New
   secret with a future-dated description.
2. Maugood → Settings → Authentication → Microsoft → paste the
   new secret value → Save. The PATCH validator pings discovery
   before persisting; the old secret stays live until the PATCH
   commits, so there's no outage window.
3. Azure → delete the old secret (only after at least one
   successful Microsoft sign-in confirms the new one works).

**What to monitor:**

- `audit_log` rows with `action='auth.oidc.login.failure'`
  bucketed by `after->>'reason'`. Healthy steady state should
  be near-zero. Sustained `no_user_match` reasons usually mean
  a new hire's user row hasn't been created yet; sustained
  `id_token_invalid` means the App Registration is misconfigured;
  sustained `token_exchange_failed` (especially with
  `AADSTS7000215`) means the secret has expired.
- `audit_log` rows with `action='auth.oidc.login.success'` —
  every successful Microsoft sign-in lands here with the
  resolved email. Useful for forensics ("who logged in last
  Tuesday?") without exposing the underlying session ID.

---

### 1.8  Testing checklist

Pre-deploy on a non-prod tenant:

- [ ] `/api/auth/oidc/status?tenant=<slug>` returns
      `{enabled: true, has_config: true}` after PATCHing the
      config.
- [ ] Clicking "Sign in with Microsoft" redirects to
      `login.microsoftonline.com/<entra_tenant>/...`.
- [ ] Signing in with a registered Maugood user lands on
      `/dashboard` and `/api/auth/me` returns the right roles.
- [ ] Signing in with an unrecognized Entra account returns
      the literal message **"Your Microsoft account is not
      registered in Maugood. Contact your administrator."**
      (`oidc.py:740-746`).
- [ ] Tampering with the state cookie produces 400 `invalid or
      expired oidc state`.
- [ ] Replaying a used callback URL produces 400
      `oidc state mismatch` (state is single-use).
- [ ] `grep -E 'client_secret|access_token' backend/logs/app.log`
      returns **zero** lines.
- [ ] `audit_log` carries one success row per sign-in with
      `entity_type='user'` + the email in `after`.

CI coverage (already in `tests/test_oidc.py`):

- `test_status_disabled_when_no_secret`
- `test_callback_no_user_match`
- `test_callback_state_mismatch`
- `test_callback_with_expired_id_token`
- `test_secret_is_never_returned`

---

### 1.9  Production checklist

Before flipping OIDC on for real users:

- [ ] `MAUGOOD_OIDC_REDIRECT_BASE_URL` starts with `https://`.
- [ ] `MAUGOOD_AUTH_FERNET_KEY` is set, distinct from
      `MAUGOOD_FERNET_KEY`, and **not** the dev default.
- [ ] The Azure App Registration's Redirect URI matches
      `${MAUGOOD_OIDC_REDIRECT_BASE_URL}/api/auth/oidc/callback`
      **exactly** — character for character. Trailing slash,
      port, scheme all matter.
- [ ] At least one HR user in Maugood has a non-Entra password
      set so a break-glass login is possible if Entra is
      unreachable.
- [ ] Calendar reminder set for the Azure client secret expiry.
- [ ] Audit-log retention policy (P25) covers the
      `auth.oidc.*` actions.

---

## Part 2 — Microsoft Graph mail

### What you get

- Per-tenant outbound email via Microsoft Graph's `/sendMail`
  endpoint.
- Tenant-branded HTML templates rendered by Jinja.
- Used by: scheduled reports (P18), notifications (P20), admin
  override notifications (P16), camera-unreachable alerts.

### What you don't get

- **No reading mail.** Maugood is write-only against Graph; we
  never pull from the user's inbox.
- **No calendar / contacts / OneDrive.** Mail send is the only
  Graph surface used.
- **No delegated-mail.** See "Application vs delegated
  permissions" below — the pilot is application-only.

---

### 2.1  Application vs delegated permissions — **load-bearing decision**

This is the single most-important Microsoft-Graph design
choice. Read this section even if you skim the rest.

| | Delegated permission | Application permission |
| --- | --- | --- |
| OAuth flow | Authorization Code or On-Behalf-Of | **Client credentials** |
| Who Graph thinks is sending | The end user who consented | The app itself, posting *from* a specified mailbox |
| Token lifetime | 1 hour, refresh-token-renewable | 1 hour, **no refresh token** — just re-do client-credentials |
| Consent | Per-user (user clicks "Allow") | **Admin consent required, once per Entra tenant** |
| Mail.Send scope | `Mail.Send` (delegated) | `Mail.Send` (application) — different beast |
| Maugood needs | A user signed in actively | None — fires from a scheduler at 3 AM |

**Maugood chose application permissions** (client-credentials
flow). The decision is baked into `maugood/emailing/providers.py:124-156`:

```python
class GraphSender:
    _LOGIN = "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"
    _SEND = "https://graph.microsoft.com/v1.0/users/{addr}/sendMail"

    def _get_access_token(self) -> str:
        ...
        resp = client.post(
            self._LOGIN.format(tenant=cfg.tenant_id),
            data={
                "client_id": cfg.client_id,
                "client_secret": cfg.client_secret,
                "grant_type": "client_credentials",
                "scope": "https://graph.microsoft.com/.default",
            },
        )
        ...
```

Why client-credentials wins for Maugood:

- **Scheduled reports run at 03:00 Asia/Muscat.** The user who
  set up the schedule is asleep. Delegated permissions require
  a live user session — they don't fit the use case.
- **No refresh token to babysit.** Client-credentials returns a
  fresh access token on every send. The token isn't even cached
  between sends in v1.0 — `GraphSender.send()` does a fresh
  exchange. (Caching is a P19+ optimisation noted in the
  module docstring; the trade-off was "the extra POST is cheap
  vs. the complexity of handling expiry"). When this becomes a
  bottleneck (>10 emails/sec), add a per-process token cache
  keyed on `(tenant_id, client_id)` with a 50-minute TTL.
- **Sender mailbox is server-config, not per-message.** Every
  email from a given Maugood tenant comes from one configured
  mailbox (e.g. `maugood-noreply@inaisys.co`). That mailbox
  needs a licence and an active SMTP-receivable
  mailbox in Exchange Online — but you don't pay per-user.

### When you'd want delegated instead

Only if your operator requires "this email looks like it came
*from the actual user* who triggered the action." E.g. "when
HR clicks Approve, the approval email should come from HR's
personal address." That's not Maugood's model — approval emails
come from the tenant noreply address, with the HR person's name
appearing inside the email body as the approver. If the
requirements change to need per-actor From, a new module
(`maugood/emailing/delegated_provider.py`) would need to:

1. Add a refresh-token column to `email_config` (or a separate
   per-user token table).
2. Re-run the OIDC code-exchange with the Graph `Mail.Send`
   scope to obtain the first access+refresh-token pair.
3. Add a `refresh-token → access-token` exchange to `GraphSender`,
   with retries on the inevitable "AADSTS70008: refresh token
   expired" failures (90-day inactivity window).

Don't speculatively build that. Add it only if a real customer
asks for per-actor From.

---

### 2.2  Azure App Registration for Graph mail

You can use a **separate** App Registration from the OIDC one,
or reuse the same one with both permissions attached. Separate
is recommended — different secrets, different rotation cadences,
easier to revoke if one is compromised.

1. **Azure portal → Microsoft Entra ID → App registrations → New
   registration.**
   - Name: `Maugood Mail — <tenant slug>`.
   - **Supported account types:** Single tenant. Mail-send
     never spans Entra directories.
   - **Redirect URI:** *blank*. Client-credentials doesn't use
     one.
2. **Capture Application (client) ID + Directory (tenant) ID**
   from the Overview tab.
3. **Certificates & secrets → New client secret.** Same caveats
   as the OIDC secret — ≤12-month expiry, capture the Value
   immediately.
4. **API permissions → Add a permission → Microsoft Graph →
   Application permissions** (not Delegated):
   - `Mail.Send`. That's all.
   - **Click "Grant admin consent for {directory}".** Without
     this the client-credentials token will exchange fine but
     `/sendMail` will return 403 `ErrorAccessDenied`. This is
     the single most common Graph misconfiguration.
5. **(Optional, recommended for tighter blast radius)** —
   restrict the app to one specific mailbox. Without this, the
   Application `Mail.Send` permission lets the app send from
   *every* mailbox in the Entra directory. Tighten with an
   **Application Access Policy**:

   ```powershell
   # PowerShell with the Exchange Online module
   New-ApplicationAccessPolicy `
     -AppId <client_id> `
     -PolicyScopeGroupId maugood-mail-from@inaisys.co `
     -AccessRight RestrictAccess `
     -Description "Restrict Maugood mail-send to one mailbox"
   ```

   `maugood-mail-from@...` here is a mail-enabled security group
   containing **only** the mailbox(es) Maugood is allowed to send
   from. After applying, `/sendMail` from anything outside the
   group returns 403.

6. **Provision the sender mailbox.** Either a regular licensed
   user (`maugood-noreply@yourdomain.com`) or a shared mailbox.
   Both work with application `Mail.Send`. Shared mailboxes
   don't require a licence but show "(Shared)" on some Outlook
   clients.

---

### 2.3  Maugood-side per-tenant config

`email_config` table — relevant columns
(`backend/maugood/db.py:769-803`):

| Column | Holds | Notes |
| --- | --- | --- |
| `provider` | `'smtp'` or `'microsoft_graph'` | CHECK-constrained. |
| `graph_tenant_id` | Directory ID (Entra) | Plaintext. Not the Maugood tenant — see "Two senses of tenant." |
| `graph_client_id` | Application (client) ID | Plaintext. |
| `graph_client_secret_encrypted` | Fernet-encrypted secret | Same key as OIDC. Write-only via API. |
| `from_address` | The mailbox we send from | Must match the licence/shared-mailbox configured in Azure. |
| `from_name` | Display name | Free text, e.g. `"Maugood @ Inaisys"`. |
| `enabled` | Boolean | When false, scheduled-reports + notification workers skip the send + record `delivery_skipped` in `report_runs.delivery_mode`. |

API surfaces (`maugood/emailing/router.py`):

| Method + Path | Role |
| --- | --- |
| `GET /api/email-config` | Admin — returns the config with `has_secret` instead of the secret. |
| `PUT /api/email-config` | Admin — accepts secret (empty/null = leave untouched). |
| `POST /api/email-config/test` | Admin — sends a test email to the caller's email, returns 200 on Graph 200/202, 400 with the structured Graph error otherwise. |

The **test-send** endpoint is the single most-useful diagnostic
during initial setup. It runs the full token-exchange +
`/sendMail` REST call and surfaces the error verbatim (with the
secret stripped). The three errors you'll see during setup, with
fixes:

| Graph error | Maugood surface | Fix |
| --- | --- | --- |
| `AADSTS7000215 — Invalid client secret provided` | `graph token exchange failed: 401` | The client secret value has expired or was copy-pasted with leading/trailing whitespace. Re-paste from Azure. |
| `Forbidden — Mail.Send: This permission is required to access this resource` | `graph sendMail failed: 403` | Application permission added but **admin consent not granted.** Azure → API permissions → "Grant admin consent". |
| `MailboxNotEnabledForRESTAPI` | `graph sendMail failed: 405` | The `from_address` mailbox doesn't have an Exchange Online licence, or it's on-prem-only. Pick a cloud mailbox. |

---

### 2.4  Runtime flow — outbound send

Triggered by three pieces:

- **Scheduled reports runner** (`maugood/scheduled_reports/runner.py`)
  — APScheduler 60-second scan picks rows with
  `next_run_at <= now()`, generates the report, calls
  `get_sender(config).send(message)`.
- **Notification worker** (`maugood/notifications/worker.py`) —
  30-second scan picks `notifications` rows with
  `email_sent_at IS NULL`, re-resolves preferences per row,
  calls the same `get_sender(...).send(...)` path.
- **Test-send endpoint** — Admin-triggered, one-shot.

All three go through the same factory
(`maugood/emailing/providers.py:301-340`):

```python
def get_sender(config: SenderConfig) -> EmailSender:
    ...
    if config.provider == "smtp":
        return SmtpSender(SmtpConfig(...))
    if config.provider == "microsoft_graph":
        return GraphSender(GraphConfig(...))
    raise ValueError(...)
```

`SenderConfig` is constructed by the caller with the secret
**already decrypted in-memory** — neither `SmtpSender` nor
`GraphSender` ever sees the ciphertext token (P18 red line).
The plaintext secret exists only on the stack frame between
`decrypt_secret(...)` and the `httpx.Client(...).post(...)` call,
and is garbage-collected immediately after.

**Per-send Graph REST flow:**

```
1. POST https://login.microsoftonline.com/{entra_tenant}/oauth2/v2.0/token
   ┌─────────────────────────────────────────┐
   │ Form body:                              │
   │   grant_type=client_credentials         │
   │   client_id=<from email_config>         │
   │   client_secret=<decrypted ciphertext>  │
   │   scope=https://graph.microsoft.com/.default │
   └─────────────────────────────────────────┘
   ← 200 OK with { "access_token": "eyJ...", "expires_in": 3599, ... }

2. POST https://graph.microsoft.com/v1.0/users/{from_address}/sendMail
   ┌─────────────────────────────────────────────────────┐
   │ Headers:                                            │
   │   Authorization: Bearer <access_token>              │
   │   Content-Type: application/json                    │
   │ Body:                                               │
   │   { "message": { subject, body, toRecipients,       │
   │                  from, attachments }, ... }         │
   └─────────────────────────────────────────────────────┘
   ← 202 Accepted  (Graph queues, no body)
```

Failure handling:

- Token-exchange non-200 → `RuntimeError("graph token exchange
  failed: <status>")`. The body is *intentionally not logged* —
  it can echo the secret back on some errors.
- `/sendMail` non-2xx → `RuntimeError("graph sendMail failed:
  <status>")`. The notification worker treats this as a transient
  failure, bumps `email_attempts`, and retries on the next tick
  until a configurable max-attempts limit, after which the row
  is marked `email_failed_at` and dropped from the queue.

---

### 2.5  What flows through Graph mail

| Use case | Trigger | Recipients |
| --- | --- | --- |
| **Daily / weekly attendance report** | `report_schedules` cron firing | `report_schedules.recipients` list |
| **Approval routed** (Manager pending) | Employee submits request | Assigned Manager(s) |
| **Approval decided** | Manager / HR / Admin acts | Submitting employee |
| **Admin override** | Admin overrides on a closed request | Original Manager + HR decider + Employee (P16) |
| **Overtime first-time-today** | Attendance recompute flips overtime 0→>0 | Employee + their manager |
| **Camera unreachable >5 min** | Camera-health watcher | All Admin role-holders |
| **Test send** | Admin clicks "Send test" in Settings → Email | The Admin's own email |

All recipients are resolved against the tenant's `users` table
**inside `tenant_context(schema)`** — never across tenants. P20
adds the per-recipient language resolution: each notification is
rendered separately per recipient's `preferred_language` claim
(load-bearing P21 red line — Manager A in Arabic and Manager B
in English get different copies from the same event).

---

### 2.6  Templates

HTML templates live under
`backend/maugood/emailing/templates/`:

- `report.html` — attendance + scheduled reports
- `notification.html` — every notification kind (request
  status, override, overtime, camera offline)

Both extend a shared `base.html` that renders the tenant-branded
header (accent colour from `primary_color_key`, logo as inline
`data:` URL — never a network reference, so corporate mail
clients with image-blocking still show the brand).

Rendering happens in `maugood/emailing/render.py`. Plain-text
alternative is auto-generated from the HTML via a basic tag
strip — sufficient for Outlook's preview pane.

Adding a new email kind:

1. Add a new template file under `templates/`.
2. Add a producer function in the appropriate module (e.g.
   `notifications/producers.py`).
3. The producer renders the template, builds an `EmailMessage`
   value object, inserts a `notifications` row, and returns —
   the 30-second worker picks it up. **Don't synchronously
   call `get_sender(...).send(...)` from a request handler** —
   that ties the request latency to Microsoft's response time.

---

### 2.7  Security best practices

These are all already in place — don't regress them:

- **Secrets encrypted at rest.** Fernet via `MAUGOOD_AUTH_FERNET_KEY`.
  The plaintext only exists between `decrypt_secret(...)` and the
  `httpx.Client.post(...)` call.
- **Secrets write-only in the API.** `GET /api/email-config`
  returns `has_secret: bool`, never the ciphertext or plaintext.
  Same convention as RTSP URLs (pilot P7) and OIDC secrets (P6).
- **Per-tenant isolation.** Every send happens inside
  `tenant_context(schema)`. A bug that leaked Tenant A's recipient
  list into Tenant B's send would have to survive that scope plus
  the WHERE-tenant_id filter on every query.
- **No body-logging on Graph errors.** Token-exchange and
  `/sendMail` error bodies are intentionally not echoed to logs
  — Microsoft sometimes echoes the secret back in 401 bodies for
  debugging convenience that is anti-security on our side.
- **Application access policy.** Optional but strongly
  recommended in production — without it, anyone with the
  client_id+secret could send from any mailbox in the Entra
  directory. See §2.2 step 5.
- **Audit trail.** Every send writes a `report_runs` row
  (scheduled reports) or `notifications` row (everything else)
  with `email_sent_at` set on success. Easy to query for the
  forensics question "did Maugood actually send that email?"

---

### 2.8  Testing checklist

Pre-deploy:

- [ ] `POST /api/email-config/test` returns 200 from an Admin
      session. The Admin receives the test message within ~30
      seconds.
- [ ] A scheduled report fires on schedule (set up a
      one-shot schedule with `next_run_at = now + 2 min` via the
      Settings UI, watch `report_runs` for the row).
- [ ] A notification fires (submit a request, then check
      `notifications` table for `email_sent_at`).
- [ ] `grep -E 'access_token|client_secret' backend/logs/app.log`
      returns **zero** matches.
- [ ] If you've applied the Application Access Policy: confirm
      that **sending from a different mailbox** (try editing
      `from_address` to a colleague's address) produces a 403
      from Graph rather than going through.

CI coverage already in place (selected from
`tests/test_emailing.py`, `tests/test_scheduled_reports.py`):

- `test_graph_sender_calls_token_then_sendmail`
- `test_graph_sender_swallows_secret_on_error_body`
- `test_email_config_secret_never_returned`
- `test_test_send_surfaces_graph_403_verbatim`

---

### 2.9  Production checklist

- [ ] `MAUGOOD_AUTH_FERNET_KEY` set, not the dev default.
- [ ] Admin consent granted in Azure for the
      `Mail.Send` application permission.
- [ ] Application Access Policy restricting the app to the
      Maugood `from_address` mailbox.
- [ ] `from_address` is a mailbox you actually own — Azure does
      not validate this at registration time, and sending from a
      forged address produces a *200 OK* from Graph but the email
      silently bounces.
- [ ] DKIM + DMARC configured on the sending domain. Without
      these, corporate spam filters on the recipient side will
      file Maugood reports in junk.
- [ ] Calendar reminder for the Graph client secret expiry.
- [ ] Monitor `notifications.email_failed_at` — sustained
      failures usually mean either the secret expired, the
      application access policy changed, or the mailbox was
      disabled.

---

## Part 3 — Anti-patterns to avoid

A few "common Stack Overflow answers" that are actively wrong
for Maugood — documenting so they don't get re-introduced
during a future refactor.

- **Don't add the `msal` Python package.** Maugood deliberately
  uses raw `httpx` REST calls (P18). `msal` pulls in a token
  cache, an HTTP client of its own, and a Windows-specific
  credential store — none of which we need for two URL POSTs.
  See `maugood/emailing/providers.py:1-15` docstring.
- **Don't poll Graph for sent-message status.** The 202 from
  `/sendMail` is the strongest acknowledgement Graph gives.
  Trying to query `/me/messages` to confirm delivery requires
  delegated permissions and doesn't reflect cross-domain
  delivery anyway.
- **Don't put the OIDC redirect URI behind a path-rewrite
  proxy.** Entra string-matches it character-for-character
  against the App Registration. If nginx is rewriting `/api/`
  → `/`, the path Maugood thinks it's serving and the path
  Entra is redirecting to will diverge silently. The Maugood
  nginx config in `ops/nginx/` already gets this right; if you
  customise, preserve the exact path.
- **Don't co-mingle the OIDC and Mail App Registrations'
  secrets.** They're separate columns (`client_secret_encrypted`
  in `tenant_oidc_config` vs `graph_client_secret_encrypted` in
  `email_config`) on purpose, so rotation of one doesn't force
  rotation of the other.
- **Don't try to "Sign in with Microsoft" *and* send mail with
  the same access token.** The OIDC token has scopes
  `openid email profile`. Even if you added `Mail.Send`
  delegated to the OIDC App Registration, the access token from
  the code-exchange wouldn't include it without an explicit
  `&scope=` on the authorize redirect, and the user would have
  to consent. The two flows are separate by design — see §2.1.

---

## Cross-reference

- `backend/maugood/auth/oidc.py` — OIDC flow end-to-end.
- `backend/maugood/emailing/providers.py` — `SmtpSender` +
  `GraphSender` + the pluggable factory.
- `backend/maugood/emailing/secrets.py` — Fernet helpers shared
  with OIDC.
- `backend/maugood/config.py:115-120` — env vars
  (`auth_fernet_key`, `oidc_redirect_base_url`).
- `backend/maugood/security.py:90-94` — production-config guard.
- `backend/maugood/db.py:769-803` — `email_config` schema.
- `backend/tests/test_oidc.py` — OIDC unit + integration tests.
- `backend/tests/test_emailing.py` — Graph sender unit tests.
- `docs/deploy-production.md` — runbook for the full prod
  deploy (mentions Fernet key generation in §2).
- `frontend/src/auth/LoginPage.tsx` — the "Sign in with
  Microsoft" CTA logic.
- `frontend/src/features/settings/EmailConfigPage.tsx` — Admin
  UI for the Graph config.
