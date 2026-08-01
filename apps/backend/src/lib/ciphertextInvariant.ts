export const FORBIDDEN_PERSISTED_OR_UPLOADED_FIELDS = [
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
] as const;

const normaliseFieldName = (field: string): string =>
  field.replace(/[-_]/g, '').toLowerCase();

const FORBIDDEN_NORMALISED_FIELDS = new Set(
  FORBIDDEN_PERSISTED_OR_UPLOADED_FIELDS.map(normaliseFieldName),
);

export function findForbiddenCiphertextFields(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return [];
  }

  return Object.keys(payload).filter((field) =>
    FORBIDDEN_NORMALISED_FIELDS.has(normaliseFieldName(field)),
  );
}

export function assertCiphertextOnlyPayload(payload: unknown): void {
  const forbiddenFields = findForbiddenCiphertextFields(payload);
  if (forbiddenFields.length > 0) {
    throw new Error(
      `Payload contains forbidden plaintext or secret fields: ${forbiddenFields.join(', ')}`,
    );
  }
}
