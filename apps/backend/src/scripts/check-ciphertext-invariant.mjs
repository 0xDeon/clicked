import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('src');
const invariantFile = path.resolve('src/lib/ciphertextInvariant.ts');
const forbidden = [
  'content',
  'body',
  'plaintext',
  'identityPrivateKey',
  'identity_private_key',
  'privateKey',
  'private_key',
  'sessionKey',
  'sessionKeys',
  'session_key',
  'session_keys',
  'mlsSecret',
  'mlsSecrets',
  'mls_secret',
  'mls_secrets',
  'messageKey',
  'messageKeys',
  'message_key',
  'message_keys',
  'ratchetState',
  'ratchet_state',
];

function filesUnder(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(file));
    else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) result.push(file);
  }
  return result;
}

const violations = [];
const keyPattern = (field) => new RegExp(`(?:["']${field}["']|\\b${field}\\b)\\s*:`, 'm');

for (const file of filesUnder(root)) {
  if (path.resolve(file) === invariantFile || file.includes(`${path.sep}__tests__${path.sep}`)) continue;
  const source = fs.readFileSync(file, 'utf8');
  for (const field of forbidden) {
    if (keyPattern(field).test(source)) {
      violations.push(`${path.relative(process.cwd(), file)} contains forbidden field '${field}'`);
    }
  }
}

if (violations.length > 0) {
  console.error('Ciphertext-only invariant failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log('Ciphertext-only invariant passed.');
