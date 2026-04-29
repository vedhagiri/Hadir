# Maugood — Project Context Memory

**Purpose of this document:** Paste this into a fresh Claude conversation or save in project knowledge so any new Claude instance has full context without re-reading the long history.

**Last updated:** end of planning phase, pre-build
**Status:** Planning complete, pilot about to start
**Owner:** Suresh (Muscat Tech Solutions)
**Client (first customer):** Omran (Oman)

---

## 1. Product identity

**Name:** Maugood (Arabic حاضر, meaning "present" — fitting for an attendance system)

**One-line definition:** Maugood is a camera-based employee attendance platform. IP cameras on a corporate LAN detect employees as they arrive and leave; the system identifies them by face, computes attendance against configurable shift policies, runs approval workflows for exceptions, and delivers scheduled reports.

**Vendor:** Muscat Tech Solutions (MTS)
**First customer:** Omran, Oman
**Future direction:** Sold as a SaaS product to additional clients; SaaS-capable architecture from day one, on-premise deployment option preserved for enterprise clients like Omran.

---

## 2. The two-track delivery plan

Because Omran needs a demo in ~5 days but the full product is 8–16 weeks of work, we split delivery into two explicit tracks:

### Track A — Pilot (5 days, week 1)

Single-tenant, simplified policy engine, no approval workflow, no scheduled reports, no i18n translations, local auth only, HTTP on LAN. Goal: demonstrate that cameras at Omran capture employees, identify them, produce attendance logs, and the UI looks like the final Maugood design. This is a **demo**, not production. The client must be told this clearly.

### Track B — v1.0 Full Product (8–10 weeks after pilot signoff)

Multi-tenant SaaS architecture (schema-per-tenant), full shift policy engine (Fixed/Flex/Ramadan/Custom), approval workflow with state machine, scheduled reports, Arabic + English i18n with RTL, dark mode, Entra ID OIDC, HTTPS, backup/DR, per-tenant branding, tenant onboarding, Super-Admin console. This is the sellable product.

The BRD describes v1.0 completely. The pilot is called out as a delivery milestone within v1.0, not a separate product.

---

## 3. Client stakeholder answers (from Omran)

These are confirmed answers from Omran — do not re-litigate these without checking:

### Identification
- Filename convention: `OM0097.jpg` (unlabelled = front) or `OM0097_front.jpg`, `OM0097_left.jpg`, etc.
- At least one front-facing photo per employee; more photos for better off-angle accuracy
- Employee record must exist (via Excel import) before photos link to it — no auto-create

### Authentication
- Microsoft Entra ID (Azure AD) via OIDC (v1.0)
- Email + password as fallback, dev-mode (pilot uses this exclusively)
- User match by email, case-insensitive
- No 2FA in Phase 1

### Roles
- **Admin** — full access, all employees, all cameras
- **HR** — all employees (read), policy config, final approval authority (special role, not department)
- **Manager** — own department(s) only, first-level approver
- **Employee** — self only
- A user can hold multiple roles; role switcher in UI
- A user can be assigned to multiple departments; sees union of those departments' employees
- Role assignment by Admin in the app, not auto-derived from AD

### Time policies
- Admin + HR can configure policies at runtime (add/edit without deploy)
- **Fixed**: 07:30–15:30 default; late-in = in > start+grace; early-out = out < end-grace
- **Flex**: window 07:30–08:30 in, 15:30–16:30 out; must complete 8 hours; short hours flag if under
- **Ramadan**: configurable per year (dates shift)
- **Special days**: Admin/HR can override policy per date range
- Overtime computed when hours > required; stored separately; notifies Manager + HR
- First detection of day = in-time; last = out-time (intermediate detections kept in log but not used)

### Approvals
- Sequential: Manager → HR (not parallel)
- If Manager rejects → dead
- If Manager approves → goes to HR
- HR decision is final
- Admin can override with mandatory comment
- Both pre-request ("I'll be late tomorrow") and retroactive ("I was late yesterday") allowed

### Leaves & holidays
- Configurable by Admin/HR
- Leaves on approved days clear the ABSENT flag
- Work on a holiday counts as overtime
- Weekends default to non-working (configurable)

### Database
- PostgreSQL (confirmed; not MongoDB)
- Schema-per-tenant for SaaS isolation (v1.0); single schema for pilot

### Deployment
- Primary: Ubuntu on corporate LAN with internal domain
- Secondary: cloud deployment for read-only mirror of reports (future)
- HTTPS required for production; self-signed fine for dev, decide on cert source before go-live
- Cameras are LAN-only (RTSP over internet is not in scope)

