# Maugood — Client Machine Install Guide

A step-by-step playbook for setting up Maugood on a client's
on-premises machine. Reusable for every customer install — keep
the placeholders in §3 and §6 honest and the rest stays the same.

> **Target hardware**: Ubuntu 24.04 LTS Desktop, 8 CPU cores,
> 16 GB RAM, ≥ 100 GB SSD/NVMe free. This sizing comfortably
> handles 5-8 active cameras with mixed foot traffic, the
> Postgres database, the encrypted face-crop store, scheduled
> reports, and the optional Prometheus + Grafana observability
> stack.
>
> Different OS or hardware? See the
> [§13 Hardware sizing notes](#13-hardware-sizing-notes) and the
> deeper [`deploy-production.md`](deploy-production.md) for the
> server-flavour runbook.

---

## 0. Before you begin

Walk through this checklist with the customer's IT contact
before you touch the machine:

- [ ] **Hostname** the app will be served on
      (e.g. `attendance.acme.local` for LAN-only,
      `attendance.acme.com` for public). DNS/A-record or
      `/etc/hosts` entry must resolve to this machine's IP from
      every browser that will use it.
- [ ] **TLS certificate + private key** for that hostname.
      Self-signed is fine for LAN-only pilots; a CA-signed cert
      is required for any public install. Both files in PEM
      format (`fullchain.pem` + `privkey.pem`).
- [ ] **Network**: the cameras' RTSP streams reachable from this
      machine on the LAN (port 554 by default, sometimes 8554).
      Test with VLC or `ffprobe` from the operator laptop first
      so you're not chasing camera firmware on install day.
- [ ] **Admin user**: an Ubuntu account with `sudo` privileges
      that the operator will use day-to-day. **Don't** install
      under `root` directly.
- [ ] **Branding artefacts**: customer's logo (PNG, transparent
      background) for the sidebar, plus the customer's display
      name (e.g. "Acme Corp").
- [ ] **First Admin's email + name** for the Maugood Admin
      account that will be created at provisioning.
- [ ] **Customer's tenant slug**: a short, lowercase identifier
      used in URLs and login (e.g. `acme`). Must match
      `^[a-z][a-z0-9_-]{1,39}$`.

---

## 1. System update + base packages

Open the **Terminal** app on the desktop (`Ctrl+Alt+T`) and run:

```sh
sudo apt update
sudo apt full-upgrade -y
sudo apt install -y \
    ca-certificates curl gnupg git ufw \
    unattended-upgrades
```

Reboot if the upgrade pulled a new kernel:

```sh
sudo systemctl reboot
```

`unattended-upgrades` keeps the kernel + apt packages patched
weekly. The Docker images are upgraded separately via §11.

---

## 2. Firewall (UFW)

Ubuntu Desktop ships UFW disabled. Enable it with the minimum
ports the stack needs:

```sh
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp                  # SSH (drop if unused)
sudo ufw allow 80/tcp                  # nginx HTTP redirect
sudo ufw allow 443/tcp                 # nginx HTTPS — the app
sudo ufw allow from 192.168.0.0/16 to any port 3000 proto tcp \
                                       comment 'Grafana — LAN only (optional)'
sudo ufw enable
sudo ufw status verbose
```

> Adjust the `192.168.0.0/16` range to the customer's actual
> office subnet. **Do NOT** open 3000 to the internet — Grafana
> is for the operator only.

---

## 3. Install Docker Engine + Compose plugin

Ubuntu 24.04's distro `docker.io` is too old. Install from
Docker's official repo:

```sh
# Add Docker's official GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Add the repo (24.04 = noble)
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu noble stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y \
    docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin

# Let your operator user run `docker` without sudo
sudo usermod -aG docker $USER

# Re-login for group membership to take effect, OR:
newgrp docker

# Verify
docker --version
docker compose version
docker run --rm hello-world
```

If `hello-world` prints the welcome message, Docker is good.

---

## 4. Clone the project

```sh
sudo mkdir -p /opt/maugood
sudo chown $USER:$USER /opt/maugood
git clone <REPO_URL> /opt/maugood
cd /opt/maugood
git checkout main          # or the latest release tag
```

