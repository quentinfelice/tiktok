// Studia Poster: encrypted token file for environments without a private disk (GitHub Actions).
// AES-256-GCM with a key derived by scrypt from STUDIA_TOKEN_KEY. The file is safe to commit; the key is not.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { readJson, writeJson } from './config.mjs';

export const TOKEN_KEY_MIN = 16;
const VERSION = 1;

export function assertTokenKey(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < TOKEN_KEY_MIN) {
    throw new Error(`STUDIA_TOKEN_KEY must be at least ${TOKEN_KEY_MIN} characters`);
  }
  return passphrase;
}

function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
}

/** Returns a JSON-serialisable envelope: { v, alg, kdf, salt, iv, tag, data } (all base64). */
export function encryptJson(obj, passphrase) {
  assertTokenKey(passphrase);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return {
    v: VERSION,
    alg: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

/** Inverse of encryptJson. Throws on a wrong key or a tampered file (GCM auth tag). */
export function decryptJson(envelope, passphrase) {
  assertTokenKey(passphrase);
  if (!envelope || envelope.v !== VERSION || envelope.alg !== 'aes-256-gcm') {
    throw new Error('Unsupported token file format');
  }
  const salt = Buffer.from(envelope.salt, 'base64');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(passphrase, salt),
    Buffer.from(envelope.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  let text;
  try {
    text = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    throw new Error('Cannot decrypt the token file: wrong STUDIA_TOKEN_KEY or corrupted file');
  }
  return JSON.parse(text);
}

/** Reads and decrypts `file`; null when the file does not exist. */
export function readEncrypted(file, passphrase) {
  const envelope = readJson(file, null);
  return envelope ? decryptJson(envelope, passphrase) : null;
}

export function writeEncrypted(file, obj, passphrase) {
  writeJson(file, encryptJson(obj, passphrase));
}
