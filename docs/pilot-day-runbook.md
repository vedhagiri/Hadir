# Pilot day runbook — Omran on-site

**You** = Suresh / MTS engineer running the day. **Sponsor** = the named
Omran HR/IT contact who will sign the acceptance form. **Host** =
Omran's Ubuntu 22.04 LTS pilot box.

This runbook is the on-site companion to `docs/pilot-deployment.md`.
The deployment doc explains *why*; this doc gives you the *order*.
Time estimates assume ~5 cameras and ~100 employees — scale up if
Omran has more.

---

## T-24h — the night before

**Bring with you**

- [ ] Laptop with this repo cloned, on the P13 commit or later, with `docker compose up` proven green on the way home from work
- [ ] Sealed envelope: a chosen seed-admin password for the named HR contact (do **not** email it ahead)
- [ ] USB stick *only if* Omran wants offline transfer of photos; otherwise plan to receive the photos via SCP on-site
- [ ] Printed `docs/pilot-acceptance-checklist.md` — two copies (one for the sponsor, one for our records)
- [ ] `docs/pilot-signoff.md` open in an editor on the laptop, ready to fill in
- [ ] BRD `Maugood_v1.0_BRD.docx` on the laptop in case the sponsor wants to refer to §15.1 live
- [ ] PROJECT_CONTEXT.md §8 (deferred list) printed — the sponsor signs an acknowledgement of this list

**Pre-flight on the laptop (smoke before you leave)**

```bash
# 1. tracker + engine + endpoint tests
docker compose exec backend pytest -q

# 2. employees + photos + capture demo data
docker compose exec backend python -m scripts.p10_smoke
docker compose exec backend python -m scripts.p12_smoke

# 3. Playwright end-to-end
cd frontend && npm run smoke
```

If any of those fail, **do not go on-site**. Fix first.

**Confirm with Omran ahead of time**

- [ ] Ubuntu 22.04 host with sudo access, ~50 GB free, internet egress (for the one-time InsightFace model download — ~250 MB)
- [ ] List of cameras with RTSP URLs (or that Omran IT will hand them over on-site, with credentials known)
- [ ] Employee Excel ready in the agreed schema (`employee_code, full_name, email, department_code`)
- [ ] Reference photo set following the `OM0097.jpg` / `OM0097_front.jpg` / `_left.jpg` / `_right.jpg` convention
- [ ] Sponsor + IT contact + at least one HR observer scheduled to be in the same room for the walkthrough
- [ ] Power, desks, network drop. Yes — write it down.

---

## T+0:00 → 0:15 · Provision the host

```bash
# On the Omran host:
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin git

sudo usermod -aG docker $USER
# Log out + back in so the docker group takes effect.

git clone <your repo URL> ~/maugood
cd ~/maugood
git checkout 0efc0bc        # P13 commit (or whichever you froze on)
```

Verify:

```bash
docker --version
docker compose version
git log --oneline -1
```

---

## T+0:15 → 0:25 · Bootstrap secrets

```bash
./scripts/omran_bootstrap.sh
```

The script:

1. Refuses to run if `.env` already exists.
2. Generates a fresh `MAUGOOD_FERNET_KEY`, `MAUGOOD_SESSION_SECRET`, and DB
   passwords using only Python 3 stdlib (no extra deps).
3. Writes `.env` (mode 600) with `MAUGOOD_ENV=production` so the dev-only
   `/api/_test/*` endpoints will **not** mount.
4. **Prints the secrets exactly once.** Paste them into Omran's secret
   manager *before* pressing Enter.
5. Prompts before bringing up the stack.

> **Red line.** `MAUGOOD_FERNET_KEY` is the single key for every at-rest
> encrypted artifact (face crops, capture crops, RTSP URLs, embeddings).
> Lose it and every stored byte becomes garbage. Get it into Omran's
> secret manager **before** you continue.

---

## T+0:25 → 0:35 · Bring up the stack

If the bootstrap script's "Bring up the stack now?" prompt was answered
**y**, this is already done. Otherwise:

```bash
docker compose up -d --build
docker compose logs -f backend   # watch until you see 'Application startup complete'
```

Verify:

```bash
curl -sS http://localhost:8000/api/health
# → {"status":"ok"}

docker compose ps
# → all three services Up; postgres healthy
```

`MAUGOOD_ENV=production` so the backend logs will NOT print the
`DEV-ONLY /api/_test endpoints mounted` line. If you see that line,
you're in dev mode — stop and check `.env`.

