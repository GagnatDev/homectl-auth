import { describe, it, expect } from 'vitest';
import { randomBytes } from 'crypto';
import { seal, open, type Session } from '../session';

const KEY = randomBytes(32);

const SAMPLE: Session = {
  refreshToken: 'refresh-abc',
  accessToken: 'header.payload.sig',
  accessExp: 1_800_000_000,
  sub: 'user-1',
  email: 'user@example.com',
  role: 'editor',
};

describe('session cookie seal/open', () => {
  it('round-trips a session', () => {
    const sealed = seal(SAMPLE, KEY);
    expect(sealed.split('.')).toHaveLength(3);
    expect(open(sealed, KEY)).toEqual(SAMPLE);
  });

  it('round-trips a null role', () => {
    const s = { ...SAMPLE, role: null };
    expect(open(seal(s, KEY), KEY)).toEqual(s);
  });

  it('returns null for undefined / empty input', () => {
    expect(open(undefined, KEY)).toBeNull();
    expect(open('', KEY)).toBeNull();
  });

  it('returns null for a malformed value', () => {
    expect(open('not-a-cookie', KEY)).toBeNull();
    expect(open('a.b', KEY)).toBeNull();
  });

  it('rejects a tampered body (GCM auth tag mismatch)', () => {
    const sealed = seal(SAMPLE, KEY);
    const [iv, tag, body] = sealed.split('.');
    const flipped = Buffer.from(body!, 'base64url');
    flipped[0] = flipped[0]! ^ 0xff;
    const tampered = [iv, tag, flipped.toString('base64url')].join('.');
    expect(open(tampered, KEY)).toBeNull();
  });

  it('rejects a value sealed with a different key', () => {
    const sealed = seal(SAMPLE, KEY);
    expect(open(sealed, randomBytes(32))).toBeNull();
  });
});
