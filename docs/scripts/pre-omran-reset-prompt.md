# Pre-Omran Reset & Seed — Claude Code Prompt

**Purpose:** Wipe the local database, re-provision tenants from scratch, seed comprehensive dummy data, and onboard the first real corporate (with real office camera) so you can validate v1.0 end-to-end on your laptop before showing Omran.

**When to run:** After P28 sign-off, before P29 Omran cutover.

**Read these first:**
- `CLAUDE.md` (root) — confirms current state is post-P28
- `docs/testing/v1.0-m2-test-accounts.md` — the test account convention this script extends
- `v1.0-phase-plan.md` — context for what's been built

**Output files this session creates or updates:**
- `backend/scripts/pre_omran_reset.py` — the reset + seed script (new)
- `backend/scripts/_seed_data/` directory — sample employees Excel and a small set of synthetic face photos (new)
- `credentials.txt` at repo root — printable credentials, gitignored (new)
- `.gitignore` — add `credentials.txt` if missing
- `docs/testing/pre-omran-validation.md` — checklist to walk through after seed (new)

---

## The prompt to paste into Claude Code

> You are resuming work on Hadir, post-P28. The v1.0 build is complete and ready for pre-Omran validation. Read `CLAUDE.md`, `docs/testing/v1.0-m2-test-accounts.md`, and `v1.0-phase-plan.md` before doing anything.
>
> In this session, build a single re-runnable script that wipes the local database, re-provisions everything, seeds rich dummy data, and onboards a real corporate tenant. Every credential the script creates must be printed to console and saved to a gitignored `credentials.txt` so Suresh can log in and validate.
>
> **At the very top of the script, set:**
> ```python
> REAL_CORPORATE_NAME = "__CORPORATE_NAME_HERE__"  # Suresh fills this in before running
> REAL_CORPORATE_SLUG = "__CORPORATE_SLUG_HERE__"  # lowercase, hyphens, e.g. "mts-office"
> ```
> Refuse to run if either still contains the placeholder. Print a clear error: "Set REAL_CORPORATE_NAME and REAL_CORPORATE_SLUG at the top of the script before running."
>
> ---
>
> ### What the script does
>
> 1. **Safety gate.** Refuse to run unless `HADIR_ENV=dev`. Refuse to run if any tenant in the DB has more than 50 employees (production heuristic). Print: "This script wipes all data. Type 'RESET' to continue:" and require typed confirmation. These three brakes together make it impossible to run accidentally against production.
>
> 2. **Wipe.** Drop every tenant schema (anything matching `tenant_%`), drop the legacy pilot `main` schema if it exists, then drop and recreate `public`. Re-run all Alembic migrations on `public` to recreate the global `tenants` and `mts_staff` tables.
>
> 3. **Provision three tenants** (in order):
>    - `tenant_mts_demo` — synthetic test tenant. Used for safe sandbox testing and proves multi-tenancy.
>    - `<REAL_CORPORATE_SLUG>` — Suresh's real corporate. The one with the real office camera.
>    - Do NOT provision `tenant_omran` yet. Omran's tenant gets provisioned during P29 cutover with real Omran data, not dummy data. Print a clear note about this so it's not confused.
>
>    For each tenant, use the existing `provision_tenant.py` from P2: creates schema, runs migrations, seeds default roles and the default Fixed policy. Do not duplicate that logic — call it.
>
> 4. **Seed Super-Admins** in `public.mts_staff`:
>    - `superadmin@mts.test` / generated password
>    - `support@mts.test` / generated password (the second one is for testing dual-Super-Admin behaviour from P3)
>
> 5. **Seed `tenant_mts_demo` with rich dummy data** that exercises every v1.0 feature:
>    - **Departments:** Engineering, Operations, Sales, Finance, Admin (5 departments — more than the M2 test doc, to exercise multi-department managers more thoroughly)
>    - **Holidays:** seed Oman 2026 holidays — National Day (Nov 18), Renaissance Day (Jul 23), Islamic New Year, Prophet's Birthday, Eid Al-Fitr (3 days), Eid Al-Adha (4 days), plus Jan 1. Approximate Hijri-derived dates for 2026 — flag in a comment that Omran HR confirms exact dates per year.
>    - **Leave types:** Annual, Sick, Emergency, Unpaid, Maternity, Paternity, Bereavement
>    - **Shift policies (all four types):**
>      - "Office Default" — Fixed, 07:30–15:30, 15-min grace, tenant-wide (active_from = today, active_until null)
>      - "Flex Engineers" — Flex, 07:00–09:00 in / 15:00–17:00 out, 8 required hours, assigned to Engineering department
>      - "Ramadan 2026" — Ramadan type, dates Feb 18 – Mar 19 2026, 08:00–14:00, 6 required hours, tenant-wide
>      - "Half-day Friday" — Custom, every Friday for the next year (or just one upcoming Friday for simplicity), 08:00–12:00
>    - **Employees** — 25 total, distributed across departments:
>      - 8 in Engineering (codes DEMO0001–DEMO0008)
>      - 6 in Operations (DEMO0009–DEMO0014)
>      - 4 in Sales (DEMO0015–DEMO0018)
>      - 4 in Finance (DEMO0019–DEMO0022)
>      - 3 in Admin (DEMO0023–DEMO0025)
>      - One employee (DEMO0099 "Test Crossover") — the cross-tenant honeypot from the M2 test doc
>    - **Custom fields** (from P12): "Badge Number" (text, required), "Contract Type" (select: Permanent/Contract/Intern), "Joining Date" (date)
>    - **Branding:** primary color "plum", font "plus-jakarta-sans" — distinctly different from default teal so visual isolation is obvious
>
>    Names should be plausibly Omani (mix of Arabic and Western names) so the demo feels representative without being insensitive. Use a curated list of 30 names (commit it as a constant in the script). Emails follow `firstname.lastname@mts-demo.test`.
>
> 6. **Seed user accounts on `tenant_mts_demo`** following the M2 matrix shape:
>    - 1 Admin: `admin@mts-demo.test`
>    - 1 HR: `hr@mts-demo.test`
>    - 5 Managers, one per department, named `manager.eng@`, `manager.ops@`, `manager.sales@`, `manager.fin@`, `manager.admin@`
>    - 1 multi-department Manager: `manager.matrix@mts-demo.test` (Engineering + Sales)
>    - 1 dual-role user: `dual.role@mts-demo.test` (HR + Manager Operations)
>    - 5 Employees — pick 5 of the 25 employees to also have user accounts (so they can log in and see their own attendance / submit requests). Pick one from each department: `dawud.eng@`, `aisha.ops@`, `khalid.sales@`, `salma.fin@`, `nasser.admin@`. Match the user email to the corresponding employee email so the User↔Employee link works.
>    - Generate strong-but-printable passwords per user — see "Password generation" below.
>    - Each role assignment goes through the proper FK chain (user_roles, user_departments, manager_assignments per P8). Set `manager.eng@mts-demo.test` as the primary manager for all Engineering employees.
>
> 7. **Seed `<REAL_CORPORATE_SLUG>` with minimal real data** — this is YOUR corporate that will use the real camera:
>    - **Departments:** just 2: Office, Operations (keep simple, you can expand later through the UI)
>    - **No holidays seeded** — set those through the UI as a real config exercise
>    - **One Fixed policy:** "Office Hours" 09:00–18:00, 15-min grace, tenant-wide
>    - **Branding:** primary color "navy", font "inter"
>    - **Users — only 4 to start, since this is real:**
>      - 1 Admin: `admin@<corporate-domain>` — Suresh
>      - 1 HR: `hr@<corporate-domain>`
>      - 1 Manager: `manager@<corporate-domain>` — for the Office department
>      - 1 Employee: `employee@<corporate-domain>` — Suresh's own face for camera testing
>      - The corporate-domain default is `mts.local` if `REAL_CORPORATE_SLUG` is `mts-office`, else derive `<slug>.local`. Override via the `REAL_CORPORATE_DOMAIN` constant at the top of the script if needed.
>    - **One employee record matching the Employee user**, code `<UPPER(SLUG)>0001`, full_name "Suresh Kumar" (or read from a `REAL_TEST_EMPLOYEE_NAME` constant at top of script — Suresh fills this in too).
>    - **One camera placeholder record** with name "Office Camera 1", location "Reception", and an explicit comment in the seeded `notes` field: "RTSP URL must be set via the UI before testing — placeholder only". Do NOT prompt for or store the real RTSP URL in the script. Suresh adds it through the UI under Cameras → Edit. The point is to leave a record there so Suresh sees an obvious next step in the UI rather than starting from an empty Cameras page.
>
> 8. **Do NOT seed photos automatically.** Print clear next-step instructions:
>    - For demo tenant: "Photo enrollment is intentionally skipped. Use the Employees page to upload photos via the OM-style naming convention. Sample photos at `backend/scripts/_seed_data/sample_photos/`."
>    - For real corporate: "Upload your own photo for code `<UPPER(SLUG)>0001` to enable face identification testing with the office camera."
>    - Create the `backend/scripts/_seed_data/` directory if missing, but do NOT generate fake face images — they won't match against the InsightFace model meaningfully and will give false confidence. Leave the directory with a README explaining how to add real photos.
>
> 9. **Seed sample employees Excel** at `backend/scripts/_seed_data/employees_demo_sample.xlsx` — a small reference file (5 rows) Suresh can use to test the import flow on the demo tenant. Columns match the P5 import schema.
>
> 10. **Print credentials to console AND write to `credentials.txt` at repo root.** Format must be human-readable:
>     ```
>     ╔════════════════════════════════════════════════════════════╗
>     ║         HADIR v1.0 — PRE-OMRAN VALIDATION CREDENTIALS      ║
>     ║         Generated: 2026-04-26 14:30 GST                    ║
>     ║         WARNING: dev/test credentials only — DO NOT USE    ║
>     ║         IN PRODUCTION. credentials.txt is gitignored.      ║
>     ╚════════════════════════════════════════════════════════════╝
>
>     ── MTS SUPER-ADMIN (login at /super-admin/login) ──────────
>     superadmin@mts.test         |  <generated-password>
>     support@mts.test            |  <generated-password>
>
>     ── TENANT: mts_demo (synthetic test data) ──────────────────
>     URL: http://localhost:5173    Tenant slug: mts_demo
>
>     Admin       | admin@mts-demo.test          | <pwd>
>     HR          | hr@mts-demo.test             | <pwd>
>     Manager Eng | manager.eng@mts-demo.test    | <pwd>
>     ... (full list)
>
>     Honeypot employee: DEMO0099 "Test Crossover" (no login)
>
>     ── TENANT: <REAL_CORPORATE_SLUG> (real corporate, real camera) ──
>     URL: http://localhost:5173    Tenant slug: <slug>
>
>     Admin    | admin@<domain>     | <pwd>
>     HR       | hr@<domain>        | <pwd>
>     Manager  | manager@<domain>   | <pwd>
>     Employee | employee@<domain>  | <pwd>
>
>     Test Employee record: <UPPER(SLUG)>0001 "<name>" (matches Employee user)
>
>     ── NEXT STEPS ─────────────────────────────────────────────
>     1. Add credentials.txt to .gitignore if not already (the script already did this).
>     2. Log in as Super-Admin first; verify both tenants are visible.
>     3. Validate demo tenant per docs/testing/pre-omran-validation.md
>     4. Configure your office camera RTSP via the Cameras page on the real corporate tenant.
>     5. Upload your face photo for <UPPER(SLUG)>0001.
>     6. Walk past the camera. Verify identification, attendance, reports.
>     7. Run through the validation checklist end-to-end before showing Omran.
>     ```
>
>     Use a strong-but-typeable scheme: three random English words separated by hyphens, plus a 2-digit suffix and a punctuation mark, e.g. `bright-clay-orbit-47!`. About 60 bits of entropy, easy to type during a demo, hard to guess. Use the `secrets` module — never `random`. Words from a curated 200-word list of common, unambiguous English words committed alongside the script (avoid homophones and lookalikes like `their/there`, `to/too`, `0/O`).
>
> 11. **Add `credentials.txt` to `.gitignore`** if not already there. Verify by `git check-ignore credentials.txt` after writing.
>
> 12. **Idempotency:** the script is destructive by design. After the typed-RESET confirmation, it always wipes and re-seeds. Subsequent runs produce the same data shape but **freshly generated passwords every time** (so Suresh's last `credentials.txt` is always the source of truth — no stale-credential confusion).
>
> 13. **Create `docs/testing/pre-omran-validation.md`** with a step-by-step validation checklist Suresh follows after seed. See the structure in the validation checklist section below.
>
> ---
>
> ### Implementation notes
>
> - Use the existing provisioning CLI (`backend/scripts/provision_tenant.py` from P2) — don't reimplement schema creation. Call it as a function: `provision_tenant(slug, name, admin_email=None, admin_password=None, skip_default_admin=True)`. The script seeds its own admin in step 6/7, so skip the CLI's default admin creation.
> - Reuse the M2 seed helpers from `backend/scripts/seed_test_accounts.py` where they exist; otherwise factor shared logic (Argon2 hash + role assignment + department assignment + manager assignment) into a small helper module `backend/scripts/_seed_helpers.py`.
> - All passwords go through the same Argon2 path the app uses — don't shortcut.
> - Audit-log every seed action with actor `system_seed`. The script is invoked outside a request context, so use a service-account `actor_user_id=NULL` and `actor_label='system_seed'` (add this column to audit_log if it doesn't exist — but check first; P3's super-admin work may have added it).
> - Wrap each tenant's seed in a transaction. If anything fails inside a tenant, roll back that tenant cleanly and report — but proceed to the next tenant. Don't abort the whole run on one tenant failure.
> - Print progress headers as it goes: `▸ Wiping database...`, `▸ Provisioning tenant_mts_demo...`, `▸ Seeding 25 employees...`, `▸ Generating credentials...`. Suresh wants to see it working.
>
> ---
>
> ### Validation checklist file (`docs/testing/pre-omran-validation.md`)
>
> Generate this as a separate markdown file with the structure below. It's the playbook Suresh runs after the seed — turn each section into a clear, numbered checklist with checkboxes:
>
> 1. **Bootstrap check** — credentials.txt exists, gitignored. Both tenants visible to Super-Admin.
> 2. **Demo tenant — multi-feature smoke** — log in as each role. Verify sidebar contents per role. Verify branding (plum + plus-jakarta-sans).
> 3. **Demo tenant — policy & attendance** — confirm all four policies present. Trigger a manual attendance recompute. Spot-check that the Engineering Flex policy applies to Engineering employees and Office Default to others.
> 4. **Demo tenant — approval workflow** — Employee submits exception → Manager approves → HR approves. Then a reject path. Then Admin override.
> 5. **Demo tenant — reports** — generate Excel and PDF for the last 7 days. Schedule a weekly report; "Run now"; verify email arrives (configure SMTP first if it isn't already from P18 — note in the doc that SMTP config is a one-time setup).
> 6. **Demo tenant — Arabic + RTL** — switch to Arabic. Click through every page. Verify RTL layout doesn't break anything. Note: Arabic translation review by Omran is still pending per BRD Open Item Q7 — flag any obvious mistranslations.
> 7. **Cross-tenant isolation** — Window A logged into demo, Window B logged into the real corporate tenant. Verify no data crosses. Specifically test the honeypot: search for "Test Crossover" in real corporate — should return zero results.
> 8. **Real corporate tenant — camera setup** — Cameras page → edit "Office Camera 1" → enter real RTSP URL → save → click Preview. Verify a frame returns. SSH to the dev box and verify `docker compose logs backend | grep rtsp://` returns nothing.
> 9. **Real corporate tenant — face enrollment** — upload Suresh's photo for `<UPPER(SLUG)>0001`. Verify the embedding generates (check via API or DB). Walk past the camera. Camera Logs should show identification with confidence > 0.5 within 30 seconds.
> 10. **Real corporate tenant — full attendance flow** — verify your detection becomes an attendance record after the next 15-min recompute. In_time should match the first detection. Walk past again 30 minutes later — out_time should update.
> 11. **Real corporate tenant — generate report** — produce an Excel for today. Should contain your single attendance record.
> 12. **Audit log spot-check** — log in as Admin in each tenant, open Audit Log, confirm every action above is recorded with the right actor.
> 13. **Database isolation spot-check** — run the SQL queries from `docs/testing/v1.0-m2-test-accounts.md` Section 7. Verify schemas, user counts, password hashes, and grant restrictions.
> 14. **Issue log** — for every problem found, note in a "Pre-Omran issues" section at the bottom of the validation doc: what page, what action, expected vs actual, severity. This becomes Suresh's pre-cutover fix list.
>
> ---
>
> ### Red lines
>
> - The script ONLY runs when `HADIR_ENV=dev` AND the typed-RESET confirmation passes. Both gates required.
> - `credentials.txt` is gitignored before it is written. Verify the gitignore entry took effect; if `git check-ignore credentials.txt` returns non-zero (file not ignored), abort and print a loud error.
> - Never seed Omran. Omran's tenant gets clean real data at P29.
> - Never store real RTSP URLs in the script or in seeded data. UI configures them with Fernet-encrypted at-rest storage per pilot P7.
> - Don't generate placeholder face photos. Better to leave the field empty than seed faces that won't match anything meaningful.
> - Audit log must record every seed action.
>
> ---
>
> ### When done
>
> Walk through the script once end-to-end yourself before handing it off:
> 1. Set `HADIR_ENV=dev` in your env.
> 2. Set the three constants at the top to test values: `REAL_CORPORATE_NAME = "Test Corp"`, `REAL_CORPORATE_SLUG = "test-corp"`, `REAL_TEST_EMPLOYEE_NAME = "Test User"`.
> 3. Run the script, confirm the RESET prompt, watch it complete.
> 4. Open `credentials.txt`, log in as Super-Admin, then as demo Admin, then as test corp Admin. Confirm everything works.
> 5. Reset constants back to `__CORPORATE_NAME_HERE__` placeholders so the next runner has to set them.
> 6. Commit as `chore: pre-omran reset+seed script`. Update `CLAUDE.md` with a "Pre-Omran validation" section pointing to this script and the validation doc.
>
> Then **stop and show me**. Suresh will fill in his real corporate name, run the script, and walk through `docs/testing/pre-omran-validation.md` over the next day or two. Issues found become the pre-cutover fix list.

---

## How Suresh runs this after Claude Code delivers the script

1. Open `backend/scripts/pre_omran_reset.py` in your editor.
2. Set the constants at the top:
   ```python
   REAL_CORPORATE_NAME = "Your Real Corporate Name"
   REAL_CORPORATE_SLUG = "your-corporate-slug"        # lowercase, hyphens
   REAL_TEST_EMPLOYEE_NAME = "Your Name"              # the person whose face gets enrolled
   REAL_CORPORATE_DOMAIN = "yourcorp.local"           # optional, defaults sensibly
   ```
3. Make sure `HADIR_ENV=dev` is set in your `.env` (it should be from the dev setup).
4. Stop the running app: `docker compose down`.
5. Run the script:
   ```bash
   docker compose run --rm backend python -m backend.scripts.pre_omran_reset
   ```
6. Type `RESET` when prompted.
7. Wait for completion (~30–60 seconds).
8. Read `credentials.txt`. Start the app: `docker compose up -d`.
9. Walk through `docs/testing/pre-omran-validation.md` step by step. Tick boxes as you go. Note any issues at the bottom.
10. Bring fixes back to Claude Code as a P28.5 follow-up phase before P29.

---

## What this gets you before Omran

- A clean, reproducible state — no leftover pilot data confusing the demo
- Three tenants in your sense: Super-Admin (MTS), demo (rich synthetic), real (your office, real camera)
- All credentials printed and saved, ready to copy-paste into a browser
- Full v1.0 feature surface exercised on the demo tenant — every policy type, every role, the approval workflow, scheduled reports, Arabic, branding
- Real-camera, real-face validation on your office hardware before Omran sees anything
- A documented checklist that doubles as your dry-run script for the Omran demo

---

## Notes on safety

- `credentials.txt` is gitignored. Treat it like an SSH private key — don't email it, don't paste it into chat. If you need to share specific accounts with the MTS team, copy individual lines.
- The script is destructive. Anyone running it against the wrong DB wipes everything. The three brakes (env check + employee count check + typed RESET) are deliberate. Don't remove them.
- The real corporate tenant created here is for pre-Omran testing. When that tenant has served its purpose, you can either keep it for ongoing internal use (rename, set real branding) or deprovision it via `backend/scripts/deprovision_tenant.py` before going to production.
