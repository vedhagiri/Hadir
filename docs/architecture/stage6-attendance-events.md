# Stage 6 — Attendance / Event Processing: architecture (CPU-only)

> Scope: **event generation, recompute model, worker/thread/DB cost, and
> CPU-only scaling** for attendance. Companion to the Stage 1–5 docs.
> Grounded in `backend/maugood/attendance/scheduler.py`,
> `repository.py`, `engine.py` (v1.1.x).
>
> Target box: one site, 21+ cameras, 24 vCPU / 16 GB, **CPU-only (no GPU)**.

```
Detection Result → Attendance Event → Attendance Calculation → Attendance Record → Reports
```

This is the **healthy, cheap** stage. One real efficiency finding: the batch
recomputes **every active employee every tick**, even those with no new events.

---

## How attendance events are generated

Attendance is **decoupled from capture**. The bridge is
`_emit_attendance_detection_events` (UC2/UC3 matching stage): for each matched
`(clip, employee)` it writes one `detection_events` row at the best-crop
timestamp. **Live capture no longer writes events directly** — all
attendance-relevant events originate from the clip pipeline's match step.

## How attendance is calculated

A periodic job turns events into attendance rows:

1. `recompute_today_all_tenants()` iterates `public.tenants`.
2. Per tenant, `_recompute_today_inner`:
   - loads tenant **timezone + weekend days + holidays** (once),
   - gets **active employees** for today (`active_employee_ids`, excludes
     future-joiners / post-relievers),
   - resolves each employee's **shift policy** via the P9/P10 cascade,
   - per employee: `events_for` (UTC→local) → **pure `engine.compute()`**
     (in/out/late/early-out/short-hours/overtime/absent) →
     `upsert_attendance` (`ON CONFLICT`).

The engine is **pure** (no DB/IO) — deterministic and unit-tested.

## Real-time or batch?

**Batch**, every `MAUGOOD_ATTENDANCE_RECOMPUTE_MINUTES = 15` → ≤15-min lag.
A single-employee/single-date path, `recompute_for(...)`, already exists and is
used by **request approvals** (P13) — the seed of an event-driven path.

## Worker / thread / resource model

| Dimension | Assessment |
| --- | --- |
| Worker | One APScheduler interval job, process-wide (`coalesce`). Reports = separate tick. |
| Thread | One scheduler thread; not per camera/tenant. |
| CPU | ✅✅ very low — SQL aggregation + pure arithmetic, once / 15 min. |
| Memory | ✅✅ low — per-employee events list, transient. No models/frames. |
| Database | `events_for` SELECT per employee + an upsert per employee, per tick. Scales with **employees × events/day**, not cameras. |

## Bottleneck / scaling

- **Bottleneck?** Essentially never on this hardware — the cheapest stage.
- **21+ cameras?** **Indifferent** — scales with **employee count**, not cameras.
- **Queue buildup?** **None** — periodic idempotent batch.
- **Shared globally:** the scheduler job + the stateless pure engine.
- **Scales with:** employee count (loop size) + events/day (query size). Not
  cameras, not clips.

---

## Five approaches compared

### Approach 1 — Current Batch Recompute
- Workflow: every 15 min, recompute today's row for **all active employees**.
- Worker: one scheduler job. CPU ✅✅. Memory ✅✅. DB: N SELECTs + N upserts/tick.
- Scalability: ✅ camera-independent; mild waste at large headcounts.
- +Simple; idempotent; **self-healing** (late/missed events absorbed next tick);
  no queue. −≤15-min lag; **recomputes unchanged employees** every tick.

### Approach 2 — Event-Driven
- Workflow: on each `detection_events` insert, call `recompute_for(emp, date)`.
- Worker: inline / small worker per event. CPU ⚠️ more frequent small
  recomputes. Memory ✅. DB: one employee's query+upsert per burst.
- Scalability: ✅ touches only **changed** employees; near-real-time.
- +Fresh dashboards; no wasted idle-employee recompute. −Needs
  **debounce/coalesce** to avoid thrash; **loses the self-healing sweep** if
  used alone.

### Approach 3 — Hybrid Event + Batch
- Workflow: event-driven `recompute_for` for freshness **+** 15-min sweep as
  backstop.
