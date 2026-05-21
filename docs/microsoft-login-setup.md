# Microsoft Login — Setup Guide

Step-by-step setup for **Sign in with Microsoft** in Maugood. Designed
so an operator new to Azure can follow it top-to-bottom and reach a
working Microsoft sign-in button.

**This document is the setup guide.** The architecture, code-paths,
security rationale, and Graph-mail integration are documented in
`docs/microsoft-integration-guide.md` — read that for "why" decisions
were made; read this for "what to click."

The Maugood-side feature (P6) is fully implemented in
`backend/maugood/auth/oidc.py`. Nothing in Maugood needs new code to
turn this on — only Azure configuration plus paste-into-UI per
tenant.

---

## What you'll have when done

- A blue **"Sign in with Microsoft"** button on the Maugood login page
  (shown automatically when OIDC is enabled for the tenant).
- Users authenticate against your Entra directory (or personal
  Microsoft accounts if you opt in) — never with a Maugood password.
- Existing local email+password sign-in keeps working as a fallback.
- Every Microsoft sign-in audits as `auth.oidc.login.success` (or
  `…failure` with a structured reason) in `audit_log`.

What you will NOT get (by design — see
`docs/microsoft-integration-guide.md §1.5`):

- Auto-provisioning of new Maugood users from Microsoft.
- Role / department assignment derived from Entra group claims.

Microsoft does authentication. Maugood does authorization. The Maugood
`users` row + `user_roles` is still the source of truth.

---

## Prerequisites

Before you start:

- **Maugood is running** (dev or prod). `curl http://localhost:8000/api/health`
  returns `{"status":"ok"}`.
- You have **Admin role** in the target Maugood tenant. (Super-Admin
  works too — both can edit OIDC config.)
- You have **at least Application Developer role** in the target
  Microsoft Entra directory (or can ask someone who does to follow
  Part A on your behalf).
- You can **add new users to Maugood**. Microsoft sign-in only works
  for accounts whose email already exists in `users` — see
  "How user-matching works" below.

### Pick a tenant ID strategy first

There are two Azure-side modes that flow into Maugood configuration:

| Use case | Azure "Supported account types" | Maugood `entra_tenant_id` |
| --- | --- | --- |
| Internal corporate, single org | **Accounts in this organizational directory only** | The directory GUID (e.g. `4b8a…-…-…-…`) |
| SaaS, multiple Entra directories | **Accounts in any organizational directory** | `common` (literal string) |
| Personal Microsoft accounts (Outlook.com, Hotmail) only | **Personal Microsoft accounts only** | `consumers` |
| Both work and personal | **Any org directory + personal MS accounts** | `common` |

For Omran's pilot, **single tenant** is the default and the
recommendation — explicit and auditable. For testing with your own
Outlook.com account before any corporate accounts exist, use **any org
directory + personal accounts** with `entra_tenant_id=common` — see
Part E.

---

## Part A — Azure / Entra ID setup

Time: ~5 minutes if you know where things are; ~20 minutes the first time.

### A1. Open Microsoft Entra ID

1. Open <https://portal.azure.com> and sign in with an Entra account
   that has at least Application Developer role.
