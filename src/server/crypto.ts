import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scryptSync } from 'node:crypto';

/**
 * Secrets at rest (provider passwords, indexer API keys): AES-256-GCM under a key derived from
 * SAGA_SECRET_KEY, which lives only in the VM's .env. Stored as "v1:<iv>:<tag>:<ciphertext>" (base64).
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(secretKey: string) {
    this.key = Buffer.from(hkdfSync('sha256', Buffer.from(secretKey), Buffer.alloc(0), Buffer.from('saga-secrets-v1'), 32));
  }

  seal(plain: string): string {
    return seal(this.key, plain);
  }

  open(sealed: string): string {
    return open(this.key, sealed);
  }
}

function seal(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

function open(key: Buffer, sealed: string): string {
  const [v, iv, tag, ct] = sealed.split(':');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unrecognised secret format');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

/** Passphrase-encrypted backup export (independent of SAGA_SECRET_KEY, so it survives a lost .env). */
export function sealWithPassphrase(passphrase: string, plain: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `saga-export-v1:${salt.toString('base64')}:${seal(key, plain)}`;
}

export function openWithPassphrase(passphrase: string, blob: string): string {
  const m = blob.match(/^saga-export-v1:([^:]+):(v1:.+)$/);
  if (!m) throw new Error('Not a Saga export');
  const key = scryptSync(passphrase, Buffer.from(m[1]!, 'base64'), 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return open(key, m[2]!);
}
