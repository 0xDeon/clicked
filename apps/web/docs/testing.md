# Web app test setup

This documents how tests are configured and run in `apps/web`, and the
recurring patterns used for IndexedDB, WebCrypto, and network/socket code.

## Runner config

`apps/web/vitest.config.ts`:

```ts
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
```

- **environment: `node`** — tests run without jsdom/happy-dom. There is no
  real DOM, `window`, or browser IndexedDB; anything DOM-shaped a test needs
  has to be faked explicitly (see below).
- **include: `src/**/*.test.ts`** — only `.test.ts` files under `src/` are
  picked up (not `.test.tsx`, so component tests aren't part of this glob
  today).
- **setupFiles**: `./src/test/setup.ts` runs once before the test files load.

### `src/test/setup.ts`

```ts
import { webcrypto } from 'node:crypto';

// polyfill window/self as aliases for globalThis (environment: 'node' has neither)
if (!('window' in globalScope)) { ... globalScope.window = globalThis ... }
if (!('self' in globalScope)) { ... globalScope.self = globalThis ... }

// polyfill WebCrypto using Node's native implementation
if (!globalScope.crypto) { ... globalScope.crypto = webcrypto ... }

// polyfill base64 helpers Node doesn't have globally
if (typeof globalScope.btoa !== 'function') { ... }
if (typeof globalScope.atob !== 'function') { ... }
```

It installs four things, each guarded so it only patches what's missing:
`window`/`self` as aliases for `globalThis`, `globalThis.crypto` from
`node:crypto`'s `webcrypto` export, and `btoa`/`atob` shims backed by
`Buffer`. This is what lets browser-shaped crypto and encoding code
(`crypto.subtle...`, `btoa(...)`) run unmodified under Node.

### Running tests

Root test script (`apps/web/package.json`): `"test": "vitest run"`.

To run the whole web suite:

```sh
pnpm --filter web test
```

To run a single file, pass the path through to the Vitest CLI:

```sh
pnpm --filter web test -- src/lib/crypto.test.ts
# or, from apps/web directly:
pnpm vitest run src/lib/crypto.test.ts
```

## IndexedDB: fake-indexeddb and resetting between tests

Modules under `src/lib/search/` (`db.ts`, used by `db.test.ts` and
`searchIntegration.test.ts`) persist to a real IndexedDB API, which doesn't
exist in the Node test environment. Those test files import
`'fake-indexeddb/auto'`, which installs an in-memory IndexedDB implementation
onto the global scope before anything else in the file runs:

```ts
// apps/web/src/lib/search/db.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { putMessages, getAllMessages, getMessagesByConversation, clearAll } from './db';

describe('Local Encrypted Message Cache (#357)', () => {
  beforeEach(async () => {
    await clearAll();
  });
  ...
});
```

`fake-indexeddb/auto` gives every test file in the process the same
in-memory database — it is **not** reset automatically between test cases.
Both `db.test.ts` and `searchIntegration.test.ts` call the module's own
`clearAll()` in `beforeEach` to wipe stored records before each test runs.

`identity-persistence.test.ts` (`src/lib/__tests__/identity-persistence.test.ts`)
follows the same shape against a different store (`cryptoStore`, which wraps
`idb`), clearing both before *and* after each test, and also closing the DB
handle:

```ts
describe('Identity Key Persistence (Fixed)', () => {
  beforeEach(async () => {
    await cryptoStore.clear();
  });

  afterEach(async () => {
    await cryptoStore.clear();
    cryptoStore.closeDb();
  });
  ...
});
```

**Why resetting matters**: these stores hold identity/ECDH key material
(`cryptoStore`) and decrypted message plaintext cached at rest
(`search/db.ts`). Because `fake-indexeddb` persists in memory for the life
of the test process (not per-file or per-test), a private key generated or
a message cached in one test would otherwise still be present — and
readable — in the next test case, silently changing its inputs and letting
key material or plaintext leak across unrelated tests. `db.test.ts` even has
a dedicated test asserting the raw stored record contains no `plaintext`
field, which only means something if the store was empty going in.