### Reports & notifications
- Scheduled reports to HR + IT (configurable)
- Excel + PDF formats (PDF is v1.0, not pilot)
- Email delivery (attachment if small, link if large)
- ERP sync hook architectural interface, actual connector future
- Separate settings tab for report schedules

### Data retention
- Employees, attendance records, face crops, approval history: retained forever; Admin can delete
- Camera health snapshots: 30 days
- App logs: 30 days with rotation
- Oman PDPL compliance: system follows general principles; client responsible for legal sign-off

### Misc
- Search: text only (by ID, name, email, department); no face-based search
- Mobile: responsive web only; no native app
- Employee self-photo upload: requires Admin approval before used for matching
- Camera status (uptime, images captured) visible to Admin only

---

## 4. SaaS architecture decisions (v1.0)

- **Multi-tenancy:** schema-per-tenant in PostgreSQL. Strongest reasonable isolation for biometric data compliance. Alembic migrations run per-schema.
- **Deployment modes:** same codebase, config-driven
  - `TENANT_MODE=single` → one schema named `main` (Omran)
  - `TENANT_MODE=multi` → schema per tenant (future SaaS clients)
- **Tenant branding:** curated slots, not free-form. Clients pick primary color from palette, upload logo, select fonts from a list. Protects design integrity.
- **Super-Admin role:** MTS staff can access any tenant for support; every such access audit-logged.
- **No billing automation in Phase 1** — flat-fee per deployment initially; automated billing is post-Phase 8.

---

## 5. Technical stack (confirmed, do not change without explicit decision)

### Backend
- Python 3.11
- FastAPI (with Uvicorn + Gunicorn in production)
- SQLAlchemy 2.x Core (not ORM for the most part)
- Alembic migrations
- Authlib (OIDC) + Argon2-cffi (local password)
- Server-side sessions in Postgres (not JWT)
- APScheduler for jobs (in-process for pilot; Celery later if needed)
- InsightFace buffalo_l for face detection + embeddings (CPU-only)
- OpenCV for RTSP capture
- Custom IoU tracker (already proven in detection-app)
- Pydantic v2 for validation and config
- pytest + httpx + pytest-asyncio for tests
- ruff + black + mypy

### Frontend
- React 18 + Vite
- TypeScript strict mode
- React Router v6
- TanStack Query for server state
- Zustand for small client state
- React Hook Form + Zod for forms
- Plain CSS using the Maugood design system's files (no Tailwind, no CSS-in-JS)
- Icons from the curated `icons.jsx` from the Maugood design reference
- Vitest + Playwright for testing

### Database
- PostgreSQL 15+
- pgvector extension optional for future similarity search at scale
- Face embeddings as BYTEA for now

### Deployment
- Ubuntu 22.04 LTS
- Nginx reverse proxy
- systemd for services
- Docker Compose for dev and optional prod
- Environment variables via `.env` / `systemd EnvironmentFile`
- Self-signed HTTPS for dev, real cert for prod
- Scripted backup (pg_dump + tar) via cron
- Prometheus + Grafana monitoring (Phase 8)

