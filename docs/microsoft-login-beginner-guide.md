# Microsoft Account Login — Beginner Guide

> **Who this is for:** You've never used Azure or Microsoft Entra ID
> before. You want "Sign in with Microsoft" to work in Maugood, but
> the official Microsoft documentation feels like it's written for
> people who already know the jargon.
>
> **What this is:** A plain-English walkthrough from zero — from
> "I don't even have a Microsoft account" to "I just signed in to
> Maugood with my Microsoft account."
>
> **The companion docs** (read after this one, or when you hit a wall):
> - `docs/microsoft-login-setup.md` — denser step-by-step setup notes,
>   troubleshooting reference for 8 common errors.
> - `docs/microsoft-integration-guide.md` — architecture details,
>   why each design choice was made, Graph Mail (for sending email
>   on Maugood's behalf — separate from sign-in).
> - `backend/maugood/auth/oidc.py` — the actual code that does the work.

---

## Part 0 — What you're actually doing (the 30-second mental model)

When a user clicks **"Sign in with Microsoft"** in Maugood:

1. Maugood bounces the browser to `login.microsoftonline.com`.
2. Microsoft asks the user for their Microsoft credentials
   (password, MFA, Windows Hello — whatever they have set up).
3. Microsoft bounces the browser back to Maugood with a small
   one-time **code**.
4. Maugood swaps that code for an **ID token** — a JSON blob signed
   by Microsoft that says "this user's email is xyz@example.com,
   and yes, I really verified them."
5. Maugood looks up `xyz@example.com` in its `users` table. If a
   match exists, Maugood creates its own session and the user is
   logged in. If no match exists, Maugood **rejects** the login.

The important part: **Microsoft handles the password.** Maugood
never sees it. Maugood just trusts the signed ID token and matches
the email.

For Microsoft to do this, you need to register your app with
Microsoft. That registration is called an **App Registration**.
That's what most of this guide is about.

### The five things you'll create today

| Thing | What it is | Where it comes from |
|---|---|---|
| Microsoft account | Your personal login to Azure Portal | Free signup at signup.live.com |
| Entra Directory | A "tenant" — Microsoft's name for a workspace | Auto-created when you first sign in to Azure |
| App Registration | The thing that represents Maugood to Microsoft | You create it in Azure Portal |
| Client ID | Public ID of the App Registration | Shown on the App Registration page |
| Client Secret | Password the backend uses to talk to Microsoft | You generate it on the App Registration page |

### Three "tenant" words that mean different things — don't confuse them

This trips up almost everyone:

- **Maugood tenant** — a customer of Maugood (e.g., Omran, Demo Co).
  In the URL slug like `tenant=omran`.
- **Entra tenant / Directory** — a workspace on Microsoft's side.
  Identified by a GUID like `aabbccdd-1234-5678-…`. Each Microsoft
  organisation (a company that uses Microsoft 365) has one.
- **Multi-tenant App Registration** — a switch in Azure that says
  "users from any Microsoft organisation can sign in," vs.
  "only users from MY organisation can sign in."

When this guide says "tenant," it'll always specify which one.

---

## Part 1 — Get a Microsoft account (skip if you have one)

A Microsoft account is just a free Microsoft login. If you've ever
used Outlook.com, Hotmail, Xbox, Skype, OneDrive — you already have
one.

### To create one from scratch

1. Open https://signup.live.com in a browser.
2. Either:
   - Use your existing email (Gmail, work, anything) — Microsoft
     just uses it as your login ID, no Outlook mailbox is created.
   - Or click **"Get a new email address"** to make a free
     `@outlook.com` mailbox.
3. Set a password.
4. Solve the puzzle / verify by phone.
5. You now have a Microsoft account.

> **No credit card needed** for what we're doing today. The Azure
> Portal access we need is part of the free tier — App Registrations
> cost nothing.

---

## Part 2 — Get into Azure Portal for the first time

1. Open https://portal.azure.com in a new tab.
2. Sign in with the Microsoft account from Part 1.
3. If this is your first time:
   - You may see "Welcome to Azure" — click around or dismiss.
   - You may be asked to accept terms. Accept.
   - You may be asked for a country and phone number for security.
     Provide them. (Still no card required.)
4. When you see a search bar at the top labelled "Search resources,
   services, and docs," you're in.

### A quick tour

- **Top bar:** search, notifications, settings, your profile.
- **Left rail:** a hamburger menu with services. We'll mostly use
  **Microsoft Entra ID** (formerly "Azure Active Directory").
- **Top-right of profile:** shows your current **Directory**. The
  first time you sign in with a personal account, Microsoft
  auto-creates a "Default Directory" for you. That's your free
  Entra tenant.

### Find your Directory (Entra tenant) ID — you'll need it later

1. In the top search bar, type **"Microsoft Entra ID"** and click it.
2. The page that opens shows your directory's **Overview**.
3. Find **"Tenant ID"** — it's a GUID like
   `aabbccdd-1234-5678-90ab-1234567890cd`.
4. Click the copy icon next to it. **Paste it into a note** — call
   it `ENTRA_TENANT_ID`.

> If you plan to test with personal Outlook/Hotmail accounts only
> (not a company account), you'll instead use the literal word
> `common` later — but copy this GUID anyway, it's needed if you
> ever switch to a corporate setup.

---

## Part 3 — Create the App Registration

This is the central object. It tells Microsoft: "There's an app
called Maugood. Here's where to send users after they log in.
Here's what it's allowed to ask for."

### Steps

1. Still in **Microsoft Entra ID**, click **"App registrations"** in
   the left menu of that page.
2. Click **"+ New registration"** at the top.

You'll see a form with three sections:

#### Field 1 — Name

Type: **`Maugood`**

This is purely a label for you. Users will see it on the consent
screen ("Maugood wants to sign you in"), so keep it presentable.

#### Field 2 — Supported account types

This is the most important choice. Four options:

| Option | Who can sign in | Pick this if… |
|---|---|---|
| **Single tenant** | Only users in YOUR organisation | You're a company deploying Maugood internally |
| **Multi-tenant** (any org) | Anyone from any company on Microsoft 365 | You're a SaaS vendor (multiple customer orgs) |
| **Multi-tenant + personal MS** | Above + Outlook.com / Hotmail users | You want to test with personal accounts too |
| **Personal MS only** | Only Outlook.com / Hotmail | Almost never the right choice |

**For first-time learning / localhost testing**, pick
**"Accounts in any organizational directory and personal Microsoft
accounts"** (option 3). It's the most permissive — once it works
you can tighten it later.

**For Maugood production at Omran** (a single company), the right
choice is **Single tenant** with Omran's Entra directory. But you
can come back and change this later.

#### Field 3 — Redirect URI (optional, but do it now)

This is where Microsoft will send users back after they sign in.
**It must match Maugood's callback URL exactly — character for
character.**

Set:
- **Platform:** `Web`
- **URI:** `http://localhost:8000/api/auth/oidc/callback`

> **Why `localhost`?** We're testing on your machine first.
> Microsoft makes a special exception: `http://localhost` is
> allowed even though HTTP is normally rejected. Any other host
> (even `127.0.0.1` — different spelling!) must use HTTPS.

3. Click **"Register"** at the bottom.

You'll land on the App Registration's **Overview** page.

---

## Part 4 — Capture the Client ID and Tenant ID

On the App Registration's **Overview** page you'll see a few
copy-icon fields. Two matter:

1. **Application (client) ID** — a GUID. **This is your Client ID.**
   Copy it. Call it `CLIENT_ID`.
2. **Directory (tenant) ID** — the same GUID you copied in Part 2.
   Confirm it matches. (If it doesn't, you may have multiple
   directories — make sure you're in the right one via the
   directory switcher in the top-right profile menu.)

These two are **public** — they're not secrets. They identify the
app, but they don't let anyone log in as the app.

---

## Part 5 — Generate the Client Secret

The Client Secret is a password the backend uses to prove to
Microsoft, "I really am Maugood — give me the ID token for this
sign-in." Treat it like a database password.

### Steps

1. On the App Registration page, click **"Certificates & secrets"**
   in the left menu.
2. Make sure the **"Client secrets"** tab is selected (not
   "Certificates" or "Federated credentials").
3. Click **"+ New client secret"**.
4. **Description:** anything readable, e.g., `Maugood backend
   2026-05`. Helps when you rotate later.
5. **Expires:** start with **6 months**. Microsoft no longer allows
   "never expires." Mark the expiry on your calendar so you can
   rotate before it dies.
6. Click **"Add"**.

You'll see a row appear in the table with two columns of interest:

- **Value** — the actual secret. **A long random string starting
  with letters/numbers.**
- **Secret ID** — a GUID. Not the secret.

### CRITICAL — copy the Value NOW

Microsoft shows the **Value** in full **only once**. The moment
you click away or refresh, the column will be masked forever and
your only option is to delete and recreate.

1. Click the copy icon next to **Value**.
2. Paste it into your notes. Call it `CLIENT_SECRET`.
3. Confirm it's the Value, not the Secret ID. The Secret ID is a
   short GUID; the Value is a longer random string with mixed case
   and special characters.

---

## Part 6 — Set up API Permissions

API permissions say what the app is allowed to ask Microsoft for.
For sign-in only, the defaults are almost right — we just need to
confirm.

### Steps

1. Click **"API permissions"** in the left menu.
2. You should see one permission already listed:
   - **Microsoft Graph → User.Read** — Delegated.
   - This means: "the app can read the basic profile of the user
     who just signed in."
3. **That's enough.** Sign-in only needs this plus the implicit
   `openid`, `profile`, `email` scopes — Microsoft adds those
   automatically for OpenID Connect flows.

### Why not "Grant admin consent" yet?

For personal Microsoft accounts and most basic flows, users grant
consent themselves on first sign-in ("Maugood wants to view your
profile — Accept?"). You only need the **"Grant admin consent"**
button if:

- You picked **Single tenant** AND
- Your organisation requires admin consent for all apps AND
- You don't want each user to be prompted.

If you're an Azure admin for the directory, clicking "Grant admin
consent for [Directory]" once now means no user ever sees the
consent prompt. If you're not the admin, skip it — the user will
just see a one-time prompt.

### What about Mail.Send / Calendars.Read / etc?

Those are for **what Maugood does AFTER login** (e.g., sending
email via Graph). For pure sign-in, you don't need them. The
companion `docs/microsoft-integration-guide.md` covers Graph Mail
separately.

---

## Part 7 — Understanding the OAuth / OpenID flow (the diagram)

You now have everything Microsoft's side needs. Before wiring it
into Maugood, here's what actually happens at login. Skim if you
just want it to work; read if it goes wrong later and you need to
debug.

```
┌─────────┐   1. click "Sign in with Microsoft"
│ Browser │ ──────────────────────────────────────────────►  ┌──────────┐
└─────────┘                                                  │ Maugood  │
     ▲                                                       │ backend  │
     │   2. 302 redirect to login.microsoftonline.com         └────┬─────┘
     │   (includes Client ID + redirect URI + state cookie)        │
     │                                                             │
     └─────────────────────────────────────────────────────────────┘
     │
     │   3. browser follows redirect
     ▼
┌─────────────────────┐
│ Microsoft sign-in   │  ← user types email/password, does MFA
└────────┬────────────┘
         │
         │   4. browser is redirected back to Maugood's callback URL
         │   (includes ?code=XYZ&state=ABC)
         ▼
   ┌──────────┐  5. backend verifies the state cookie matches
   │ Maugood  │  6. backend exchanges code for ID token (server-to-server
   │ backend  │     POST to Microsoft, signed with Client Secret)
   │          │  7. backend verifies ID token signature against
   │          │     Microsoft's published public keys (JWKS)
   │          │  8. backend extracts email from token
   │          │  9. backend looks up email in users table
   │          │ 10. backend creates Maugood session, sets cookie
   └──────────┘
         │
         │  11. 302 redirect to Maugood home page
         ▼
    User is in
```

**Steps that involve the Client Secret:** only step 6. The browser
never sees it — that's why we can use a long-lived secret instead
of short-lived rotating tokens.

**State cookie (step 5)** is anti-CSRF. The backend signs a random
nonce, puts it in a cookie before bouncing to Microsoft. When the
callback arrives, the `state` in the URL must match what the cookie
remembers. If someone tries to forge a callback to your URL, they
can't produce a valid state — the request is rejected.

---

## Part 8 — Wire it into Maugood (backend)

The good news: **all the OIDC code already exists** in
`backend/maugood/auth/oidc.py`. You just need to configure it.

### Step 8.1 — Set the global env vars

Edit `/home/hari-inaisys/Omran/Hadir/.env` (or `backend/.env`):

```bash
# A Fernet key for encrypting the Client Secret at rest in the database.
# This is SEPARATE from MAUGOOD_FERNET_KEY (which protects RTSP/photos).
# Generate ONCE — never rotate without re-encrypting existing secrets.
MAUGOOD_AUTH_FERNET_KEY=<paste-generated-key>

# Public-facing base URL of your backend. Microsoft's redirect URI
# is built as: {this base}/api/auth/oidc/callback
MAUGOOD_OIDC_REDIRECT_BASE_URL=http://localhost:8000
```

#### Generate the Fernet key

On a clean Ubuntu 22.04 without the cryptography Python package:

```bash
python3 -c "import base64, os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())"
```

The output is a 44-character string ending in `=`. Paste it as
`MAUGOOD_AUTH_FERNET_KEY`'s value.

### Step 8.2 — Apply the env changes

`docker compose restart backend` is NOT enough — Docker only reads
`.env` when the container is recreated. Use:

```bash
docker compose up -d backend
```

Verify the backend started:

```bash
curl http://localhost:8000/api/health
# {"status":"ok"}
```

### Step 8.3 — Save the per-tenant OIDC config

This is what makes "Sign in with Microsoft" appear on the login
page for a specific Maugood tenant. There are two ways:

#### Option A — Via the UI (recommended)

1. Sign in to Maugood as an Admin user.
2. Settings → Authentication → Microsoft → "Configure."
3. Paste:
   - **Entra Tenant ID:** `ENTRA_TENANT_ID` from Part 2.
   - **Client ID:** `CLIENT_ID` from Part 4.
   - **Client Secret:** `CLIENT_SECRET` from Part 5.
4. Toggle **Enabled = ON**.
5. Save.

The backend pings Microsoft's discovery URL before persisting. If
the values are wrong, you get an error immediately rather than at
sign-in time.

#### Option B — Via curl (if UI page isn't built yet)

```bash
# Replace TENANT with your Maugood tenant slug (e.g., "main" or "omran")
# Replace SESSION_COOKIE with a logged-in Admin's session token

curl -X PUT http://localhost:8000/api/auth/oidc/config \
  -H "Content-Type: application/json" \
  -H "Cookie: maugood_session=SESSION_COOKIE; maugood_tenant=TENANT" \
  -d '{
    "entra_tenant_id": "ENTRA_TENANT_ID",
    "client_id": "CLIENT_ID",
    "client_secret": "CLIENT_SECRET",
    "enabled": true
  }'
```

### Step 8.4 — Verify with the anonymous probe

This endpoint is what the LoginPage uses to decide whether to show
"Sign in with Microsoft":

```bash
curl "http://localhost:8000/api/auth/oidc/status?tenant=TENANT"
# {"enabled":true,"login_url":"/api/auth/oidc/login?tenant=TENANT"}
```

If `enabled: false`, the config didn't save correctly — check the
backend logs.

---

## Part 9 — Frontend wiring (already done)

`frontend/src/pages/Login/LoginPage.tsx` already calls
`/api/auth/oidc/status?tenant=…` on mount and renders the
**"Sign in with Microsoft"** button as the primary CTA when
`enabled: true`. Nothing to wire — once Part 8 saved the config,
the button appears.

If the button doesn't appear after a successful Part 8:

1. Open browser DevTools → Network.
2. Reload the login page.
3. Look at the `oidc/status` response. If it's `{"enabled":false}`,
   the config didn't take. If it's `{"enabled":true}` but no
   button, the frontend cache may be stale — hard-refresh
   (Ctrl+Shift+R).

---

## Part 10 — Create a Maugood user that matches your Microsoft email

This is the gotcha that catches everyone the first time. Maugood
**never auto-creates users** from Microsoft logins. That's a
security red line — anyone with a Microsoft account would
otherwise be able to sign in to your Maugood instance.

The Microsoft sign-in **matches on email**, lowercase-compared.

### Steps

1. Note the email of the Microsoft account you'll test with —
   e.g., `you@outlook.com` or your work `you@company.com`.
2. Sign in to Maugood with the local Admin password (the seed
   admin you created during initial setup).
3. Go to Settings → Users (or similar — wherever user management
   lives in your build).
4. Add a user with **the exact same email**, lowercase.
5. Assign at least one role (Admin / HR / Manager / Employee).
6. **Do not set a password** — Microsoft will handle that.
   (Maugood requires a placeholder, but it'll never be used as
   long as you only use Microsoft to sign in.)
7. Save.

You now have a Maugood user whose email matches your Microsoft
account.

---

## Part 11 — Sign in with Microsoft for the first time

1. **Sign out** of Maugood (or open a private/incognito window).
2. Go to the Maugood login page.
3. Click **"Sign in with Microsoft."**
4. Browser redirects to `login.microsoftonline.com`.
5. Type your Microsoft email + password.
6. If MFA is set up, complete it.
7. If this is your first time using this App Registration, you'll
   see a consent screen: **"Maugood wants to: sign you in and
   read your profile."** Click **Accept**.
8. Browser redirects back to Maugood at `/api/auth/oidc/callback`.
9. After a brief processing redirect, you land on the Maugood
   dashboard, signed in as the user from Part 10.

### Verify in the audit log

1. Go to Settings → Audit Log.
2. Look for a recent `auth.login.success` row with
   `details.method = "oidc"`.
3. The actor user ID matches the one you created in Part 10.

If you see this row, it worked.

---

## Part 12 — Localhost testing notes

- **Microsoft allows HTTP for `localhost` only.** Any other URL
  must be HTTPS. Don't try `127.0.0.1` — it's spelled differently
  and Microsoft treats it differently.
- **The redirect URI in Azure must be byte-exact.** Trailing
  slashes, capitalisation, port — all matter. Most first-time
  errors come from a mismatch here.
- **Cookies and same-site.** If you access Maugood as
  `http://localhost:5173` (Vite dev) but the backend is
  `http://localhost:8000`, the session cookie must be set with
  `SameSite=Lax`. Maugood already does this in dev.
- **Multiple developers can share one App Registration.** Just add
  each developer's localhost URL as an additional redirect URI in
  Azure. Microsoft accepts many at once.

---

## Part 13 — Token / session handling

This is mostly hidden from you — the existing code handles it —
but if you ever debug:

| Thing | Lives where | Purpose |
|---|---|---|
| **State cookie** | Browser, signed JWT, set during `/oidc/login` | Prevents CSRF on callback |
| **Authorization code** | URL parameter on callback, used once | Exchanged for ID token |
| **ID token** | Backend only, validated server-side | Proves the user's identity |
| **Maugood session cookie** | Browser, after successful match | Authenticates subsequent Maugood requests |
| **Refresh token** | **NOT USED** | Maugood doesn't refresh against Microsoft — when the Maugood session expires, the user just clicks "Sign in with Microsoft" again |

Microsoft's tokens are essentially write-once for Maugood:
- ID token is used immediately to extract the email, then discarded.
- Maugood doesn't store any Microsoft tokens.
- Maugood manages its own session lifetime independently.

---

## Part 14 — Common errors and fixes

Here's the short list. For deeper diagnosis see
`docs/microsoft-login-setup.md` Part G.

### "AADSTS50011: The reply URL specified in the request does not match the reply URLs configured for the application"

The redirect URI in Azure ≠ the URL Microsoft was asked to redirect
to. Almost always a typo.

- Azure App Registration → **Authentication** → Redirect URIs.
- Compare byte-by-byte with what Maugood is sending. The full URL
  Microsoft saw appears in the URL bar when you see this error —
  scroll right or copy-paste it.
- Watch for `http` vs `https`, trailing slash, port number.

### "AADSTS7000215: Invalid client secret provided"

Either you copied the **Secret ID** instead of the **Value**, or
the secret has expired.

- Azure → **Certificates & secrets**.
- Check the expiry. If past, create a new secret and update
  Maugood's config.
- If not expired, delete and regenerate — copy only the **Value**
  column this time.

### "AADSTS65001: The user or administrator has not consented to use the application"

Single-tenant setups where the directory requires admin consent.

- Azure → **API permissions** → "Grant admin consent for
  [Directory]" button. Click it. (You must be a Global
  Administrator in that directory.)
- Or change supported account types to multi-tenant — users will
  then be allowed to consent themselves.

### "Forbidden: this email is not registered in Maugood"

The Microsoft sign-in worked, but there's no matching user.

- Compare the email in Microsoft (visible at the top of the
  Microsoft sign-in page after login) with the `users.email` in
  Maugood. Case-insensitive but otherwise exact.
- Microsoft account email and the displayed name are different —
  make sure you're comparing emails.
- If using a corporate account, the email might be in a different
  domain than you expected (`firstname@tenantname.onmicrosoft.com`
  vs `firstname@company.com`). Use what Microsoft actually shows.

### "State mismatch / invalid state"

The state cookie didn't survive the round-trip.

- Browser blocked third-party cookies? Try a private window.
- Backend restart between `/oidc/login` and `/oidc/callback`? The
  signing key may have rotated — try again from the login page.
- Crossing protocols (HTTP → HTTPS)? Cookies don't follow. Stay
  on one.

### Backend logs say "502 / discovery failed"

Maugood couldn't reach `https://login.microsoftonline.com/.../v2.0/
.well-known/openid-configuration`.

- Check the `entra_tenant_id` value. If it's a GUID, must be the
  Directory ID. If it's `common`, also valid (for personal +
  multi-tenant). Anything else (a slug, a hostname) is wrong.
- Check the backend container has outbound internet — `docker
  compose exec backend curl -I https://login.microsoftonline.com`.

### Page just spins forever after clicking the button

Open DevTools → Network. Look for:

- A redirect to `login.microsoftonline.com` that's red /
  blocked — backend's `/oidc/login` may not be reachable.
- A 200 from `/oidc/callback` followed by no redirect — the
  callback handler raised. Check backend logs.

---

## You're done

If you reached the end of Part 11 with a successful sign-in, you
have a working Microsoft Account login for Maugood.

### Next steps

- **Tighten security:** if you're deploying for a real company,
  switch the App Registration to **Single tenant** and bind it to
  that company's Entra directory. Re-update Maugood's
  `entra_tenant_id` with their Directory ID.
- **Move to HTTPS:** for any non-localhost deployment. Update both
  the Azure redirect URI and `MAUGOOD_OIDC_REDIRECT_BASE_URL`.
- **Set up Graph Mail (separate feature):** if Maugood needs to
  send email from a Microsoft mailbox. See
  `docs/microsoft-integration-guide.md` Part 2.
- **Rotate the Client Secret before it expires:** mark the expiry
  date in your calendar. Plan to rotate ~2 weeks before — generate
  a new secret, update Maugood's config, then delete the old
  secret in Azure.

### When in doubt

- Cross-reference `docs/microsoft-login-setup.md` for the dense
  setup reference and Part G troubleshooting.
- Cross-reference `docs/microsoft-integration-guide.md` for
  architecture and "why" questions.
- Read `backend/maugood/auth/oidc.py` directly — it's only ~900
  lines and every function has a clear single responsibility.
