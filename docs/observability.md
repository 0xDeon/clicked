# Observability (#393)

Metrics are exported Prometheus-style from every backend instance at
`GET /metrics` (`apps/backend/src/lib/metrics.ts`, registered in `app.ts`).
Structured logs go through `apps/backend/src/lib/logger.ts` (pino), which
redacts `ciphertext`, `envelopes`, `payload`, and `plaintext` fields as a
backstop — call sites must never pass message content as a log field or
metric label in the first place.

## Metrics reference

| Metric | Type | Labels | What it tells you |
|---|---|---|---|
| `clicked_messages_persisted_total` | counter | `contentType` | Messages/sec persisted, by type |
| `clicked_fanout_size` | histogram | – | Recipient devices per persisted message |
| `clicked_envelope_insert_duration_seconds` | histogram | – | DB write latency for envelope batch inserts |
| `clicked_delivery_latency_seconds` | histogram | – | Time from persistence to socket emit |
| `clicked_prekey_consumed_total` | counter | – | One-time prekeys claimed for new sessions |
| `clicked_push_result_total` | counter | `result` (`sent`\|`pruned`\|`backoff`) | Web Push outcomes |
| `clicked_presence_churn_total` | counter | `transition` (`online`\|`offline`) | Presence state transitions |
| `clicked_backpressure_events_total` | counter | `action` (`shed`\|`disconnect`) | Slow-consumer interventions |
| `clicked_connected_sockets` | gauge | – | Live sockets on this instance |

Default Node process/runtime metrics (`collectDefaultMetrics`) are included
under the standard `process_*`/`nodejs_*` names for CPU, memory, and event
loop lag.

## Dashboards

Four dashboards, one per area named in the issue. Panels reference the
metrics table above; build in whatever Prometheus-compatible tool the
deployment uses (Grafana, etc.) — panel list is the contract, not a specific
tool config.

**Delivery**
- Messages persisted/sec (`rate(clicked_messages_persisted_total[5m])`)
- Fan-out size distribution (`clicked_fanout_size` heatmap)
- Envelope insert latency p50/p95/p99
- Delivery latency p50/p95/p99
- Backpressure events/min, split by action

**Keys**
- Prekey consumption rate (`rate(clicked_prekey_consumed_total[5m])`)
- Alert when consumption rate implies a device's one-time prekey pool
  (capped, see `apps/backend/src/routes/devices.ts` `OTP_CAP`) will exhaust
  faster than clients typically re-upload

**Push**
- Push results/sec by outcome (`rate(clicked_push_result_total[5m])` by `result`)
- Prune rate vs. sent rate (rising prune rate signals stale subscriptions
  accumulating faster than clients refresh them)

**Presence**
- Connected sockets per instance (`clicked_connected_sockets`)
- Presence churn/min by transition (reconnect storm shows as a churn spike
  with no corresponding drop in `clicked_connected_sockets`)

## What is deliberately not exported

No metric or log line ever takes ciphertext, envelope contents, plaintext,
or user-supplied free text as a value or label — see the threat model
(`docs/threat-model.md`) for what the server can and cannot see. Content
types, counts, and durations only.

Cross-referenced from [`IMPLEMENTATION_DOCS.md`](../IMPLEMENTATION_DOCS.md).
