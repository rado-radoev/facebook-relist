// Password hashing for Relist app accounts, built on node:crypto scrypt.
//
// Why scrypt and not argon2: scrypt ships with Node itself, so there is no
// native module to compile in the Docker image, and it is a memory-hard KDF
// designed for password storage. Parameters (N=16384, r=8, p=1) follow the
// OWASP cheat sheet for scrypt. Stored format:
//   scrypt:N:r:p:<salt base64>:<derived key base64>

import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 5;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const MAX_PASSWORD_BYTES = 1024;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export async function hashPassword(password: string): Promise<string> {
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    throw new Error(`Password exceeds the ${MAX_PASSWORD_BYTES}-byte maximum`);
  }
  const salt = randomBytes(SALT_LENGTH);
  const derived = (await scryptAsync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  })) as Buffer;
  const parts = [
    "scrypt",
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString("base64"),
    derived.toString("base64"),
  ];
  return parts.join(":");
}

function parseHash(stored: string): { n: number; r: number; p: number; salt: Buffer; expected: Buffer } | null {
  const parts = stored.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (!Number.isSafeInteger(n) || n < 2 || (n & (n - 1)) !== 0 || !Number.isSafeInteger(r) || r < 1 ||
      !Number.isSafeInteger(p) || p < 1 || n > SCRYPT_N || r > SCRYPT_R || p > SCRYPT_P) return null;
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (salt.length !== SALT_LENGTH || expected.length !== KEY_LENGTH) return null;
  return { n, r, p, salt, expected };
}

export function needsPasswordRehash(stored: string): boolean {
  const parsed = parseHash(stored);
  return !parsed || parsed.n !== SCRYPT_N || parsed.r !== SCRYPT_R || parsed.p !== SCRYPT_P;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) return false;
  const parsed = parseHash(stored);
  if (!parsed) return false;
  try {
    const derived = await scryptAsync(password, parsed.salt, parsed.expected.length, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
      maxmem: SCRYPT_MAXMEM,
    });
    return timingSafeEqual(derived, parsed.expected);
  } catch {
    return false;
  }
}
