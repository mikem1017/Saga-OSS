import { describe, expect, it } from 'vitest';
import { SecretBox, sealWithPassphrase, openWithPassphrase } from '../src/server/crypto.ts';

describe('secrets at rest', () => {
  it('round-trips and never stores plaintext', () => {
    const box = new SecretBox('k'.repeat(44));
    const sealed = box.seal('hunter2-usenet');
    expect(sealed).not.toContain('hunter2');
    expect(box.open(sealed)).toBe('hunter2-usenet');
    expect(box.seal('x')).not.toBe(box.seal('x'));
  });
  it('rejects a different key and tampering', () => {
    const sealed = new SecretBox('a'.repeat(44)).seal('secret');
    expect(() => new SecretBox('b'.repeat(44)).open(sealed)).toThrow();
    const parts = sealed.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => new SecretBox('a'.repeat(44)).open(parts.join(':'))).toThrow();
  });
  it('passphrase exports', () => {
    const blob = sealWithPassphrase('correct horse battery', '{"a":1}');
    expect(openWithPassphrase('correct horse battery', blob)).toBe('{"a":1}');
    expect(() => openWithPassphrase('wrong passphrase!!', blob)).toThrow();
  });
});