Replace `<REPO_URL>` with the customer-authorised git remote.
For air-gapped sites, copy a pre-cloned tarball onto the machine
and `tar -xzf` into `/opt/maugood` instead.

> Every command from here uses `/opt/maugood` as the working
> directory.

---

## 5. Generate secrets

The backend refuses to boot in production with placeholder
secrets. Generate seven values from the desktop's stdlib
Python — no `pip install` needed:

```sh
cd /opt/maugood
python3 -c "import secrets; print(secrets.token_urlsafe(48))"                                                # MAUGOOD_SESSION_SECRET
python3 -c "import base64,secrets; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())"        # MAUGOOD_FERNET_KEY
python3 -c "import base64,secrets; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())"        # MAUGOOD_AUTH_FERNET_KEY
python3 -c "import secrets; print(secrets.token_urlsafe(48))"                                                # MAUGOOD_REPORT_SIGNED_URL_SECRET
python3 -c "import secrets; print(secrets.token_urlsafe(24))"                                                # MAUGOOD_APP_DB_PASSWORD
python3 -c "import secrets; print(secrets.token_urlsafe(24))"                                                # MAUGOOD_ADMIN_DB_PASSWORD
python3 -c "import secrets; print(secrets.token_urlsafe(20))"                                                # MAUGOOD_GRAFANA_ADMIN_PASSWORD
```

> **Save every value into the customer's password manager
> immediately**. They are not recoverable. Rotating
> `MAUGOOD_FERNET_KEY` invalidates every encrypted RTSP credential
> + face crop + attachment in the database — a full re-enrolment
> is required.

---

## 6. Configure `.env`

```sh
cd /opt/maugood
cp .env.example .env
nano .env
```

Fill in the values you generated in §5 plus the customer-specific
identifiers. **Required minimum**:

```bash
# ---- Secrets (from §5) ----
MAUGOOD_SESSION_SECRET=<paste>
MAUGOOD_FERNET_KEY=<paste>
MAUGOOD_AUTH_FERNET_KEY=<paste>
MAUGOOD_REPORT_SIGNED_URL_SECRET=<paste>

# ---- Database role passwords ----
MAUGOOD_APP_DB_PASSWORD=<paste>
MAUGOOD_ADMIN_DB_PASSWORD=<paste>
MAUGOOD_DATABASE_URL=postgresql+psycopg://maugood_app:<MAUGOOD_APP_DB_PASSWORD>@postgres:5432/maugood
MAUGOOD_ADMIN_DATABASE_URL=postgresql+psycopg://maugood:<MAUGOOD_ADMIN_DB_PASSWORD>@postgres:5432/maugood

# ---- Production hardening ----
MAUGOOD_ENV=production
MAUGOOD_TENANT_MODE=multi
MAUGOOD_BEHIND_PROXY=true
MAUGOOD_SESSION_COOKIE_SECURE=true
MAUGOOD_FORWARDED_ALLOW_IPS=*
MAUGOOD_HSTS_MAX_AGE_SECONDS=31536000

# ---- Public-facing config (replace with customer hostname) ----
MAUGOOD_PUBLIC_HOSTNAME=attendance.acme.local
MAUGOOD_ALLOWED_ORIGINS=https://attendance.acme.local
MAUGOOD_OIDC_REDIRECT_BASE_URL=https://attendance.acme.local

# ---- Local timezone (camera timestamps + reports use this) ----
MAUGOOD_LOCAL_TIMEZONE=Asia/Muscat

# ---- Observability (optional) ----
MAUGOOD_GRAFANA_ADMIN_PASSWORD=<paste from §5>
MAUGOOD_GRAFANA_ROOT_URL=http://localhost:3000
```

Substitute `<MAUGOOD_APP_DB_PASSWORD>` and `<MAUGOOD_ADMIN_DB_PASSWORD>`
inline in the two `*_DATABASE_URL` lines — the value, not the
literal placeholder.

Save with `Ctrl+O`, `Enter`, `Ctrl+X`.

---

## 7. Place the TLS certificate

### 7a. CA-signed cert (recommended for any public install)

