# Maugood — observability stack

Production deployments ship a Prometheus + Grafana +
Alertmanager trio alongside the FastAPI app. Prometheus
scrapes ``backend:8000/metrics`` every 15 s; Grafana renders
the dashboards Omran IT watches; Alertmanager fans alerts
out to a webhook + an Admin email.

The stack is internal-only — `/metrics` is **never** proxied
by nginx (`ops/nginx/maugood.conf.template` doesn't list it),
and Prometheus + Alertmanager bind only on the private
``maugood-internal`` docker network. Grafana is the only
component exposed off-host, gated by an operator-set admin
password.

## What the backend emits

Out of the box (via ``prometheus-fastapi-instrumentator``):

| Metric                                         | Type      |
| ---------------------------------------------- | --------- |
| ``http_request_duration_seconds_bucket``       | histogram |
| ``http_requests_total``                        | counter   |
| Process / GC / fd / mem standard collectors    | various   |

P26 custom metrics (``backend/maugood/metrics.py``):

| Metric                                       | Type    | Labels                       | What it counts                                                          |
| -------------------------------------------- | ------- | ---------------------------- | ----------------------------------------------------------------------- |
| ``maugood_capture_frames_total``               | counter | tenant, camera               | Frames pulled from a camera and offered to the analyzer.                |
| ``maugood_detection_events_total``             | counter | tenant, identified           | One per detection-event row written; ``identified`` is "true"/"false".  |
| ``maugood_camera_reachable``                   | gauge   | tenant, camera               | 1 when the latest health snapshot was reachable, 0 otherwise.            |
| ``maugood_attendance_records_computed_total``  | counter | tenant                       | Increments by the number of attendance rows the recompute job upserts. |
| ``maugood_scheduler_jobs_failed_total``        | counter | tenant, job                  | Bumps on every APScheduler ``EVENT_JOB_ERROR``.                         |
| ``maugood_email_send_total``                   | counter | tenant, provider, status     | One per email send attempt; ``status`` ∈ {sent, failed, skipped_*}.    |
| ``maugood_active_sessions``                    | gauge   | tenant                       | Non-expired ``user_sessions`` rows; refreshed on the 30 s worker tick.  |

**PDPL red line**: every label value is opaque (numeric ids,
provider names, status enums). No employee names, no email
addresses, no faces. If a future phase needs per-employee
metrics, attach the numeric ``employee_id`` — never the name.

## Where /metrics is reachable

* **Inside the docker network** (Prometheus → backend):
  `http://backend:8000/metrics`. Always available.
* **From the host in dev**: `http://localhost:8000/metrics`
  because the dev compose maps backend's :8000.
* **From the public internet in production**: NEVER.
  ``ops/nginx/maugood.conf.template`` proxies ``/api/`` only.
  ``/metrics`` is on the same FastAPI app but lives outside
  the proxy's location block so it 404s for any request that
  comes in over nginx. Prometheus scrapes the backend
  directly on ``maugood-internal``.

## Compose layout

Two ways to run the observability stack:

* **Production** — `docker-compose.prod.yml` ships
  `prometheus`, `alertmanager`, and `grafana` services
  alongside the rest of the stack. Prometheus + Alertmanager
  are not exposed off-host; Grafana is on
  ``${MAUGOOD_GRAFANA_PORT:-3000}``. TSDB volume
  ``prometheus_data`` retains 30 days by default
  (configurable via Prometheus' ``--storage.tsdb.retention.time``).
* **Dev** — `docker-compose.observability.yml` is an overlay
  that brings the same three services up alongside the dev
  stack with :9090 + :9093 + :3000 all exposed off-host so
  operators can poke at PromQL and edit dashboards.

```sh
# Dev verification.
docker compose \
  -f docker-compose.yml \
  -f docker-compose.observability.yml \
  up -d prometheus grafana alertmanager
```

## Provisioning

Grafana auto-loads its datasource + dashboards on first
boot:

* `deploy/grafana/provisioning/datasources/prometheus.yml`
  declares the Prometheus datasource as the default.
* `deploy/grafana/provisioning/dashboards/maugood.yml` declares
  the Maugood dashboard provider.
* `deploy/grafana/dashboards/maugood.json` is the dashboard
  source-of-truth — operators editing in the UI should export
  back into this file rather than persisting the change in
  Grafana's DB. ``allowUiUpdates: false`` in the provider
  enforces the workflow.

## Dashboards

`Maugood → Maugood — Operations` (uid `maugood-ops`) ships seven
panels:

1. **Capture rate per camera** — ``rate(maugood_capture_frames_total[1m])``.
   Walking past a camera ticks this at ~4 Hz; a quiet camera
   sits near 0.
2. **Identification rate (% events with employee_id)** —
   ratio of identified to total detection events per tenant
   over a 5-minute window. Baseline ~80% with well-enrolled
   photos; drops are a hint that someone's photo set has
   gone stale.
3. **Attendance records computed (per hour)** — bar chart of
   ``increase(maugood_attendance_records_computed_total[1h])``.
   The recompute scheduler fires every 15 minutes; expect 4
   ticks per hour times the active-employee headcount.
4. **Camera reachability matrix** — colour-coded stat panel
   reading the live ``maugood_camera_reachable`` gauge.
5. **HTTP latency p50/p95/p99** — quantiles over the
   instrumentator histogram. p99 above ~250 ms on the report
   endpoints is normal (PDF generation); anywhere else is a
   smell.
6. **Email delivery success rate** — sent / (sent + failed)
   over a 15-minute window per tenant.
7. **Active sessions** — ``maugood_active_sessions`` per
   tenant.

## Alerts

Four rules live in `deploy/prometheus/alerts.yml`:

| Alert                            | Severity | When                                                  |
| -------------------------------- | -------- | ----------------------------------------------------- |
| ``MaugoodCameraUnreachable``       | warning  | ``maugood_camera_reachable == 0`` for 5 minutes.       |
| ``MaugoodCaptureRateLow``          | warning  | Capture rate < 0.1 frames/sec while reachable=1, 10m. |
| ``MaugoodSchedulerJobFailing``     | critical | ≥ 3 failures of the same job inside 15 minutes.       |
| ``MaugoodEmailFailureRateHigh``    | warning  | > 10% of sends failed in the last hour.              |

Routing + delivery is in `deploy/alertmanager/alertmanager.yml`.
The receiver fans every alert to:

* a webhook at ``MAUGOOD_ALERTMANAGER_WEBHOOK_URL`` (Slack,
  PagerDuty, Microsoft Teams — operator's choice);
* the Admin email at ``MAUGOOD_ALERTMANAGER_ADMIN_EMAIL`` via
  the SMTP relay at ``MAUGOOD_ALERTMANAGER_SMTP_HOST``.

Either path can be left unset; the unset path is a no-op.
Production deploys with ONLY the email path see the same
alerts via inbox; deploys with ONLY the webhook see them in
their incident bus.

## Operator quickref

```sh
# Verify scrape target is up.
curl -s http://localhost:9090/api/v1/targets \
  | python3 -c 'import sys,json; print([(t["labels"]["job"], t["health"]) for t in json.load(sys.stdin)["data"]["activeTargets"]])'

# Inspect alert state.
curl -s http://localhost:9090/api/v1/alerts \
  | python3 -c 'import sys,json; [print(a["labels"]["alertname"], a["state"]) for a in json.load(sys.stdin)["data"]["alerts"]]'

# PromQL spot-check from the CLI.
curl -s -G http://localhost:9090/api/v1/query \
  --data-urlencode 'query=sum by (tenant) (rate(maugood_capture_frames_total[5m]))'

# Force-fire all custom metrics in dev (MAUGOOD_ENV=dev only).
curl -s -b $C -X POST http://localhost:8000/api/_test/tick_metrics \
  -H 'Content-Type: application/json' -d '{}'
```

## Red lines

* **/metrics is never on the public internet.** nginx in
  production does NOT proxy it. The dev port is
  loopback-bound on a developer's laptop.
* **Labels are opaque.** Tenant id, camera id, employee id —
  numeric only. PII never reaches a label.
* **Audit trail is the source of truth, not metrics.**
  Counters can be reset by a process restart; the database
  ``audit_log`` and the on-disk ``audit.log`` (P25) are the
  durable record. Use Prometheus for "is something
  happening?" and the audit log for "what exactly
  happened?".