### Why not X
- Not Django (too heavy; we don't need admin/templates/forms)
- Not Node backend (face pipeline requires Python)
- Not Next.js (SSR unnecessary for authenticated app)
- Not Tailwind (Maugood design uses CSS custom properties for theming)
- Not MongoDB (data is relational)
- Not GraphQL (REST fits the use case)
- Not Kubernetes (single-host deployment; overkill)
- Not microservices (modular monolith is right for this scale)

---

## 6. Maugood design system (summary)

Full reference lives in `design-system.md`. Key constraints:

- **Brand mark:** Arabic ح in dark rounded square with accent dot
- **Colors:** warm neutrals (not cool grey), deep teal accent, OKLCH color space, full dark mode
- **Typography:** Inter (sans), Instrument Serif (display for stat values + page titles — distinctive choice), JetBrains Mono (IDs, times, percentages)
- **Layout:** 232px sidebar, 52px topbar, 1320px max content
- **Primary button is BLACK** (not teal) — deliberate; resist the urge to use accent color for buttons
- **Stat values use display serif**, not monospace — resist changing this
- **Role-aware navigation** per role (Admin / HR / Manager / Employee) — literal structure from `shell.jsx` in design reference
- **RTL + Arabic** supported via `dir="rtl"` on root; infrastructure ready in v1.0; translations to be supplied/reviewed

### Reference files
- `Maugood.html` and supporting files from `Globe_loader__3_.zip` archive
- Contains: styles.css + 3 enhancement CSS files, icons.jsx, all dashboard components, all pages, sample data with Omani employee names
- Copy CSS files verbatim into `frontend/src/styles/`; do not port to another framework

---

## 7. Project structure

### Repository
**Single GitHub monorepo** named `maugood` with this structure:

```
maugood/
  backend/
    pyproject.toml
    .env.example
    Dockerfile
    maugood/             # python package
      __init__.py
      main.py          # FastAPI app factory
      config.py        # Pydantic Settings
      db.py            # SQLAlchemy engine, session
      CLAUDE.md
      auth/            # sessions, OIDC, local password, dependencies
      tenants/         # tenant model, schema routing (v1.0)
      employees/       # employees, departments, import/export, photos
      cameras/         # CRUD, health monitoring, RTSP encryption
      capture/         # reader, analyzer, tracker, events, manager
      identification/  # matcher, embedding cache
      attendance/      # engine (pure), policies, holidays, leaves
      requests/        # state machine, exception/leave requests (v1.0)
      reporting/       # report types, renderers, schedules
      notifications/   # in-app + email dispatcher
      audit/           # append-only audit log
      retention/       # cleanup jobs
      common/          # shared utilities
    alembic/
      versions/
    tests/
    scripts/
      setup.sh
      seed_admin.py
      backup.sh
      restore.sh
      deploy.sh
  frontend/
    package.json
    vite.config.ts
    tsconfig.json
    index.html
    Dockerfile
    CLAUDE.md
    src/
      main.tsx
      App.tsx
      styles/          # Maugood CSS from design reference, verbatim
      design/          # icons.jsx + read-only copy of design zip
      api/             # generated OpenAPI types + fetch wrapper
      auth/            # AuthProvider, LoginPage
      shell/           # Sidebar, Topbar, Layout
      components/      # StatCard, Card, Pill, Table, FaceThumb, FormDrawer
      features/
        dashboards/
        employees/
        cameras/
        live-capture/
        attendance/
        requests/
        reports/
        settings/
        audit-log/
        enrollment/
      hooks/
      lib/
      tests/
  docker-compose.yml
  README.md
  CLAUDE.md            # top-level project overview
  PROJECT_CONTEXT.md   # this file
  design-system.md     # UI reference (authoritative for design)
  pilot-plan.md        # 5-day pilot plan with Claude Code prompts
  .gitignore
```

### Code standards
- **Human-readable.** Future developer will own this code — write for them
- Every Python module starts with a docstring explaining purpose
- Every non-trivial function has a docstring
- Non-obvious logic gets inline comments explaining *why*, not *what*
- TypeScript strict mode, no `any`
- No clever one-liners
- Tests co-located with source

### Claude Code integration
- `CLAUDE.md` at root, in `backend/`, in `frontend/` — explains the module layout to new Claude Code sessions
- Small, focused prompts (2–4 hours of work each) so each phase can be reviewed before next
- Phase prompts stored in `pilot-plan.md` (pilot) and `docs/phases/` (v1.0 phases)

---

## 8. Deferred from pilot (in v1.0, NOT in 5-day pilot)

Explicitly out of pilot scope — Omran will be told this at demo:

- Multi-tenancy (pilot is single-tenant on one schema)
- Full shift policy engine (pilot has only one Fixed policy)
- Approval workflow (pilot has audit log; no state machine yet)
- Exception requests, leave requests, attachments
- Scheduled reports with email delivery
- PDF output (pilot has Excel only)
- ERP file-drop integration
- Arabic translations (UI infrastructure in place; English only)
- Dark mode toggle wired up (CSS present, toggle deferred)
- Density toggle
- Entra ID OIDC (pilot is email + password only)
- HTTPS with proper certs (pilot uses HTTP on LAN)
- Backup automation, DR scripts
- Log rotation
- Monitoring (Prometheus, Grafana)
- Tenant onboarding UI
- Per-tenant branding
- Super-Admin console
- Retention cleanup automation
- "How it works" explainer page
- API Reference page
- Custom Fields editor
- Manager Assignments drag-and-drop
- Full role switcher (pilot uses user's highest role)

Pilot includes:
- Shell + design matching Maugood
- Local email+password auth
- Users, roles, departments, audit log
- Cameras CRUD + live preview (on-demand)
- Background capture on all enabled cameras (no UI start/stop)
- Employees with Excel import/export, photo ingestion
- Face identification tied to real cameras
- One simple Fixed shift policy (07:30–15:30)
- Attendance records computed every 15 min for today
- Role-specific dashboards
- Daily Attendance page with detail drawer
- Camera Logs page
- Audit Log UI (Admin)
- System page with camera health
- On-demand Excel reports
- Single-host deployment via Docker Compose

---

## 9. Testing / rollout sequence

Confirmed: Suresh tests with own images + own IP camera first, then deploys to Omran. This means:

- Days 1–4 development happens on Suresh's local setup using personal camera + test employees (including Suresh himself)
- Day 5 deployment to Omran's Ubuntu host uses the same Docker Compose, just with real RTSP URLs and real employee data

This is a reasonable sequence. Real camera testing from Day 1 surfaces issues early (lighting, angle, firmware quirks) that don't show up with pre-recorded video.

---

## 10. Communication & review pattern

- **One small prompt per Claude Code session** (2–4 hours). After each, Suresh reviews UI + backend and confirms or requests changes.
- **No auto-continue.** Every prompt ends with "stop and show me" — Claude Code waits for approval.
- **Commit after every approved prompt.** `git log` becomes the audit trail of the build.
- **CLAUDE.md updated as things change.** Not just README — CLAUDE.md is the current-state-of-the-world file for Claude Code sessions.

---

## 11. Open questions (for Omran, not for engineering to guess)

- Q1. Exception request reason categories beyond the default seed list (Doctor, Family, Traffic, Official, Other, Annual Leave, Sick Leave, Emergency Leave, Unpaid Leave)
- Q2. Default scheduled-report time and recipient list for first deployment (v1.0)
- Q3. Specific ERP product for integration (for v1.0 connector scoping)
- Q4. Off-site backup destination (NAS / cloud / both)
- Q5. SMTP server or Microsoft Graph for outbound email
- Q6. Approval SLA / auto-escalation rules
- Q7. Arabic translation source — MTS internal, external translator, or Claude-generated + native-speaker review
- Q8. For SaaS tier: free/trial plan, self-serve onboarding vs MTS-mediated, billing model
- Q9. Primary-manager concept when an employee has multiple managers across departments

Every one of these has a reasonable default in the BRD / design. They need confirmation, not invention.

---

## 12. Known constraints / red lines

- **Biometric data is PDPL-regulated.** Encryption at rest, audit-logged access, delete-on-request — all non-negotiable.
- **No clever design improvements.** The Maugood design is the design. Claude Code doesn't "enhance" it unless asked.
- **No scope creep into post-pilot features.** If a prompt starts adding approval workflow during pilot, stop and push back.
- **RTSP credentials never plain-text.** Encrypted with Fernet, key from env var.
- **Passwords never logged.** Argon2 hashes are fine; plain passwords never appear anywhere.
- **Admin can't delete from audit log.** It's append-only, period.
- **Single-schema pilot is a temporary constraint.** The code must be written so multi-tenant migration is feasible — tenant_id plumbing or schema routing decided up front, even if not activated in pilot.

---

## 13. Quick-start for a new Claude session

If you're a new Claude Code session picking this up:

1. Read `CLAUDE.md` at the repo root for current state
2. Read `PROJECT_CONTEXT.md` (this file) for history and decisions
3. Read `design-system.md` before any UI work
4. Read `pilot-plan.md` if you're in pilot mode, or the appropriate phase file in `docs/phases/` for v1.0
5. Check `git log` to see what's been built recently
6. Never start coding without confirming which prompt / phase is active

If the user asks for something that conflicts with what's in this file, flag it rather than silently deviating. Decisions here were made deliberately; overriding them needs a conversation.

---

## 14. Glossary (for when you hand this off)

- **Maugood** — the product name (Arabic حاضر "present")
- **Omran** — the first customer, a company in Oman
- **MTS / Muscat Tech Solutions** — the vendor; Suresh's company
- **Tenant** — a customer of Maugood-as-SaaS; one schema per tenant in multi-tenant mode
- **Pilot / v0.1** — the 5-day demo build
- **v1.0** — the full product shipping 8–10 weeks post-pilot
- **detection-app** — the original single-user prototype (Round 1–4 work); retained as reference and demo, not the basis for v1.0 code
- **Super-Admin** — MTS staff role for cross-tenant support (multi-tenant deployment only)
- **Entra ID / Azure AD** — Microsoft's cloud identity provider; the OIDC path for SSO
- **PDPL** — Oman's Personal Data Protection Law, 2023; governs biometric data handling
- **Shift policy types** — Fixed (exact in/out), Flex (window), Ramadan (reduced hours during Ramadan), Custom (per-date-range override)