```sh
sudo mkdir -p /opt/maugood/ops/certs
sudo cp /path/to/customer-supplied/fullchain.pem /opt/maugood/ops/certs/fullchain.pem
sudo cp /path/to/customer-supplied/privkey.pem   /opt/maugood/ops/certs/privkey.pem
sudo chmod 0640 /opt/maugood/ops/certs/*.pem
```

The cert must include the full chain (server cert +
intermediates). nginx validates the pair on startup; a mismatch
crashes the container.

### 7b. Self-signed (LAN-only / pilot)

If the customer is fine with a browser warning on first visit:

```sh
sudo mkdir -p /opt/maugood/ops/certs
cd /opt/maugood/ops/certs
sudo openssl req -x509 -nodes -days 730 -newkey rsa:2048 \
    -keyout privkey.pem -out fullchain.pem \
    -subj "/CN=attendance.acme.local" \
    -addext "subjectAltName=DNS:attendance.acme.local"
sudo chmod 0640 *.pem
```

Add the customer's hostname to every browser machine's
`/etc/hosts` (or push an A-record on the customer's DNS server).

---

## 8. Branding (per-client logo + name swap)

Every install ships with the previous customer's logo in the
sidebar. Replace it before first boot:

```sh
cd /opt/maugood

# 1. Drop in the new logo (PNG, ~ 256 × 256, transparent bg ideal)
cp /path/to/customer/logo.png frontend/src/assets/omran_logo.png

# 2. Update the sidebar display name
nano frontend/src/shell/Sidebar.tsx
# Find: <div className="brand-name">Omran</div>
# Replace with: <div className="brand-name">Acme Corp</div>

# 3. Update browser tab title
nano frontend/index.html
# Find: <title>Maugood</title>
# Leave the product name as "Maugood" (or change if the customer
# wants a custom title — they'll see it in browser tabs).
```

The Vite build picks these up; the new logo is hashed into the
bundle on the first `docker compose ... build` in §9.

> **Optional**: an in-app branding system already exists for
> per-tenant accent colour + font (Settings → Branding). The
> Sidebar logo override here is a build-time global; the in-app
> system handles ongoing tweaks the customer can make themselves.

---

## 9. First boot

Build the images and bring the stack up:

```sh
cd /opt/maugood
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
    up -d --build
```

First build pulls Postgres 15, builds the backend (FastAPI +
Python deps + WeasyPrint system libs) and the frontend (Vite
production bundle + nginx serving static). On the spec'd
hardware (8C/16G), this takes 5-10 minutes.

Watch the boot:

```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
    logs -f backend
```

You should see, in order:

1. `running migrations…` followed by Alembic upgrade output.
2. `capture manager started with 0 worker(s)` (zero is correct
   — no cameras yet).
3. `Maugood backend started (env=production, tenant_mode=multi)`.
4. `Application startup complete.` from Uvicorn.

`Ctrl+C` to detach — the stack keeps running in the background.

Verify health:

```sh
curl -k https://localhost/api/health
# {"status":"ok"}
```

If you see `{"status":"ok"}`, the stack is up.

---

## 10. Provision the first tenant + Admin

`MAUGOOD_TENANT_MODE=multi` means the app is ready to host
multiple customers, but ships with zero. Create the first one:

```sh
cd /opt/maugood
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec \
    -e MAUGOOD_PROVISION_PASSWORD='ChooseAStrongPassword#1' backend \
    python -m scripts.provision_tenant \
        --slug acme \
        --name 'Acme Corp' \
        --admin-email admin@acme.example.com \
        --admin-full-name 'Jane Operator'
```

Replace:
* `--slug` with the customer's tenant slug (lowercase, see §0).
* `--name` with the display name shown in PDF letterheads + emails.
* `--admin-email` with the customer's first Admin user's email.
* `--admin-full-name` with that user's full name.
* `MAUGOOD_PROVISION_PASSWORD` with a strong password — minimum 12
  characters, mix of cases + digits + a special character.

The script:
1. Creates a Postgres schema `tenant_acme` with every per-tenant
   table.
2. Seeds 4 roles (Admin / HR / Manager / Employee), 3 default
   departments (ENG / OPS / ADM), and one Fixed shift policy
   (07:30 – 15:30).
3. Creates the first Admin account with the provided password
   (Argon2id-hashed; the plaintext is never logged).
4. Runs `alembic stamp head` so future migrations are
   schema-agnostic for this tenant.
5. Writes a `tenant.provisioned` audit row.

On any failure the schema and registry row are rolled back. If
this finishes cleanly, give the password to the customer's
Admin in person or via a separate secure channel.

---

## 11. Smoke test (browser walkthrough)

Open the customer's hostname in a browser:

```
https://attendance.acme.local/
```

1. **Login page** — the MTS logo at the top, the customer's
   tenant slug auto-detected from the hostname (or paste it
   into the slug field on the login form).
2. Sign in as `admin@acme.example.com` with the provisioning
   password.
3. **Dashboard** loads. Sidebar shows the customer's logo +
   name (from §8).
4. **Settings → Branding** — let the Admin pick an accent colour
   + font; the change applies instantly without a reload.
5. **Cameras → + Add camera** — paste a known-good RTSP URL
   (e.g. `rtsp://camuser:pass@192.168.1.42:554/cam/realmonitor?channel=1&subtype=0`),
   give it a name + location, save. Within 5 seconds the row
   should show "Reachable" + a frame count.
6. **Live Capture** — pick the camera, the live MJPEG stream
   should render with a green box around any face.
7. **Employees → + Add employee** — create one test employee
   with the operator's own face photos in 3 angles
   (front / left / right).
8. Walk past the camera. Within 5 seconds an event lands in
   **Camera Logs**, identified to the test employee.
9. Wait 15 minutes (or hit **Settings → Daily attendance →
   Recompute**). The employee's row appears under **Daily
   attendance** with the in-time set.

If every step works, the install is complete.

---

## 12. Day-2 operations

### Start / stop / restart

```sh
cd /opt/maugood
# Stop everything, persist data:
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop
# Start back up:
docker compose -f docker-compose.yml -f docker-compose.prod.yml start
# Restart just the backend (after editing .env):
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart backend
```

### View logs

```sh
# Live tail of every service:
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f
# Single service:
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f backend
```

The backend writes its own rotated log archive to
`backend/logs/app.log` + daily-gzipped backups (30 day retention).

### Backups

The stack ships with a built-in `backup` service that runs
nightly at 02:00 local time. Manual run:

```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
    /scripts/backup.sh
```

Output lands in `/opt/maugood/backups/` (Postgres dump per
schema + tarballed face crops + a SHA-256 manifest). For the
disaster-recovery procedure see
[`disaster-recovery.md`](disaster-recovery.md).

> **Off-site copy**: configure `MAUGOOD_BACKUP_S3_URI` in `.env`
> and rebuild the `backup` image with `INCLUDE_AWS_CLI=1` to
> push every backup to an S3-compatible store. Default is
> on-disk only — the customer must arrange external backup
> if the desktop ever fails physically.

### Updating to a new release

```sh
cd /opt/maugood
git fetch && git checkout <new-tag>
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
    up -d --build
```

Migrations apply automatically on backend boot. **Take a backup
first** (above) — schema migrations are forward-only.

### Provision a second tenant on the same machine

`MAUGOOD_TENANT_MODE=multi` already supports it. Re-run §10 with
a different slug + name + Admin email. Each tenant gets an
isolated Postgres schema; data is invisible across tenants.

---

## 13. Hardware sizing notes

The 8-core / 16-GB target accommodates:

| Workload                         | Footprint                          |
| -------------------------------- | ---------------------------------- |
| Postgres 15                      | ~1 GB resident, ~10 GB on disk per year per active tenant (incl. detection events table) |
| Backend (FastAPI + scheduler)    | ~400 MB resident                   |
| Frontend (nginx + static bundle) | ~50 MB resident                    |
| Capture worker (per camera)      | ~100 MB resident; ~10–20% of one CPU core when active |
| Face crop store on disk          | ~5 KB per detection event; ~50 MB per active camera per month |
| Optional: Prometheus + Grafana   | ~500 MB resident combined          |

Comfort zone on the spec'd machine:

* **5–8 cameras** at typical office foot traffic
* **100–500 employees** enrolled
* **5 GB face crop growth per month** with 8 cameras

If the customer needs **more cameras** or significantly higher
foot traffic, scale up the host CPU first (the
detection bottleneck is the per-frame InsightFace inference,
serialised by a global lock to avoid L1/L2 cache thrash).
SSD latency matters for both Postgres and the encrypted-crop
write path — a slow spinning disk will manifest as growing
backlog in the capture worker logs.

---

## 14. Troubleshooting

### `docker compose up` fails with `must be set in production`

`MAUGOOD_ENV=production` means every secret and hostname must be
set in `.env`. The error names the missing variable. Re-check
§6 — the most common omission is `MAUGOOD_GRAFANA_ADMIN_PASSWORD`
or one of the `*_DATABASE_URL` lines (where the password
substitution wasn't done).

### Backend container exits immediately

```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
    logs --tail=100 backend
```

Read the bottom of the log. Common causes:

* **Migration failure** — usually a hand-edit broke the schema.
  Restore from the most recent backup (§12).
* **Bad `MAUGOOD_FERNET_KEY`** — the key must be exactly 32 bytes
  base64-URL-safe (44 characters ending in `=`). Re-generate
  per §5.
* **Database password mismatch** — `MAUGOOD_APP_DB_PASSWORD` and
  the password embedded in `MAUGOOD_DATABASE_URL` must match
  byte-for-byte.

### nginx exits with `SSL_CTX_use_PrivateKey_file`

The cert and key in `ops/certs/` don't pair. Re-issue or
re-extract them and check:

```sh
openssl x509 -noout -modulus -in ops/certs/fullchain.pem | openssl md5
openssl rsa  -noout -modulus -in ops/certs/privkey.pem  | openssl md5
# Both hashes must match.
```

### Camera shows "Unreachable"

```sh
# From inside the backend container — same network as the camera:
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
    exec backend ffprobe -timeout 5000000 \
    "rtsp://camuser:pass@192.168.1.42:554/<path>"
```

If `ffprobe` fails too, it's a camera/network problem — confirm
firmware version + RTSP path with the camera vendor. The
backend's RTSP scheme allowlist accepts `rtsp` and `rtsps`
only (no `http` substream proxies — that's a security gate
from P27).

### Browser refuses self-signed cert

Click through the warning ("Advanced → Proceed to …"). Or
import the cert into the customer's machines:

```sh
# On a Linux client:
sudo cp fullchain.pem /usr/local/share/ca-certificates/maugood.crt
sudo update-ca-certificates
```

Windows + macOS clients use their own keychain UI.

### "No employee linked to this account"

This is correct: an Admin/HR user account doesn't automatically
become an Employee row. Add yourself via Employees → + Add
employee using the same email as your login.

---

## 15. Acceptance handoff

Before signing off with the customer:

- [ ] Production stack is running (§9 health check passes).
- [ ] Customer Admin can log in over HTTPS with the
      hostname-based URL.
- [ ] At least one camera is online + identifying.
- [ ] At least one employee is enrolled with photos.
- [ ] One full end-to-end attendance day has rolled over (or
      the operator has triggered the recompute manually and
      seen a row).
- [ ] Backup ran at least once (manual run is fine for sign-off
      day; the cron will pick up after that).
- [ ] All seven secrets from §5 are stored in the customer's
      password manager.
- [ ] The customer has the operator's contact for support and
      the Maugood Admin password is delivered separately.

For the deeper production-runbook concerns (Let's Encrypt
automation, off-site backups, observability stack, security
review, DR rehearsal), point the customer at:

* [`deploy-production.md`](deploy-production.md) — server-grade
  install with Let's Encrypt + multi-host considerations.
* [`disaster-recovery.md`](disaster-recovery.md) — RTO / RPO
  targets + restore playbook.
* [`observability.md`](observability.md) — Prometheus + Grafana
  + alerting wiring.
* [`security-review.md`](security-review.md) — the M3-gate
  audit results.
* [`data-retention.md`](data-retention.md) — what gets cleaned
  up automatically and what survives forever.