## WebCrypto: real Node webcrypto, round-trip as the assertion

Vitest's `environment: 'node'` has no browser `crypto.subtle`. `setup.ts`
gives every test `globalThis.crypto = require('node:crypto').webcrypto`, so
crypto code under test runs against a real, spec-compliant WebCrypto
implementation rather than a mock — no algorithm behavior is faked.

`crypto.test.ts` additionally stubs it explicitly per test (defensive
against other tests mutating globals via `vi.stubGlobal`):

```ts
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('atob', (value: string) => Buffer.from(value, 'base64').toString('binary'));
  vi.stubGlobal('btoa', (value: string) => Buffer.from(value, 'binary').toString('base64'));
});
```

The tests' meaningful assertion is not "the function didn't throw" — it's a
full round trip: encrypt with the code under test, then independently
decrypt (often with a hand-rolled decryptor using the same primitives) and
assert the recovered plaintext equals the original:

```ts
// apps/web/src/lib/crypto.test.ts
it('round-trips a message for a single recipient without a backend', async () => {
  const recipient = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey'],
  );
  const recipientPublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', recipient.publicKey));

  const ciphertext = await sealedBoxEncrypt('hello from clicked', bytesToB64(recipientPublicKey));
  const plaintext = await decryptSealedBox(ciphertext, recipient.privateKey);

  expect(plaintext).toBe('hello from clicked');
  expect(b64ToBytes(ciphertext).length).toBeGreaterThan(77);
});
```

`signalClient.test.ts` uses the same principle at a higher level: instead of
decrypting, it asserts on protocol properties that only hold if the
underlying Double Ratchet/X3DH math is correct — e.g. the same plaintext
encrypted twice to the same device must produce different ciphertext
(`c1).not.toBe(c2)`, ratchet advanced), and a session that fails to
configure must reject rather than silently produce bad ciphertext.

## Socket client: no dedicated mock today

The socket client lives at `apps/web/src/lib/socket.ts`
(`import { io, Socket } from 'socket.io-client'`) and is consumed by
`useSocket.ts`, `useMessageHistory.ts`, `useInboundPipeline.ts`,
`realtime.ts`, and `MessageThread.tsx`. As of this writing there is **no**
`*.test.ts` file for `socket.ts`/`useSocket.ts`, and no `vi.mock('socket.io-client', ...)`
anywhere in `apps/web/src` — the `include` glob (`src/**/*.test.ts`) also
excludes `.tsx` component tests entirely, so `MessageThread.tsx` isn't
exercised by this suite either.

If/when a socket-dependent unit is tested, the established codebase pattern
for isolating a real dependency is `vi.mock` combined with a fake
implementation swapped in via `vi.stubGlobal`/dependency injection — see
`signalClient.test.ts`, which avoids network/IO entirely by injecting a
`FetchKeyBundle` function (`configureSignalClient({ myIdentity, fetchKeyBundle })`)
instead of hitting a real backend, and `usePushSubscription.test.ts`, which
stubs `fetch` globally rather than mocking a client module:

```ts
// apps/web/src/hooks/usePushSubscription.test.ts
function mockFetchOnce(response: { ok: boolean; json: () => Promise<unknown> }) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response as unknown as Response));
}
```

A `socket.io-client` mock would follow the same shape: `vi.mock('socket.io-client', () => ({ io: vi.fn(() => fakeSocket) }))`
where `fakeSocket` is a minimal `{ on, off, emit, connect, disconnect }`
object the test controls — but that pattern does not exist in this codebase
yet, so nothing here should be taken as an existing, working example.

Similarly, **`usePushSubscription.test.ts` does not exercise
`navigator.serviceWorker`** — it only covers `fetchVapidPublicKey()`, a
plain `fetch` wrapper, via `vi.stubGlobal('fetch', ...)`. There is no
existing fake for `navigator.serviceWorker.register(...)` in this suite;
`environment: 'node'` means `navigator` isn't defined at all unless a test
polyfills it itself.
