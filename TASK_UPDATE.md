✅ *END OF DAY UPDATE* — Harikrishnan
=======================================

🗓 26 Jun 2026

### *Project: Attendance Monitoring (Omran)*

✅ Done: **Pipeline Analytics tab** — per-clip UC1/UC2 performance metrics (queue wait, clip load, frame decode, detection split into lock-wait vs compute, face crop, match, CPU/mem, detection counters), UC1-vs-UC2 comparison (avg/min/max/P95), per-clip table, CSV + ZIP-with-clips exports (cap 150), date range + Today, download popup with UC + format choice.
✅ Done: **Queue History** — clearing a queue no longer discards queued clips. Cleared rows now keep who/when/why (migration 0089) and can be reprocessed later (all, a selected subset, or per-row); clips whose file is gone are flagged non-reprocessable. New history + reprocess endpoints + modal with selection & pagination.
✅ Done: **Identify selected** on Clip Analytics — run UC1/UC2 on just the checkbox-selected clips (overwrite/skip), instead of the whole-tenant batch.
✅ Done: **On Leave** now surfaces correctly — fixed classification (frontend) + backend leave priority over weekend/holiday; added a dedicated leave day-detail template; Employee Report day rows are clickable and the summary cards click-to-filter (Present/Late/Absent/On Leave + Working Days = show all).
✅ Done: **Clip Analytics "Queued" status** + server-side processing-state filter (fixes pagination/total when filtering).
✅ Done: **Shared Pagination component** across Employees / Camera Logs / Clip Logs / Clip Analytics (hides prev on first page, next on last).
✅ Done: **Themed date picker** reused for Clip Logs & Clip Analytics filters (date-only, single-day-from-start, dd/mm/yyyy, tz-correct day bounds) + aligned filter toolbar with Clear option.
✅ Done: **Login SSO popup** — replaced the native browser alert with a styled, readable modal message.

✅ Pushed: all of the above committed and pushed to `release-omran` (latest `eb00803`).

⏳ Pending: nothing blocking — Queue History + Identify-selected are live.

🚧 *Blockers:* None.

💬 *Plan for Tomorrow:* Verify Queue History reprocess end-to-end on the client data; reprocess clips to start populating the new pipeline metrics (all new timing columns are NULL on old clips and fill going forward).
