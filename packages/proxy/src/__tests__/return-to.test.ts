import { describe, it, expect } from 'vitest';
import { sanitizeReturnTo } from '../return-to';

describe('sanitizeReturnTo', () => {
  it('allows same-origin relative paths', () => {
    expect(sanitizeReturnTo('/')).toBe('/');
    expect(sanitizeReturnTo('/dashboard')).toBe('/dashboard');
    expect(sanitizeReturnTo('/a/b?c=d&e=f')).toBe('/a/b?c=d&e=f');
    expect(sanitizeReturnTo('/path#frag')).toBe('/path#frag');
  });

  it('collapses missing / non-string input to /', () => {
    expect(sanitizeReturnTo(undefined)).toBe('/');
    expect(sanitizeReturnTo(null)).toBe('/');
    expect(sanitizeReturnTo('')).toBe('/');
  });

  it('rejects absolute URLs', () => {
    expect(sanitizeReturnTo('https://evil.com/x')).toBe('/');
    expect(sanitizeReturnTo('http://evil.com')).toBe('/');
    expect(sanitizeReturnTo('javascript:alert(1)')).toBe('/');
  });

  it('rejects protocol-relative and backslash tricks', () => {
    expect(sanitizeReturnTo('//evil.com')).toBe('/');
    expect(sanitizeReturnTo('/\\evil.com')).toBe('/');
    expect(sanitizeReturnTo('/\\/evil.com')).toBe('/');
    expect(sanitizeReturnTo('/foo\\bar')).toBe('/');
  });

  it('rejects paths that do not start with a slash', () => {
    expect(sanitizeReturnTo('evil.com')).toBe('/');
    expect(sanitizeReturnTo('dashboard')).toBe('/');
  });

  it('rejects control characters and embedded schemes', () => {
    expect(sanitizeReturnTo('/foo\nbar')).toBe('/');
    expect(sanitizeReturnTo('/redirect?u=http://evil.com')).toBe('/');
  });
});
