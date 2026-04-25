# Hadir pilot — acceptance checklist (printable)

> **Print two copies.** One stays with the Omran sponsor; one comes
> back with MTS for `docs/pilot-signoff.md`. The sponsor signs each
> functional row as it is demonstrated, plus the deferred-list
> acknowledgement at the end.

---

**Date:** `_____ / _____ / 2026`  &nbsp;&nbsp;&nbsp;&nbsp; **Time:** `_______ : _______ (Asia/Muscat)`

**Location:** Omran HQ, `_______________________________________________`

**Hadir build:** pilot v0.1 · git commit `_______________`

**Engineer (MTS):** `_______________________________________________`

**Sponsor (Omran):** `_______________________________________________`

**Sponsor's role:** `___________________________________  (HR / IT / Operations)`

---

## Functional acceptance — BRD §15.1

For each row: the engineer demonstrates live in the running UI, the
sponsor confirms it does what the BRD claims, the sponsor initials.

| # | Item demonstrated | Where shown | Outcome | Sponsor initials |
|---|---|---|---|---|
| 1 | Excel import + photo ingestion | Employees → Import; Employees → row → drawer | Roster `____` rows imported, photos `____` accepted, errors `____` | `____` |
| 2 | Background capture on all enabled cameras | System → Camera fleet | `____` enabled cameras, all `online` | `____` |
| 3 | Face identification producing events with employee IDs | Camera Logs after walk-past | confidence > 0.5 on `____` of `____` known faces | `____` |
| 4 | Fixed policy 07:30–15:30 flagging in/out/late/early-out correctly | Daily Attendance for today | flags reviewed live with sponsor | `____` |
| 5 | Daily Attendance, Camera Logs, Audit Log, System pages render with live data | All four pages navigated | live data, not mock | `____` |
| 6 | On-demand Excel export | Reports → Generate Excel; opened on the sponsor's laptop | file generated `_______________.xlsx`, columns verified | `____` |
| 7 | UI matches the Hadir design system in English, light mode | Whole shell + every page above | brand / type / color match design proposals | `____` |

---

## Deferred-list acknowledgement (PROJECT_CONTEXT §8)

These items are **NOT in this pilot**. They will ship in **v1.0 only**.
By initialling each line below, the sponsor confirms they understand
each item is *expected to be missing today* and *expected to ship
later* — and that no MTS person promised any of them as part of this
pilot.

| Deferred item | Sponsor initials |
|---|---|
| Multi-tenancy (single-tenant pilot) | `____` |
| Full shift policy engine (Flex / Ramadan / Custom) | `____` |
| Approval workflow + state machine | `____` |
| Exception requests, leave requests, attachments | `____` |
| Scheduled reports + email delivery | `____` |
| PDF report output | `____` |
| ERP file-drop integration | `____` |
| Arabic translations + RTL | `____` |
| Dark mode toggle wiring | `____` |
| Density toggle | `____` |
| Entra ID OIDC SSO | `____` |
| HTTPS with proper certs | `____` |
| Backup automation, DR scripts | `____` |
| Log rotation | `____` |
| Monitoring (Prometheus, Grafana) | `____` |
| Tenant onboarding UI | `____` |
| Per-tenant branding | `____` |
| Super-Admin console | `____` |
| Retention cleanup automation | `____` |
| "How it works" explainer page | `____` |
| API Reference page | `____` |
| Custom Fields editor | `____` |
| Manager Assignments drag-and-drop | `____` |
| Full role switcher | `____` |

---

## Sponsor's overall acceptance

I confirm the seven functional items above were demonstrated to my
satisfaction, and that I understand the deferred list will be
delivered as part of v1.0, not the current pilot.

**Sponsor name:** `_______________________________________________`

**Signature:** `_______________________________________________`

**Date:** `_____ / _____ / 2026`

---

## Engineer's confirmation

I confirm that:

- I deployed the build at the git commit recorded above.
- I did not represent any deferred-list item as present in this
  pilot.
- I did not commit `feat(P14)` until after the sponsor signed this
  page.
- The Fernet key for this deployment is recorded in Omran's secret
  manager, location: `_______________________________________________`.

**Engineer name:** `_______________________________________________`

**Signature:** `_______________________________________________`

**Date:** `_____ / _____ / 2026`