2. In the left nav, click **Microsoft Entra ID** (formerly "Azure
   Active Directory").
3. Click **App registrations** in the Entra ID menu.

**Verify:** you see a list of existing app registrations (or "no apps
yet"). If you see "Access denied", your account doesn't have the
needed role — ask a directory admin.

### A2. Create a new App Registration

1. Click **+ New registration** at the top.
2. **Name:** `Maugood — <tenant slug>` (e.g. `Maugood — Inaisys`).
   This name appears on the consent screen the user sees, so make it
   recognisable.
3. **Supported account types:** pick from the table above. For a
   first-time test where you want to use your own Outlook.com account,
   pick **Accounts in any organizational directory and personal
   Microsoft accounts**.
4. **Redirect URI:** the dropdown decides what Maugood gets back.
   - Type: **Web** (not SPA — Maugood does the code exchange
     server-side).
   - URI:
     - **Dev:** `http://localhost:8000/api/auth/oidc/callback`
     - **Prod:** `https://your-host.example.com/api/auth/oidc/callback`
   - **Exact match matters.** Entra string-compares this against
     what Maugood sends, character by character. Trailing slash,
     port, scheme all count. If you're not sure of your prod URL
     yet, add `http://localhost:8000/...` for now and add a prod URI
     later (App Registration supports multiple redirect URIs).
5. Click **Register**.

**Verify:** you land on the Overview page. Note the **Application
(client) ID** — a GUID, copy it now. You'll paste this into Maugood
as `client_id` in Part B.

### A3. Capture the directory ID (or use a special value)

On the same Overview page:

- **Directory (tenant) ID** — another GUID. Copy this for Maugood's
  `entra_tenant_id` if you picked **single-tenant** in A2.
- If you picked **any org directory**, use the literal `common`
  instead.
- If you picked **any org directory + personal accounts**, also use
  `common`.
- If you picked **personal accounts only**, use `consumers`.

### A4. Generate a client secret

1. Left nav under your App: **Certificates & secrets**.
2. **+ New client secret**.
3. **Description:** `maugood-oidc-<env>-<YYYYMMDD>` (e.g.
   `maugood-oidc-prod-2026-05-20`) — this is what shows up later when
   you need to find which secret to rotate.
4. **Expires:** 12 months. (24 months is the Azure max but harder to
   keep on the rotation calendar.)
5. Click **Add**.
6. **Copy the Value column immediately.** Not the "Secret ID" — the
   "Value". Azure shows it once. If you navigate away or refresh, it's
   gone and you have to create a new secret.

**Verify:** the new secret appears in the list with your description.
Paste the secret somewhere safe (password manager) until you finish
Part B.

### A5. Configure API permissions

1. Left nav: **API permissions**.
2. **+ Add a permission → Microsoft Graph → Delegated permissions.**
3. Check exactly three permissions:
   - `openid`
   - `email`
   - `profile`
4. Click **Add permissions**.

You should see all three with **Status = Not granted** (yellow icon).
For most Entra directories these three are user-consent-capable, so
they don't need admin consent — the first user who signs in will
click "Allow" once and that's it for everyone.

If your directory has the "Admin consent required for all apps"
setting on, click **Grant admin consent for {directory}** here.
Without that, users will see "AADSTS65001: needs admin approval" on
their first sign-in attempt.

### A6. (Optional but recommended) Add the `email` optional claim

Some Entra directories don't include the `email` claim in ID tokens by
default. Maugood falls back to `preferred_username` (the UPN) when
`email` is missing, but turning it on makes user-matching deterministic
even when the UPN differs from the user's mail.

1. Left nav: **Token configuration**.
2. **+ Add optional claim → ID token → check `email`.**
3. Click **Add**. Azure may prompt you to "Turn on Microsoft Graph
   email permission" — click yes.

### A7. (Optional) Configure branding

The text and logo a user sees on the Microsoft consent screen comes
from the **Branding & properties** page of the App Registration. Set:

- **Publisher domain** — usually your verified domain (e.g.
  `inaisys.co`) so users see "verified" next to your app name.
- **Logo** — your company logo. Reduces "is this a phishing site?"
  drop-off.

This is cosmetic; the integration works fine without it.

---

## Part B — Maugood per-tenant configuration

### B1. Set the required env variables

Two env vars affect OIDC. They're set **once per Maugood deployment**,
not per tenant:

```bash
# In /home/hari-inaisys/Omran/Hadir/.env  (dev)
# or in your production env config.

# Separate from MAUGOOD_FERNET_KEY (which protects RTSP URLs +
# photos). Same separation rationale as in the architecture guide.
MAUGOOD_AUTH_FERNET_KEY=<generate one>

# The public base URL users hit. Used to build the redirect URI.
# In dev: localhost:8000. In prod: must be https://...
MAUGOOD_OIDC_REDIRECT_BASE_URL=http://localhost:8000
```

Generate `MAUGOOD_AUTH_FERNET_KEY`:

```bash
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

After editing `.env`:

```bash
docker compose up -d backend
```

(Use `up -d`, **not** `restart` — `restart` doesn't reload `.env`.)

**Verify:**

```bash
docker compose exec -T backend env | grep -E 'OIDC|AUTH_FERNET'
```

Both vars should print with the values you set.

### B2. Paste the Azure values into the Maugood UI

1. Sign in to Maugood as Admin.
2. **Sidebar → Settings → Authentication → Microsoft** (route:
   `/settings/auth-microsoft` — adjust per your nav if customised).
3. Fill three fields:
   - **Entra Directory ID** — paste the value from A3 (GUID, or
     `common`, or `consumers`).
   - **Client ID** — paste from A2 (GUID).
   - **Client Secret** — paste the **Value** column from A4 (not the
     Secret ID).
4. Toggle **Enabled = ON**.
5. Click **Save**.

What happens on save: Maugood pings
`https://login.microsoftonline.com/{entra_tenant_id}/v2.0/.well-known/openid-configuration`
before persisting the config. If discovery fails (wrong directory ID,
network unreachable), the save returns **400** with the actual reason
— you can't accidentally save a broken config.

**Verify:**

```bash
# Replace <tenant-slug> with your friendly slug (e.g. inaisys).
curl -s "http://localhost:8000/api/auth/oidc/status?tenant=<tenant-slug>" \
  | python3 -m json.tool
```

Expected response:

```json
{"enabled": true, "has_config": true}
```

If either is `false`:
- `enabled=false` — you forgot to toggle it on.
- `has_config=false` — the secret didn't save. Re-paste, ensuring you
  used the **Value** column and there's no trailing whitespace.

---

## Part C — First test (corporate account)

Pre-requisite for sign-in to succeed: the user's Microsoft email must
**already exist** as a `users.email` in the Maugood tenant. Microsoft
authenticates; Maugood matches.

### C1. Create a Maugood user that matches your Microsoft email

Two ways:

**Through the UI** (preferred): Settings → Users → Add user with
`email = your.address@yourcompany.com` and assign at least one role.

**Through the script** (CLI):

```bash
docker compose exec -e MAUGOOD_SEED_PASSWORD='ChangeMe@2026' backend \
  python -m scripts.seed_admin \
  --email your.address@yourcompany.com \
  --full-name "Your Name"
```

The password is irrelevant for OIDC sign-in (you never use it), but
it's mandatory for the script. The user can later set a real password
if you want a break-glass local login.

### C2. Sign in

1. Open `http://localhost:8000` (or your prod URL) in an **incognito
   window** to avoid stale cookies.
2. On the login page, enter the **tenant slug** (e.g. `inaisys`).
3. The page should now show the **"Sign in with Microsoft"** button.
   If it doesn't, see "Common errors" below.
4. Click it.
5. Microsoft consent screen appears. Click **Accept**.
6. You should land on Maugood's `/dashboard` page, signed in as
   your Microsoft identity.

### C3. Verify in the audit log

```sql
SELECT created_at, action, after->>'email' AS email,
       after->>'ip' AS ip, after->>'session_id' AS sid
FROM audit_log
WHERE action LIKE 'auth.oidc%'
ORDER BY created_at DESC
LIMIT 5;
```

You should see one `auth.oidc.login.success` row carrying your email.

---

## Part D — Localhost testing details

A few things specifically about running this on `http://localhost`:

### D1. HTTP is OK on localhost

Azure App Registrations allow `http://localhost` redirect URIs without
HTTPS — this is the one exception to Azure's "redirect URIs must be
HTTPS" rule. You don't need a TLS cert for dev.

For any other hostname (even `http://127.0.0.1`), Azure will refuse to
redirect.

### D2. Maugood's production-config guard does NOT fire on localhost

`maugood/security.py:90-94` checks that
`MAUGOOD_OIDC_REDIRECT_BASE_URL` starts with `https://` — but **only
when** `MAUGOOD_ENV=production`. With `MAUGOOD_ENV=dev` (the default in
`.env`), http://localhost is accepted. Don't accidentally set
`MAUGOOD_ENV=production` in a dev `.env` or app boot will fail.

### D3. The state cookie path

After a successful login, the state-cookie is deleted (`oidc.py:802`).
If you're testing repeatedly in the same browser session and seeing
strange "missing oidc state cookie" 400s, clear cookies for
`localhost` — sometimes the dev server caches a stale one.

### D4. Multiple developers, one Azure App

Several developers can share one App Registration during dev as long
as they all run on `http://localhost:8000`. The redirect URI is the
same; the client secret is the same. No per-developer Azure churn.

---

## Part E — Testing with a personal Outlook.com / Hotmail account

This is the one path that needs an explicit Azure choice — by default
single-tenant apps refuse personal Microsoft accounts.

### E1. Configure the App Registration for personal accounts

In Azure (skip if you already did this in A2):

1. **Authentication** → **Supported account types** →
   **Accounts in any organizational directory (Any Microsoft Entra ID
   tenant - Multitenant) and personal Microsoft accounts (e.g.
   Skype, Xbox)**.
2. **Save.**

### E2. Set Maugood `entra_tenant_id` to `common`

In Settings → Authentication → Microsoft:

- **Entra Directory ID:** `common`
- Other fields unchanged.
- **Save.**

If Maugood's pre-save discovery probe complains, double-check that the
literal string is `common` (lower-case, no whitespace).

### E3. Add a Maugood user for your personal email

This is the bit that catches everyone:

```bash
docker compose exec -e MAUGOOD_SEED_PASSWORD='ChangeMe@2026' backend \
  python -m scripts.seed_admin \
  --email your.name@outlook.com \
  --full-name "Your Name"
```

Use the **exact** email Microsoft will send back. For Outlook.com /
Hotmail accounts that's whatever shows in your Microsoft account
profile.

### E4. Sign in

Same as Part C. On the consent screen Microsoft will say
"This application is unverified" because your personal-account-allowed
App Registration hasn't gone through publisher verification — for
testing that's fine, click through. For production-grade UX, complete
publisher verification or use corporate accounts only.

### E5. Limitations of personal accounts

- The `email` claim from Microsoft for a personal account is the
  *current* address Microsoft has for that account. If the user
  renamed their Outlook (rare but possible), the email match fails.
- Personal accounts have no group claims, no department, no manager.
  Maugood doesn't use those anyway (P6 red line — no claim-driven
  roles), but it's worth knowing if you ever change that policy.
- Personal account tokens omit some claims that org accounts always
  have (`tid`, `oid`). Maugood's validator handles this — it only
  requires the standard `iss`/`aud`/`nonce`/`email|preferred_username`
  claims.

---

## Part F — How user-matching works (and what to do if it doesn't)

The matching algorithm in `oidc.py:701-746`:

1. Microsoft returns an ID token containing claims.
2. Maugood extracts `email` (falling back to `preferred_username` if
   `email` is absent — see A6 for why).
3. The value is lower-cased.
4. Maugood runs `SELECT … FROM users WHERE tenant_id = :tenant AND
   email = :lower_case_email AND is_active = true`.
5. **Match → create a session**, same shape as local login.
6. **No match or inactive user → 403** with the exact message:
   `"Your Microsoft account is not registered in Maugood. Contact
   your administrator."`

There is no auto-provision step. There is no fuzzy match. The email
must be byte-equal after lowercasing.

### If matching fails repeatedly

Check the audit log:

```sql
SELECT created_at, after->>'reason', after->>'email_attempted'
FROM audit_log
WHERE action = 'auth.oidc.login.failure'
ORDER BY created_at DESC LIMIT 10;
```

The `email_attempted` is the lower-cased value Maugood tried. Compare
that to the `users.email` value (which is also stored as `citext`, so
case-insensitive). If they look identical but the match still fails:

- Check for trailing whitespace:
  `SELECT email, length(email), encode(email::bytea, 'hex') FROM users
  WHERE email ILIKE 'your.name@outlook.com%';`
- Check `is_active`: the row must have `is_active=true`.
- Check `tenant_id`: the user must belong to the tenant they're
  logging into.

### Linking Microsoft sign-in to existing employees

There's no separate "Microsoft account linked" flag on the user row.
The link is the email. If you change an employee's email, the
Microsoft sign-in breaks for that employee until they have a Microsoft
account with the new email.

If you need to support employees whose Microsoft email differs from
their corporate identity in Maugood (e.g. an employee uses a personal
Outlook to sign in but their `users.email` is the company UPN), the
cleanest patch is to update `users.email` to whatever Microsoft sends.
The codebase doesn't have a mapping table for this — it's not a
common case and adding one would add complexity for low value.

---

## Part G — Common errors and fixes

### "Sign in with Microsoft" button doesn't appear on login

**Diagnosis:**

```bash
curl -s "http://localhost:8000/api/auth/oidc/status?tenant=<slug>" \
  | python3 -m json.tool
```

| Response | Cause | Fix |
| --- | --- | --- |
| `{enabled: false, has_config: false}` | Config was never saved | Re-do Part B2 |
| `{enabled: false, has_config: true}` | Config saved but disabled | Toggle Enabled = ON |
| `404 tenant not found` | The slug doesn't exist in `public.tenants` | Check spelling, check the tenant isn't suspended |

### `AADSTS50011: The redirect URI does not match`

**Cause:** Azure App Registration's Redirect URI ≠ what Maugood sent.

**Fix:** In Azure → App Registration → **Authentication** → **Redirect
URIs**. The value must be **byte-exact** to
`{MAUGOOD_OIDC_REDIRECT_BASE_URL}/api/auth/oidc/callback`.

- Trailing `/` matters
- Scheme (`http://` vs `https://`) matters
- Port (`:8000`) matters

Common mistakes:

- Production has `https://maugood.example.com` in the env but Azure
  has `http://maugood.example.com`.
- Dev has `http://localhost:8000` but Azure has `http://127.0.0.1:8000`
  — these are not the same to Azure.

### `AADSTS7000215: Invalid client secret provided`

**Cause:** The client secret expired, or you copy-pasted the wrong
field.

**Fix:**

1. Verify in Azure → App Registration → Certificates & secrets — is
   the secret's "Expires" date in the future?
2. If yes, the value is wrong. Common copy-paste mistakes:
   - You copied the **Secret ID** column instead of the **Value**
     column.
   - The Value has trailing whitespace from the clipboard.
3. Generate a new secret, replace it in Maugood, save. The pre-save
   discovery probe will tell you if the new value works (it does
   token validation as part of save).

### `AADSTS65001: User or administrator has not consented`

**Cause:** Your directory requires admin consent for all apps, but
admin consent wasn't granted in Part A5.

**Fix:** Azure → App Registration → API permissions → **Grant admin
consent for {directory}**. Need at least Cloud Application
Administrator role to do this.

### `403 — Your Microsoft account is not registered in Maugood`

**Cause:** Authentication succeeded but Maugood's email match failed.

**Fix:** See "If matching fails repeatedly" in Part F. The most common
single cause is a typo in the Maugood `users.email` row.

### `400 oidc state mismatch` or `400 invalid or expired oidc state`

**Causes:**

- Browser blocked the state cookie (e.g. third-party-cookie blocker on
  localhost).
- User waited >10 minutes on the consent screen and the cookie
  expired.
- User opened the consent screen in one browser, finished in another.

**Fix:** Clear cookies for the Maugood host, restart the sign-in flow.

### Maugood logs show `502 entra discovery failed`

**Cause:** Maugood couldn't reach
`https://login.microsoftonline.com/{tenant_id}/v2.0/.well-known/openid-configuration`.

**Fix:**

- Check Maugood backend can reach the public internet (corporate
  proxies often block).
- Check `entra_tenant_id` is spelled correctly. The most-common
  mis-paste is using the **Maugood tenant slug** instead of the **Entra
  Directory ID**. They are different concepts (see "Two senses of
  tenant" in `backend/CLAUDE.md`).

### Browser shows "this site can't be reached" after Microsoft consent

**Cause:** The redirect URI in Azure points at a host the user can't
reach (e.g. `https://maugood.staging.internal` from a public IP), or
the Maugood backend isn't running on that URL.

**Fix:**

- Confirm Maugood is up: `curl <redirect_base_url>/api/health`.
- Confirm the user's network can reach that URL (try from the same
  machine the user is on, not from your dev workstation).

---

## Part H — Production deployment differences

If everything in Parts A–G works on `http://localhost:8000`, here's
what changes for prod:

### H1. New Redirect URI in Azure

Add a second Redirect URI to the same App Registration:

`https://maugood.your-domain.com/api/auth/oidc/callback`

(Don't delete the localhost one; it lets you keep using the same App
for dev.)

### H2. New env vars in prod

```bash
MAUGOOD_ENV=production
MAUGOOD_OIDC_REDIRECT_BASE_URL=https://maugood.your-domain.com
# MAUGOOD_AUTH_FERNET_KEY — same generation method; must NOT be the
# dev value
MAUGOOD_AUTH_FERNET_KEY=<fresh prod key>
```

When `MAUGOOD_ENV=production`, `maugood/security.py:check_production_config`
fails fast at boot if any of these is missing or insecure:

- `MAUGOOD_OIDC_REDIRECT_BASE_URL` doesn't start with `https://`
- `MAUGOOD_AUTH_FERNET_KEY` is the dev placeholder
- HTTPS isn't enforced (cookie-secure off, behind-proxy off, etc.)

So you can't accidentally ship a prod deployment with dev OIDC config.

### H3. Re-paste the OIDC config in the production Maugood

The `tenant_oidc_config` row is per-tenant and lives in the prod
Postgres. It does NOT migrate from dev. You'll need to:

1. Sign in to prod Maugood as Admin (with the local fallback
   password).
2. Settings → Authentication → Microsoft.
3. Paste the **same** Entra Directory ID, Client ID, and Client
   Secret as dev (assuming you're reusing the same App Registration).
4. Save. Verify via `/api/auth/oidc/status` as in B2.

### H4. Calendar the secret rotation

The client secret expires in 12 months. Calendar a reminder for ~11
months out:

1. Azure → App Registration → Certificates & secrets → New secret
   (don't delete the old one yet).
2. Paste the new secret value into Maugood. Save.
3. Verify by signing in with a Microsoft account.
4. Delete the old secret from Azure.

This is zero-downtime: the new secret takes effect on the next save,
the old one stays valid until you delete it.

### H5. Audit-log monitoring

Set up a recurring query (Grafana dashboard, alert, weekly report):

```sql
SELECT date_trunc('hour', created_at) AS hour,
       action,
       after->>'reason' AS reason,
       count(*) AS n
FROM audit_log
WHERE action LIKE 'auth.oidc%'
  AND created_at > now() - interval '24 hours'
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 4 DESC;
```

A healthy day: lots of `auth.oidc.login.success`, occasional
`no_user_match` (new hires before their Maugood row is created), zero
of everything else.

Steady `id_token_invalid` or `token_exchange_failed` means the App
Registration is broken — fix immediately.

---

## Going-live checklist

Before flipping OIDC on for real users in production:

- [ ] `MAUGOOD_OIDC_REDIRECT_BASE_URL` starts with `https://`.
- [ ] `MAUGOOD_AUTH_FERNET_KEY` is set in prod, distinct from
      `MAUGOOD_FERNET_KEY`, and not the dev default.
- [ ] Azure App Registration's Redirect URI matches the prod URL
      character-for-character (including trailing slash, port,
      scheme).
- [ ] App Registration's Branding has a real logo and publisher
      domain — reduces phishing-suspicion drop-off.
- [ ] Admin consent granted for `openid` / `email` / `profile` in
      Azure (or your directory allows user consent for these
      permissions).
- [ ] At least one HR user has a non-Entra password set so a
      break-glass local sign-in is possible if Entra is unreachable.
- [ ] Calendar reminder set for the Azure client secret expiry.
- [ ] `audit_log` retention policy (P25) covers the `auth.oidc.*`
      actions.
- [ ] Tested with: at least one corporate account, at least one
      account whose email differs from their UPN (if any).
- [ ] Documented in the operator runbook where the "Sign in with
      Microsoft" button is, who to contact when it breaks, and
      where the audit log lives.

---

## Cross-reference

- `docs/microsoft-integration-guide.md` — architecture + Graph Mail
  setup. Read for "why" decisions.
- `backend/maugood/auth/oidc.py` — the full flow in one file. Start
  at line 493 (`oidc_login`) to read top-to-bottom.
- `backend/maugood/security.py:check_production_config` — the
  production-mode guard that prevents dev OIDC config leaking into
  prod.
- `backend/tests/test_oidc.py` — CI coverage; useful as
  copy-paste-able examples of every endpoint's expected behaviour.
- `frontend/src/auth/LoginPage.tsx` — where the "Sign in with
  Microsoft" button is rendered.
