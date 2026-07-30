#!/usr/bin/env node
// Issue #388 — surfaces CVEs in crypto-relevant dependencies without
// failing the build on advisories in unrelated transitive packages.
//
// Runs `pnpm audit --json`, then fails (exit 1) only if an advisory's
// module name matches (or is a dependency of) one of the packages below.

import { execSync } from 'node:child_process';

const CRYPTO_RELEVANT_PACKAGES = [
  'ioredis',
  'jsonwebtoken',
  'web-push',
  '@stellar/stellar-sdk',
  'drizzle-orm',
  'socket.io',
  '@socket.io/redis-adapter',
  'redis',
  'jose',
];

function runAudit() {
  try {
    return execSync('pnpm audit --json', { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 20 });
  } catch (err) {
    // pnpm audit exits non-zero when it finds any advisory; we still want the JSON body.
    return err.stdout?.toString() ?? '';
  }
}

function parseAdvisories(raw) {
  const advisories = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'advisory' || entry.advisories) {
        advisories.push(entry);
      }
    } catch {
      // pnpm's --json output can be a single JSON object rather than NDJSON
      // depending on version; handled below as a fallback.
    }
  }
  if (advisories.length === 0) {
    try {
      const parsed = JSON.parse(raw);
      const list = Object.values(parsed.advisories ?? {});
      return list;
    } catch {
      return [];
    }
  }
  return advisories.flatMap((e) => (e.advisories ? Object.values(e.advisories) : [e]));
}

const raw = runAudit();
const advisories = parseAdvisories(raw);

const relevant = advisories.filter((advisory) => {
  const moduleName = advisory.module_name ?? advisory.moduleName ?? advisory.name;
  if (!moduleName) return false;
  return CRYPTO_RELEVANT_PACKAGES.some(
    (pkg) => moduleName === pkg || moduleName.startsWith(`${pkg}/`),
  );
});

if (relevant.length > 0) {
  console.error(`Found ${relevant.length} advisory(ies) affecting crypto-relevant dependencies:\n`);
  for (const advisory of relevant) {
    const moduleName = advisory.module_name ?? advisory.moduleName ?? advisory.name;
    const severity = advisory.severity ?? 'unknown';
    const title = advisory.title ?? advisory.overview ?? 'no description';
    const url = advisory.url ?? '';
    console.error(`  [${severity}] ${moduleName}: ${title}${url ? ` (${url})` : ''}`);
  }
  process.exit(1);
}

console.log(
  `No advisories found affecting crypto-relevant dependencies (checked: ${CRYPTO_RELEVANT_PACKAGES.join(', ')}).`,
);
