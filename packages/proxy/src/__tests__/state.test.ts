import { describe, it, expect } from 'vitest';
import { randomBytes } from 'crypto';
import { signState, verifyState, newNonce } from '../state';

const KEY = randomBytes(32);

describe('state cookie sign/verify', () => {
  it('round-trips a payload', () => {
    const payload = { nonce: newNonce(), returnTo: '/dashboard' };
    const signed = signState(payload, KEY);
    expect(verifyState(signed, KEY)).toEqual(payload);
  });

  it('returns null for undefined / malformed input', () => {
    expect(verifyState(undefined, KEY)).toBeNull();
    expect(verifyState('nodot', KEY)).toBeNull();
    expect(verifyState('a.b.c', KEY)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const signed = signState({ nonce: 'n', returnTo: '/' }, KEY);
    const [b64] = signed.split('.');
    expect(verifyState(`${b64}.deadbeef`, KEY)).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const signed = signState({ nonce: 'n', returnTo: '/' }, KEY);
    const [, sig] = signed.split('.');
    const forged = Buffer.from(JSON.stringify({ nonce: 'evil', returnTo: '/' })).toString(
      'base64url',
    );
    expect(verifyState(`${forged}.${sig}`, KEY)).toBeNull();
  });

  it('rejects a value signed with a different key', () => {
    const signed = signState({ nonce: 'n', returnTo: '/' }, KEY);
    expect(verifyState(signed, randomBytes(32))).toBeNull();
  });

  it('newNonce returns distinct values', () => {
    expect(newNonce()).not.toBe(newNonce());
  });
});
