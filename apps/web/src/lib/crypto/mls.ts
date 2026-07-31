/**
 * Client-side MLS group coordination.
 *
 * This module owns only client state. The backend receives the returned
 * Welcome bytes as an opaque message envelope and never receives a group
 * secret, epoch state, or membership state.
 */

export const MLS_WELCOME_CONTENT_TYPE = 'application/mls-welcome' as const;
export const MLS_WELCOME_EVENT = 'mls_welcome' as const;

export type KeyPackage = {
  deviceId: string;
  userId: string;
  keyPackage: Uint8Array;
};

export type MlsGroupState = {
  groupId: Uint8Array;
  epoch: number;
  members: ReadonlySet<string>;
};

export type MlsWelcome = {
  groupId: Uint8Array;
  epoch: number;
  ciphertext: Uint8Array;
};

/**
 * The MLS implementation is supplied by the client crypto provider. Keeping
 * this boundary explicit prevents accidental server-side group state and
 * allows the web application to use a standards-compliant MLS implementation
 * without changing the delivery protocol.
 */
export interface MlsProvider {
  createGroup(creator: KeyPackage): Promise<{
    groupId: Uint8Array;
    epoch: number;
    members: string[];
  }>;
  addMembers(
    group: MlsGroupState,
    keyPackages: readonly KeyPackage[],
  ): Promise<{
    epoch: number;
    welcome: Uint8Array;
    members: string[];
  }>;
  processWelcome(welcome: Uint8Array): Promise<{
    groupId: Uint8Array;
    epoch: number;
    members: string[];
  }>;
}

function copyBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function toState(value: {
  groupId: Uint8Array;
  epoch: number;
  members: readonly string[];
}): MlsGroupState {
  return {
    groupId: copyBytes(value.groupId),
    epoch: value.epoch,
    members: new Set(value.members),
  };
}

/** Create a new MLS group locally. No network or backend call is made. */
export async function createMlsGroup(
  provider: MlsProvider,
  creator: KeyPackage,
): Promise<MlsGroupState> {
  return toState(await provider.createGroup(creator));
}

/**
 * Add members locally and return the opaque Welcome to distribute to their
 * devices. The returned state is the post-commit state and must be retained
 * by the creating client only.
 */
export async function addMlsMembers(
  provider: MlsProvider,
  group: MlsGroupState,
  keyPackages: readonly KeyPackage[],
): Promise<{ state: MlsGroupState; welcome: MlsWelcome }> {
  if (keyPackages.length === 0) {
    throw new Error('At least one key package is required');
  }

  const result = await provider.addMembers(group, keyPackages);
  const state = toState({
    groupId: group.groupId,
    epoch: result.epoch,
    members: result.members,
  });

  return {
    state,
    welcome: {
      groupId: copyBytes(group.groupId),
      epoch: result.epoch,
      ciphertext: copyBytes(result.welcome),
    },
  };
}

/** Process a Welcome on the receiving client and return its joined epoch. */
export async function joinMlsGroup(
  provider: MlsProvider,
  welcome: Uint8Array,
): Promise<MlsGroupState> {
  return toState(await provider.processWelcome(copyBytes(welcome)));
}

/** Build the typed transport payload used by the existing message pipeline. */
export function toMlsWelcomeMessage(welcome: MlsWelcome): {
  contentType: typeof MLS_WELCOME_CONTENT_TYPE;
  ciphertext: string;
  epoch: number;
} {
  let binary = '';
  for (const byte of welcome.ciphertext) binary += String.fromCharCode(byte);

  return {
    contentType: MLS_WELCOME_CONTENT_TYPE,
    ciphertext: btoa(binary),
    epoch: welcome.epoch,
  };
}