- Worker: event trigger + periodic job. CPU ✅ low. Memory ✅. DB: small
  targeted recomputes + one cheap sweep.
- Scalability: ✅✅ best balance.
- +Near-real-time **and** self-healing; minimal waste. −Two code paths (but
  `recompute_for` already exists).

### Approach 4 — Incremental Calculation
- Workflow: batch only recomputes employees with **new events since last run**
  (dirty-set / watermark).
- Worker: same scheduler, smarter scope. CPU ✅ cuts per-tick waste. Memory ✅.
  DB: fewer SELECTs/upserts.
- Scalability: ✅ better at large headcounts.
- +Removes "recompute everyone" waste. −Needs dirty-tracking; still batch
  latency unless combined with event triggers.

### Approach 5 — Streaming / Event Bus (Kafka/Flink CEP)
- Workflow: events stream continuously into a stateful processor maintaining
  attendance live.
- Worker: stream operators. CPU ❌ heavy infra. Memory ❌ stateful. DB: sink.
- Scalability: ✅✅✅ web-scale / multi-site.
- +Real-time, massive scale. −**Massive over-engineering for one office**; new
  infra to run.

### Side-by-side

| | Worker | CPU | Memory | DB | Scalability | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 1 Batch recompute (current) | 1 job | ✅✅ | ✅✅ | N/tick | ✅ | correct, mild waste |
| 2 Event-driven | per-event | ⚠️ frequent | ✅ | targeted | ✅ | fresh, needs debounce |
| 3 Hybrid event+batch | trigger + job | ✅ | ✅ | small + sweep | ✅✅ | **best fit** |
| 4 Incremental batch | smarter job | ✅ | ✅ | fewer | ✅ | good waste-cutter |
| 5 Streaming bus | operators | ❌ | ❌ | sink | ✅✅✅ | over-engineering |

---

## Best approach for CPU-only

**Approach 3 (Hybrid)** — a small step from today. Fire `recompute_for(emp,
date)` from the **attendance fan-out** (where the match step already emits the
event), **debounced per (employee, day)** so a burst of crops doesn't thrash;
keep the **15-min sweep as the idempotent self-healing backstop**. Optionally
fold in **Approach 4** by making the sweep recompute only **dirty employees** to
cut the "recompute everyone" cost at large headcounts.

**Skip Approach 5** — streaming infra is the wrong scale for single-site
attendance.

## Unnecessary processing / duplicate work / optimization opportunities

1. **Recomputes every active employee every tick**, even with no new events —
   wasteful at large headcounts. **Fix:** dirty-set/watermark (Approach 4) or
   rely on event-driven (Approach 3).
2. **≤15-min freshness gap** — **fix:** call the existing `recompute_for` inline
   at event emission (debounced) for near-real-time, without removing the sweep.
3. **`events_for` is one query per employee per tick** — at large headcounts,
   batch into a single `GROUP BY employee` query.
4. **Index `detection_events(tenant_id, employee_id, captured_at)`** so
   `events_for` stays fast as the table grows (also helps the event-driven path).
5. **No duplication or model cost** — genuinely healthy; don't over-invest. The
   pure engine + idempotent upsert design is correct and should stay.

**Net:** Stage 6 is **not** a bottleneck and is well-architected (pure engine,
idempotent, camera-count-independent). The only real efficiency lever is **stop
recomputing unchanged employees** — best done with **event-driven
`recompute_for` at fan-out + a dirty-scoped sweep**, which also yields
near-real-time attendance. Leave everything else alone.

---

## Cross-references

- Live feed / RTSP: `docs/architecture/live-feed-options.md`.
- Detection models + lock: `docs/architecture/stage2-detection-models.md`.
- Clip recording / saving: `docs/architecture/stage3-clip-recording.md`.
- UC1 processing: `docs/architecture/stage4-uc1-processing.md`.
- UC2 processing: `docs/architecture/stage5-uc2-processing.md`.
- Scheduler + recompute: `backend/maugood/attendance/scheduler.py`.
- Pure engine + repository: `backend/maugood/attendance/{engine,repository}.py`.
- Attendance engine rules: `attendance-engine` skill.
