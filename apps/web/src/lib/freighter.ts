import {
  requestAccess as freighterRequestAccess,
  signMessage as freighterSignMessage,
} from '@stellar/freighter-api';

type FreighterResponse<T> =
  | T
  | {
      error?: string;
      address?: string;
      publicKey?: string;
      signedMessage?: string;
      signature?: string;
    };

function readString(value: unknown, keys: string[]) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;

  for (const key of keys) {
    const maybe = (value as Record<string, unknown>)[key];
    if (typeof maybe === 'string') return maybe;
  }

  return undefined;
}

export async function requestWalletAccess() {
  const response = (await freighterRequestAccess()) as FreighterResponse<string>;
  const publicKey = readString(response, ['address', 'publicKey']);

  if (!publicKey) {
    throw new Error('Unable to read Freighter public key');
  }

  return publicKey;
}

export async function signWalletMessage(message: string, address?: string) {
  const response = (await freighterSignMessage(
    message,
    address ? { address } : undefined,
  )) as FreighterResponse<string>;
  const signature = readString(response, ['signedMessage', 'signature']);

  if (!signature) {
    throw new Error('Unable to sign Freighter message');
  }

  return signature;
}
