# Hadir pilot — sign-off

> **STATUS: not yet delivered.** This file is a template committed
> before P14 has actually been run. Do **not** treat the existence of
> this file as evidence that anything was delivered. The MTS engineer
> on the Omran day must replace every `<TODO …>` placeholder with real
> values, flip the status line to `STATUS: delivered`, and commit as
> `feat(P14): omran pilot deployment + signoff`. Until that commit
> lands, the pilot is not signed off.

---

## Deployment record

| Field | Value |
| --- | --- |
| Date (Asia/Muscat) | `<TODO YYYY-MM-DD>` |
| Time on-site | `<TODO HH:MM start> → <TODO HH:MM finish>` |
| Location | `<TODO Omran HQ address / building / floor>` |
| Git commit deployed | `<TODO output of: git rev-parse --short HEAD on the host>` |
| Hadir version | `0.1` (pilot) |
| Tenant mode | `single` |
| Backend env | `HADIR_ENV=production` (DEV-ONLY `/api/_test/*` endpoints **not** mounted) |
| Local timezone | `Asia/Muscat` |
| Match threshold | `<TODO HADIR_MATCH_THRESHOLD value at sign-off — default 0.45>` |
| Cameras configured | `<TODO N>` |
| Employees imported | `<TODO N>` |
| Reference photos enrolled | `<TODO N — should equal active-employees once reembed completes>` |

## Attendees

| Role | Name | Affiliation | Signature on printed checklist? |
| --- | --- | --- | --- |
| Sponsor (Omran) | `<TODO name>` | `<TODO HR / IT / Operations>` | `<TODO yes/no>` |
| Engineer (MTS) | `<TODO name>` | Muscat Tech Solutions | n/a |
| Observer | `<TODO name>` | `<TODO Omran department>` | optional |
| Observer | `<TODO name>` | `<TODO Omran department>` | optional |

## What was demonstrated

The seven items from the BRD §15.1 acceptance checklist were each
shown live to the sponsor in the order below. Tick = sponsor confirmed
verbally and the printed checklist row was signed.

- [ ] **1. Excel import + photo ingestion** — Omran's roster `.xlsx`
      imported with `<TODO created/updated/errors>`. Photos uploaded
      via the bulk endpoint with `<TODO accepted/rejected>`. Photo
      counts on the Employees page reconciled against HR's expected
      figures. Sponsor watched the Employees → row → drawer flow.
- [ ] **2. Background capture on all enabled cameras** — `<TODO N>`
      cameras configured; System page showed
      `capture_workers_running == cameras_enabled` and
      `frames_last_minute` ~ `<TODO range>` per camera.
- [ ] **3. Face identification producing events with employee IDs** —
      walked past `<TODO camera name>` with `<TODO N>` employees;
      Camera Logs filled in within ~1 s with the right employee
      attribution and confidence > 0.5.
- [ ] **4. Fixed policy (07:30–15:30) flagging in-time, out-time,
      late, early-out correctly** — Daily Attendance for the day
      showed `<TODO summary: present/late/early/absent counts>`.
      Sponsor opened a row drawer to inspect underlying events and
      flag explanations.
- [ ] **5. Daily Attendance, Camera Logs, Audit Log, System pages
      render with live data** — each page navigated to, sponsor
      acknowledged the data was real and not a static mock-up. Audit
      Log showed every action MTS engineer had taken on the day.
- [ ] **6. On-demand Excel export** — Reports page → Generate Excel
      for today's range → file downloaded and opened on the sponsor's
      laptop. Columns + ISO-week sheet naming verified.
- [ ] **7. UI matches the Hadir design system in English, light
      mode** — sponsor walked the navigation; confirmed branding /
      typography / color usage match the design proposals reviewed
      pre-pilot.

## Deferred-list acknowledgement

The following items are **NOT present** in this pilot and the
sponsor signed an acknowledgement that they understand they will
ship in v1.0, not pilot. The full deferred list is `PROJECT_CONTEXT.md
§8` — read aloud and confirmed item-by-item with the sponsor:

- Multi-tenancy (single-tenant pilot)
- Full shift policy engine (Flex / Ramadan / Custom)
- Approval workflow + state machine
- Exception requests, leave requests, attachments
- Scheduled reports + email delivery
- PDF report output
- ERP file-drop integration
- Arabic translations + RTL
- Dark mode toggle wiring
- Density toggle
- Entra ID OIDC SSO
- HTTPS with proper certs
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
- Full role switcher

Sponsor acknowledgement: `<TODO yes / yes-with-comment / no — escalate>`

If `no — escalate`, do **not** mark the pilot delivered. Capture the
disputed items below, schedule a follow-up with MTS leadership, and
leave the status line at `STATUS: not yet delivered`.

## Open items raised on the day

Items the sponsor raised that aren't blockers for sign-off but should
become v1.0 backlog candidates. Be specific — vague items become
arguments later.

1. `<TODO open item — owner — target session>`
2. `<TODO …>`
3. `<TODO …>`

## Known limitations as deployed

Fill in only items that *did not work as expected on the day* — not
items that were intentionally deferred (those go in §"Deferred-list
acknowledgement" above).

- `<TODO e.g. CAM-04 in the loading dock had intermittent reachability;
  Omran IT to relocate the camera before v1.0 demo>`
- `<TODO …>`

## Hand-off

- [ ] Fernet key recorded in Omran's secret manager (`<TODO label /
      vault path>`).
- [ ] Omran IT shown `docker compose down` (safe) vs `down -v`
      (destructive).
- [ ] Seed-admin password handed to `<TODO HR contact>` on paper /
      sealed envelope.
- [ ] v1.0 kickoff scheduled for `<TODO date>`.
- [ ] MTS emergency contact: `<TODO name + email + phone>`.

## Sign-off

By committing this file as `feat(P14): omran pilot deployment +
signoff`, the MTS engineer asserts:

1. The deployment was performed exactly as documented in
   `docs/pilot-day-runbook.md` (or any deviations are recorded under
   §"Known limitations as deployed" above).
2. The sponsor named in §"Attendees" was physically present and
   signed the printed acceptance checklist.
3. The sponsor named in §"Attendees" verbally and in writing
   acknowledged the deferred list per §"Deferred-list acknowledgement"
   above.
4. No demo was misrepresented as production. The customer was told
   explicitly that this is a pilot demo and that go-live will require
   the v1.0 work itemised in `PROJECT_CONTEXT.md §8`.

Engineer (MTS): `<TODO name>` · Date: `<TODO YYYY-MM-DD>`

Sponsor (Omran): `<TODO name>` · Signed printed checklist filed at
`<TODO docs/pilot-signoff-photos/<filename>.jpg or out-of-band path>`

---

*This template was prepared on `2026-04-25` ahead of the on-site day.
The pilot-plan §"After the pilot" describes how this file is
superseded by `docs/phases/` entries once v1.0 work begins.*
