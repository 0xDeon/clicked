import { webcrypto } from 'node:crypto';

const globalScope = globalThis as Record<string, unknown> & typeof globalThis;

if (!('window' in globalScope)) {
  Object.defineProperty(globalScope, 'window', {
    configurable: true,
    value: globalThis,
  });
}

if (!('self' in globalScope)) {
  Object.defineProperty(globalScope, 'self', {
    configurable: true,
    value: globalThis,
  });
}

if (!globalScope.crypto) {
  Object.defineProperty(globalScope, 'crypto', {
    configurable: true,
    value: webcrypto,
  });
}

if (typeof globalScope.btoa !== 'function') {
  Object.defineProperty(globalScope, 'btoa', {
    configurable: true,
    value: (value: string) => Buffer.from(value, 'binary').toString('base64'),
  });
}

if (typeof globalScope.atob !== 'function') {
  Object.defineProperty(globalScope, 'atob', {
    configurable: true,
    value: (value: string) => Buffer.from(value, 'base64').toString('binary'),
  });
}
