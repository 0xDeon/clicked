/**
 * Tests for MLS epoch visibility (#372).
 *
 * The property under test: a device reads exactly the epochs its leaf existed
 * for, and everything else comes back as a placeholder rather than as an error
 * or as ciphertext it cannot decrypt.
 */

import { describe, it, expect } from 'vitest';
import {
  MLS_UNAVAILABLE_AFTER_REMOVAL,
  MLS_UNAVAILABLE_BEFORE_JOIN,
  MLS_UNAVAILABLE_NOT_A_MEMBER,
  applyMlsVisibility,
  mlsUnavailableReason,
} from '../lib/mlsVisibility.js';

describe('mlsUnavailableReason', () => {
  it('allows the exact epoch a device joined at', () => {
    expect(mlsUnavailableReason(5, { joinedAtEpoch: 5, removedAtEpoch: null })).toBeNull();
  });

  it('allows every epoch after the join', () => {
    expect(mlsUnavailableReason(9, { joinedAtEpoch: 5, removedAtEpoch: null })).toBeNull();
  });

  it('rejects the epoch immediately before the join', () => {
    expect(mlsUnavailableReason(4, { joinedAtEpoch: 5, removedAtEpoch: null })).toBe(
      MLS_UNAVAILABLE_BEFORE_JOIN,
    );
  });

  it('allows the last epoch before removal', () => {
    expect(mlsUnavailableReason(7, { joinedAtEpoch: 2, removedAtEpoch: 8 })).toBeNull();
  });

  it('rejects the removal epoch itself', () => {
    // The commit that removes a device rekeys the group, so the epoch it
    // produces is already out of reach.
    expect(mlsUnavailableReason(8, { joinedAtEpoch: 2, removedAtEpoch: 8 })).toBe(
      MLS_UNAVAILABLE_AFTER_REMOVAL,
    );
  });

  it('rejects epochs after removal', () => {
    expect(mlsUnavailableReason(12, { joinedAtEpoch: 2, removedAtEpoch: 8 })).toBe(
      MLS_UNAVAILABLE_AFTER_REMOVAL,
    );
  });

  it('rejects everything for a device with no leaf in the group', () => {
    expect(mlsUnavailableReason(0, null)).toBe(MLS_UNAVAILABLE_NOT_A_MEMBER);
    expect(mlsUnavailableReason(99, null)).toBe(MLS_UNAVAILABLE_NOT_A_MEMBER);
  });
});

describe('applyMlsVisibility', () => {
  const window = { joinedAtEpoch: 5, removedAtEpoch: null };

  it('passes non-MLS messages through untouched', () => {
    const message = { id: 'm1', mlsEpoch: null, ciphertext: 'dm-ciphertext' };

    expect(applyMlsVisibility(message, window)).toBe(message);
  });

  it('passes messages inside the window through untouched', () => {
    const message = { id: 'm1', mlsEpoch: 6, ciphertext: 'group-ciphertext' };

    expect(applyMlsVisibility(message, window)).toBe(message);
  });

  it('blanks the ciphertext of a pre-join message and explains why', () => {
    const message = { id: 'm1', mlsEpoch: 2, ciphertext: 'group-ciphertext' };

    const result = applyMlsVisibility(message, window);

    expect(result.ciphertext).toBeNull();
    expect(result.unavailable).toBe(true);
    expect(result.unavailableReason).toBe(MLS_UNAVAILABLE_BEFORE_JOIN);
  });

  it('preserves ordering metadata so the client can render a placeholder in place', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const message = {
      id: 'm1',
      mlsEpoch: 2,
      ciphertext: 'group-ciphertext',
      senderId: 'user-9',
      createdAt,
    };

    const result = applyMlsVisibility(message, window);

    expect(result.id).toBe('m1');
    expect(result.senderId).toBe('user-9');
    expect(result.createdAt).toBe(createdAt);
    expect(result.mlsEpoch).toBe(2);
  });

  it('empties the envelopes array when one is present', () => {
    const message = { id: 'm1', mlsEpoch: 2, ciphertext: 'c', envelopes: [{ ciphertext: 'e' }] };

    expect(applyMlsVisibility(message, window).envelopes).toEqual([]);
  });

  it('does not add an envelopes key to messages that never had one', () => {
    const message = { id: 'm1', mlsEpoch: 2, ciphertext: 'c' };

    expect('envelopes' in applyMlsVisibility(message, window)).toBe(false);
  });

  it('marks every MLS message unavailable for a device with no leaf', () => {
    const message = { id: 'm1', mlsEpoch: 42, ciphertext: 'group-ciphertext' };

    const result = applyMlsVisibility(message, null);

    expect(result.ciphertext).toBeNull();
    expect(result.unavailableReason).toBe(MLS_UNAVAILABLE_NOT_A_MEMBER);
  });

  it('does not mutate the input message', () => {
    const message = { id: 'm1', mlsEpoch: 2, ciphertext: 'group-ciphertext' };

    applyMlsVisibility(message, window);

    expect(message.ciphertext).toBe('group-ciphertext');
  });
});