---

## T+0:35 → 0:40 · Seed the first Admin

Use the named HR contact's email and the sealed-envelope password.
**Never** seed a shared `admin@…` account.

```bash
docker compose exec -e MAUGOOD_SEED_PASSWORD='<from-envelope>' backend \
  python -m scripts.seed_admin \
    --email <hr-contact@omran.example> \
    --full-name '<HR contact full name>'
```

Confirm:

- [ ] Backend log shows `Seeded Admin user: id=… email=<contact> tenant_id=1`
- [ ] No password appears anywhere in `docker compose logs backend`
- [ ] You can log in at `http://<host>:5173` with the contact's email

---

## T+0:40 → 1:10 · Cameras

For each camera Omran provides:

1. **Cameras → Add camera**
2. Fill name + location + RTSP URL + Enabled.
3. Click **Save**.
4. Click **Preview** — confirm a frame returns (≤ 5 s).
5. Visit **System** — confirm `capture_workers_running` ticked up by 1.

Confirm with Omran IT:

- [ ] Every camera they intend to use is listed
- [ ] Every preview shows a real frame (no black, no timeout)
- [ ] System page shows `Cameras online == enabled count`

Note any camera that won't open. If it's a credential issue, fix the URL
on the Edit drawer (the `***` placeholder leaves the existing cipher
intact — type the new URL only when you actually have a new one).

---

## T+1:10 → 1:30 · Import employees

Receive Omran's `.xlsx` (file transfer of your choice — SCP, USB,
shared folder).

1. **Employees → Import**.
2. Drag-drop the `.xlsx`.
3. Read the per-row results. Common errors:
   - Unknown `department_code` → ask Omran HR which seeded department
     they meant (ENG / OPS / ADM), or add the missing one before
     re-importing.
   - Duplicate `employee_code` within the file → ask HR to dedupe.
4. Run the import again with corrections until `errors = 0`.

Confirm with Omran HR:

- [ ] List row count matches Omran's roster
- [ ] Each row's department is what HR expects
- [ ] No employee accidentally landed in the wrong dept

---

## T+1:30 → 1:50 · Bulk upload photos

Receive Omran's photo folder. Filenames must match
`<employee_code>[ _<angle> ].jpg|jpeg|png` per PROJECT_CONTEXT §3.

```bash
# From the host, with the photo folder available locally:
curl --cookie /tmp/cookies.txt --cookie-jar /tmp/cookies.txt \
  -X POST http://localhost:8000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"<contact>","password":"<...>"}'

curl --cookie /tmp/cookies.txt -X POST \
  http://localhost:8000/api/employees/photos/bulk \
  $(for f in /path/to/photos/*; do printf -- "-F files=@%s " "$f"; done)
```

Or, simpler, do it through the UI's Employees → row → drawer drop zone
for one or two as a smoke and the bulk endpoint for the rest. The bulk
endpoint enrols each photo synchronously, so the matcher cache picks
them up immediately.

Confirm:

