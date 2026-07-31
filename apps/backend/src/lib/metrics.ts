/**
 * Prometheus metrics for the encrypted delivery pipeline (#393).
 *
 * Hard rule: no metric here ever takes message content, ciphertext, or any
 * user-identifying free-text as a label or value. Labels are limited to
 * closed enums (contentType, result, reason) and counts/durations.
 */
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const messagesPersistedTotal = new Counter({
  name: 'clicked_messages_persisted_total',
  help: 'Messages persisted to the database, by content type',
  labelNames: ['contentType'] as const,
  registers: [registry],
});

export const fanoutSize = new Histogram({
  name: 'clicked_fanout_size',
  help: 'Number of recipient devices a persisted message was fanned out to',
  buckets: [0, 1, 2, 5, 10, 25, 50, 100, 250],
  registers: [registry],
});

export const envelopeInsertDuration = new Histogram({
  name: 'clicked_envelope_insert_duration_seconds',
  help: 'Time to insert per-recipient message envelopes',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

export const deliveryLatency = new Histogram({
  name: 'clicked_delivery_latency_seconds',
  help: 'Time from message persistence to envelope emit on the socket',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const prekeyConsumedTotal = new Counter({
  name: 'clicked_prekey_consumed_total',
  help: 'One-time prekeys consumed for new sessions',
  registers: [registry],
});

export const pushResultTotal = new Counter({
  name: 'clicked_push_result_total',
  help: 'Web Push send attempts, by result',
  labelNames: ['result'] as const, // 'sent' | 'pruned' | 'backoff'
  registers: [registry],
});

export const presenceChurnTotal = new Counter({
  name: 'clicked_presence_churn_total',
  help: 'Presence transitions (online/offline)',
  labelNames: ['transition'] as const, // 'online' | 'offline'
  registers: [registry],
});

export const backpressureEventsTotal = new Counter({
  name: 'clicked_backpressure_events_total',
  help: 'Socket backpressure events, by action taken',
  labelNames: ['action'] as const, // 'shed' | 'disconnect'
  registers: [registry],
});

export const connectedSockets = new Gauge({
  name: 'clicked_connected_sockets',
  help: 'Currently connected sockets on this gateway instance',
  registers: [registry],
});
