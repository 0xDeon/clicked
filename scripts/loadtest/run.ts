/**
 * WebSocket gateway load/soak test (#385).
 *
 * Connects every participant from the seeded fixture as a socket.io client,
 * split evenly across the node URLs passed in `--nodes` (comma-separated),
 * so the run exercises cross-instance fan-out via the Redis adapter. Then:
 *
 *   1. Fan-out: one sender emits `send_message`; every other device must
 *      receive `message_envelope`. Records end-to-end latency per receipt.
 *   2. Presence churn: a fraction of devices disconnect/reconnect on a
 *      short interval for the churn window.
 *   3. Reconnect storm: every device disconnects at once, then reconnects
 *      within a tight window, simulating a network blip.
 *
 * Peak RSS is sampled every second throughout. On completion, prints a JSON
 * result to stdout with p50/p95/p99 latency, peak memory, and error counts,
 * and exits non-zero if any threshold in `THRESHOLDS` is violated (or if a
 * baseline file is supplied via `--baseline` and this run regressed beyond
 * `REGRESSION_TOLERANCE`).
 *
 * Usage:
 *   tsx scripts/loadtest/run.ts --fixture fixture.json \
 *     --nodes http://localhost:3001,http://localhost:3002 \
 *     [--baseline scripts/loadtest/baseline.json] \
 *     [--out result.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { io as ioClient, type Socket } from 'socket.io-client';

interface Fixture {
  conversationId: string;
  participants: Array<{ userId: string; deviceId: string; token: string }>;
}

interface Thresholds {
  maxP95LatencyMs: number;
  maxP99LatencyMs: number;
  maxPeakRssMb: number;
  maxErrorRate: number;
}

const THRESHOLDS: Thresholds = {
  maxP95LatencyMs: 1500,
  maxP99LatencyMs: 3000,
  maxPeakRssMb: 1024,
  maxErrorRate: 0.01,
};

const REGRESSION_TOLERANCE = 1.25; // 25% worse than baseline fails the run

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function connectClient(url: string, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, { auth: { token }, transports: ['websocket'], reconnection: false });
    const timer = setTimeout(() => reject(new Error(`connect timeout: ${url}`)), 10_000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function main(): Promise<void> {
  const fixturePath = arg('fixture', 'fixture.json')!;
  const nodeUrls = (arg('nodes', 'http://localhost:3001') ?? '').split(',').filter(Boolean);
  const outPath = arg('out');
  const baselinePath = arg('baseline');

  const fixture: Fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));
  const { conversationId, participants } = fixture;

  let peakRssMb = 0;
  const memInterval = setInterval(() => {
    const rssMb = process.memoryUsage().rss / (1024 * 1024);
    if (rssMb > peakRssMb) peakRssMb = rssMb;
  }, 1000);

  const errors: string[] = [];

  console.error(`[loadtest] connecting ${participants.length} devices across ${nodeUrls.length} node(s)...`);
  const sockets = await Promise.all(
    participants.map((p, i) => connectClient(nodeUrls[i % nodeUrls.length]!, p.token)),
  );
  console.error('[loadtest] all devices connected');

  // ── 1. Fan-out latency ──────────────────────────────────────────────────
  const latenciesMs: number[] = [];
  const [sender, ...recipients] = sockets;
  const expectedReceipts = recipients.length;
  let receiptsSeen = 0;

  await new Promise<void>((resolve) => {
    const sentAt = new Map<string, number>();
    const done = () => resolve();
    const timer = setTimeout(done, 30_000);

    for (const socket of recipients) {
      socket.on('message_envelope', (payload: { messageId: string }) => {
        const start = sentAt.get(payload.messageId);
        if (start) {
          latenciesMs.push(Date.now() - start);
          receiptsSeen++;
          if (receiptsSeen >= expectedReceipts) {
            clearTimeout(timer);
            done();
          }
        }
      });
    }

    const messageId = randomUUID();
    sentAt.set(messageId, Date.now());
    sender!.emit('send_message', {
      conversationId,
      messageId,
      contentType: 'text',
      envelopes: recipients.map((_, i) => ({
        recipientDeviceId: participants[i + 1]!.deviceId,
        ciphertext: 'loadtest-ciphertext',
      })),
    });
  });

  if (receiptsSeen < expectedReceipts) {
    errors.push(`fanout: only ${receiptsSeen}/${expectedReceipts} devices received the message`);
  }
  console.error(`[loadtest] fan-out: ${receiptsSeen}/${expectedReceipts} delivered`);

  // ── 2. Presence churn: 20% of devices cycle disconnect/reconnect ───────
  console.error('[loadtest] presence churn window...');
  const churnCount = Math.max(1, Math.floor(sockets.length * 0.2));
  for (let round = 0; round < 3; round++) {
    const churners = sockets.slice(0, churnCount);
    for (const socket of churners) socket.disconnect();
    await new Promise((r) => setTimeout(r, 500));
    for (let i = 0; i < churners.length; i++) {
      try {
        const reconnected = await connectClient(nodeUrls[i % nodeUrls.length]!, participants[i]!.token);
        sockets[i] = reconnected;
      } catch (err) {
        errors.push(`churn reconnect failed: ${(err as Error).message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // ── 3. Reconnect storm: everyone drops, everyone reconnects at once ────
  console.error('[loadtest] reconnect storm...');
  for (const socket of sockets) socket.disconnect();
  await new Promise((r) => setTimeout(r, 200));

  const stormResults = await Promise.allSettled(
    participants.map((p, i) => connectClient(nodeUrls[i % nodeUrls.length]!, p.token)),
  );
  const stormFailures = stormResults.filter((r) => r.status === 'rejected').length;
  if (stormFailures > 0) {
    errors.push(`reconnect storm: ${stormFailures}/${participants.length} devices failed to reconnect`);
  }
  console.error(`[loadtest] reconnect storm: ${participants.length - stormFailures}/${participants.length} reconnected`);

  for (const result of stormResults) {
    if (result.status === 'fulfilled') result.value.disconnect();
  }

  clearInterval(memInterval);

  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const summary = {
    deviceCount: participants.length,
    nodeCount: nodeUrls.length,
    fanoutDelivered: receiptsSeen,
    fanoutExpected: expectedReceipts,
    latencyMs: {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
    },
    peakRssMb: Math.round(peakRssMb),
    errorCount: errors.length,
    errorRate: errors.length / (participants.length * 4), // rough denominator across all phases
    errors,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (outPath) writeFileSync(outPath, JSON.stringify(summary, null, 2));

  // ── Threshold + regression enforcement ──────────────────────────────────
  let failed = false;
  if (summary.latencyMs.p95 > THRESHOLDS.maxP95LatencyMs) {
    console.error(`FAIL: p95 latency ${summary.latencyMs.p95}ms > ${THRESHOLDS.maxP95LatencyMs}ms`);
    failed = true;
  }
  if (summary.latencyMs.p99 > THRESHOLDS.maxP99LatencyMs) {
    console.error(`FAIL: p99 latency ${summary.latencyMs.p99}ms > ${THRESHOLDS.maxP99LatencyMs}ms`);
    failed = true;
  }
  if (summary.peakRssMb > THRESHOLDS.maxPeakRssMb) {
    console.error(`FAIL: peak RSS ${summary.peakRssMb}MB > ${THRESHOLDS.maxPeakRssMb}MB`);
    failed = true;
  }
  if (summary.errorRate > THRESHOLDS.maxErrorRate) {
    console.error(`FAIL: error rate ${summary.errorRate} > ${THRESHOLDS.maxErrorRate}`);
    failed = true;
  }

  if (baselinePath) {
    try {
      const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
      if (summary.latencyMs.p95 > baseline.latencyMs.p95 * REGRESSION_TOLERANCE) {
        console.error(
          `FAIL: p95 latency regressed >25% vs baseline (${summary.latencyMs.p95}ms vs ${baseline.latencyMs.p95}ms)`,
        );
        failed = true;
      }
      if (summary.peakRssMb > baseline.peakRssMb * REGRESSION_TOLERANCE) {
        console.error(
          `FAIL: peak memory regressed >25% vs baseline (${summary.peakRssMb}MB vs ${baseline.peakRssMb}MB)`,
        );
        failed = true;
      }
    } catch (err) {
      console.error(`[loadtest] no usable baseline at ${baselinePath}, skipping regression check:`, err);
    }
  }

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('[loadtest] fatal:', err);
  process.exit(1);
});
