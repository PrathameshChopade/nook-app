import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEYLEN = 64;

// scrypt from Node's standard library rather than argon2 or bcrypt. Both of
// those are native modules: they need a build toolchain in the image, which
// works against the multi-stage, no-compiler final layer we want in stage 05.
// scrypt is memory-hard, in the standard library, and needs no toolchain.
// If a security review later demands argon2id, that is an ADR and a rebuild,
// not a surprise.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEYLEN);
  return `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;

  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, salt, expected.length);

  // Constant-time: a length-varying or short-circuiting comparison leaks the
  // hash one byte at a time to anyone who can measure response times.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