- [ ] Bulk response shows `accepted = N`, `rejected = 0` (or expected
      mismatches you've already discussed with HR)
- [ ] Employees page shows accurate `Photos` counts on each row
- [ ] System page → `Enrolled employees` ≈ active employee count

---

## T+1:50 → 2:10 · Reembed

Even though uploads enrol synchronously, run the explicit reembed once
to confirm every embedding is fresh and the matcher cache reflects the
final photo set.

```bash
curl --cookie /tmp/cookies.txt -X POST \
  http://localhost:8000/api/identification/reembed
# → {"enrolled": N, "skipped": 0, "errors": 0}
```

If `skipped > 0`, those employees have a photo without a detectable
face. Ask HR for a clearer reference shot before going further.

---

## T+2:10 → 3:10 · Observation hour

This is the headline part of the demo. Stand near a camera for a
moment, then walk through the office with the sponsor.

Watch in the browser:

- **Camera Logs** — events should appear within ~1 s of someone walking
  through frame, identified rows mixed with the occasional Unidentified
  pill (the threshold is hard).
- **Daily Attendance** — every 15 minutes the row for someone who's
  been seen flips from Absent → Present with the right `in_time`.
- **System** — `Events today` and `capture_workers_running` should be
  steady; `frames_last_minute` per camera should be ~120–240 (4 fps ×
  60 s).

What to note privately:

- [ ] Any camera that drops out (System page → not reachable)
- [ ] Any consistent false-negative for a known employee
- [ ] Any false-positive (one employee being matched as another) — this
      is rare with `MAUGOOD_MATCH_THRESHOLD=0.45` but if it happens, log
      who → who, and propose to bump the threshold and reembed
      post-pilot

If the office is empty (lunch hour, weekend, etc.), walk past the
camera yourself a few times — you should still appear identified
because you were enrolled in step T+1:30.

---

## T+3:10 → 4:00 · Sponsor walkthrough

Bring out the printed `docs/pilot-acceptance-checklist.md`. Walk it
with the sponsor present, ticking items as you demonstrate each one
live in the UI.

The seven functional items:

1. Excel import + photo ingestion
2. Background capture on all enabled cameras
3. Face identification producing events with employee IDs
4. Fixed policy 07:30–15:30 flagging in/out/late/early correctly
5. Daily Attendance, Camera Logs, Audit Log, System pages all render
   with live data
6. On-demand Excel export (Reports page → Generate Excel → open the
   file in front of the sponsor)
7. UI matches the Maugood design system (English, light mode)

Then the **deferred-list acknowledgement**: read PROJECT_CONTEXT §8
out loud (or hand the printed copy over) and have the sponsor sign
that they understand those items are **expected in v1.0, not pilot**.

> **Red line.** Do not promise *any* item from §8 for the current
> deployment. Do not let "could it just do approval workflow as well?"
> become a verbal commitment. v1.0 is its own statement of work.

---

## T+4:00 → 4:30 · File the sign-off

1. Take a photo of the signed checklist with the sponsor and any
   observers visible. Save under `docs/pilot-signoff-photos/` (do not
   commit photos that show faces of non-employees; commit only if HR
   approves).
2. Open `docs/pilot-signoff.md` and fill in:
   - Date, time (Asia/Muscat), location
   - Sponsor name + role + signature confirmation
   - Other attendees
   - Each acceptance-checklist row's outcome
   - The deferred-list acknowledgement reference
   - Open items raised on the day (camera replacements, photo gaps,
     network rules, etc.)
   - Git commit you deployed (`git rev-parse --short HEAD` — should be
     `0efc0bc` or your frozen P13 commit)
3. Flip the status line at the top from `STATUS: not yet delivered` to
   `STATUS: delivered`.

Then commit:

```bash
git add docs/pilot-signoff.md docs/pilot-signoff-photos/
git commit -m 'feat(P14): omran pilot deployment + signoff'
```

(See `pilot-plan.md §"After the pilot"` for what happens to this file
once v1.0 starts.)

---

## T+4:30 → 5:00 · Hand-off

Walk Omran IT through:

- [ ] How to `docker compose down` (stops; data persists) vs `down -v`
      (wipes — don't use casually)
- [ ] Where the Fernet key lives in their secret manager
- [ ] The two scripts they may need: `scripts/seed_admin.py` (for
      additional users) and `docker compose logs backend` (for
      troubleshooting)
- [ ] Emergency contact at MTS for v1.0 questions
- [ ] Schedule the v1.0 kickoff before you leave the room

---

## If something goes wrong

`pilot-plan.md §"Contingency"` is the authoritative fallback list.
Short version:

- Camera flaky → demo against your laptop's pre-recorded walk-through.
  Better than a flaky live demo.
- Network locked down → pre-pull Docker images on the laptop, copy via
  USB to the host (`docker save | docker load`).
- InsightFace download blocked → bring the `~/.insightface/models/buffalo_l`
  folder from your laptop on the USB stick and `docker cp` it into the
  `insightface_models` volume before bringing up the stack.
- Sign-off blocked → do not announce the pilot delivered. Schedule a
  follow-up. The `STATUS: not yet delivered` line in
  `docs/pilot-signoff.md` stays.

---

## What "done" looks like

- [ ] Stack is up on the Omran host with `MAUGOOD_ENV=production`
- [ ] Cameras configured + previews verified
- [ ] Employees imported + photos enrolled + reembed run
- [ ] One hour of real-world identifications observed
- [ ] Sponsor signed the printed acceptance checklist
- [ ] Sponsor signed the deferred-list acknowledgement
- [ ] `docs/pilot-signoff.md` filled in and committed as `feat(P14)`
- [ ] CLAUDE.md status flipped to "pilot delivered"

If any one of those is missing, the pilot is **not** delivered. Don't
let scheduling pressure flip the line ahead of the work.
