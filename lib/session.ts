// Session primitive. Imported by BOTH the auth routes and the proxy (proxy.ts), so this
// module uses ONLY Web-standard APIs (crypto.subtle, btoa/atob, TextEncoder). No
// node:crypto, no bcryptjs (bcrypt lives in lib/auth.ts, never imported here).
//
// CRITICAL: KEEP THIS FILE FREE OF RUNTIME IMPORTS, with one exception: lib/mode.ts,
// which is itself import-free. Any other runtime import that pulls in a Node module
// (bcryptjs, node:crypto, fs) would poison the proxy bundle and break auth at deploy
// time. If a helper is needed only on the server, put it in lib/auth.ts instead.
//
// The session cookie holds an opaque, server-signed token:
// base64url(payload).base64url(HMAC-SHA256). The payload carries an issued-at, an
// expiry and a fingerprint of the current password hash. The signing key is
// SESSION_SECRET and nothing else (SPEC R18). The cookie never contains the
// password hash.
//
// Every function takes the environment as its last argument (default: the real one),
// so the unit tests pass their own and never touch process.env.

import type { MemberId } from "./members";
import { SESSION_SECRET_MIN_LENGTH } from "./mode";

type Env = Record<string, string | undefined>;

export const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days, in seconds
// Version 2 added the password fingerprint. Version 1 tokens are refused.
const TOKEN_VERSION = 2;

/**
 * The one description of the session cookie, so its name and its flags cannot drift
 * apart. Spread it and add the value: `{ ...sessionCookieOptions(), value: token }`.
 *
 * Everywhere except the dev server and tests the cookie carries the `__Host-` name
 * prefix: the browser then accepts it only over HTTPS, with Path=/ and no Domain, so
 * another site on a shared parent domain cannot plant or overwrite it. The prefix
 * needs HTTPS, so plain http (dev, tests) uses the bare name. An unknown NODE_ENV
 * gets the strict form.
 */
export function sessionCookieOptions(env: Env = process.env) {
  const local = env.NODE_ENV === "development" || env.NODE_ENV === "test";
  return {
    name: local ? "app_session" : "__Host-app_session",
    httpOnly: true, // Not readable from page scripts.
    secure: !local,
    sameSite: "strict" as const, // Never sent on a request started by another site.
    maxAge: COOKIE_MAX_AGE,
    path: "/",
  };
}

export const COOKIE_NAME = sessionCookieOptions().name;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The stored SITE_PASSWORD_HASH as a raw bcrypt hash, or null when it is not one. */
function parseHash(raw: string | undefined | null): string | null {
  const v = raw?.trim();
  if (!v) return null;
  // A real bcrypt hash starts with $2a$/$2b$/$2y$. Base64 never contains `$`.
  if (v.startsWith("$2")) return v;
  try {
    const decoded = atob(v);
    if (decoded.startsWith("$2")) return decoded;
  } catch {
    // not valid base64: fall through
  }
  return null;
}

/**
 * Decode the stored SITE_PASSWORD_HASH into a raw bcrypt hash string.
 *
 * Why base64: env loaders (`@next/env` / dotenv-expand) treat `$` as a variable
 * reference and expand it, which corrupts a raw bcrypt hash and makes login
 * return 401. A base64-encoded hash (alphabet [A-Za-z0-9+/=], which contains NO
 * `$`) passes through the loader untouched, with no manual escaping.
 *
 * A raw `$2...` hash is also accepted as-is.
 */
export function decodeHash(raw: string | undefined | null): string | null {
  const v = raw?.trim();
  if (!v) return null;
  const hash = parseHash(v);
  if (hash) return hash;
  // Neither a raw $2 hash nor base64-of-one: hand it back untouched so a
  // genuine misconfig fails closed at bcrypt.compare (401), never crashes. Warn
  // (NAME only, never the value) so a typo'd hash is debuggable instead of
  // presenting as an unexplained, permanent "Invalid password".
  console.warn(
    "[app] SITE_PASSWORD_HASH is neither a raw $2 bcrypt hash nor base64 of one; login will fail until it is fixed.",
  );
  return v;
}

/**
 * The HMAC signing key for session tokens: SESSION_SECRET, 32 or more characters,
 * and nothing else (SPEC R18). There is no fallback to the password hash: a hash
 * ends up in logs and screenshots, so it must never sign a session. Missing or
 * short returns null, and every caller fails closed on null in every environment.
 */
export function getSessionKey(env: Env = process.env): string | null {
  const secret = env.SESSION_SECRET;
  return secret && secret.length >= SESSION_SECRET_MIN_LENGTH ? secret : null;
}

// -- base64url helpers (binary-safe) -------------------------------------------
function bytesToB64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function strToB64Url(str: string): string {
  return bytesToB64Url(encoder.encode(str));
}

// Throws on input that is not base64. The return type is left to inference on
// purpose: it is the exact array type crypto.subtle accepts.
function b64UrlToBytes(b64url: string) {
  const binary = atob(b64url.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function b64UrlToStr(b64url: string): string {
  return decoder.decode(b64UrlToBytes(b64url));
}

function importHmacKey(key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function hmacSign(key: string, data: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    "HMAC",
    await importHmacKey(key),
    encoder.encode(data),
  );
  return bytesToB64Url(new Uint8Array(sig));
}

/**
 * Check a base64url HMAC. The comparison runs inside crypto.subtle.verify, which
 * is constant time. A signature that is not in the one canonical spelling
 * (padding, stray bits) is refused, so a token has exactly one accepted form.
 * Throws on a signature that is not base64; the caller catches that.
 */
async function hmacVerify(
  key: string,
  data: string,
  signature: string,
): Promise<boolean> {
  const bytes = b64UrlToBytes(signature);
  if (bytesToB64Url(bytes) !== signature) return false;
  return crypto.subtle.verify(
    "HMAC",
    await importHmacKey(key),
    bytes,
    encoder.encode(data),
  );
}

/** Constant-time equality for two short strings of the same kind. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++)
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/**
 * A short keyed fingerprint of the current password hash. Every token carries it
 * and every check compares it, so changing the password ends every session at
 * once. Keyed with the session key, so the cookie reveals nothing about the hash.
 * Null when no usable hash is configured: then no session can exist.
 */
async function passwordFingerprint(
  key: string,
  env: Env,
): Promise<string | null> {
  const hash = parseHash(env.SITE_PASSWORD_HASH);
  if (!hash) return null;
  return (await hmacSign(key, `pw:${hash}`)).slice(0, 16);
}

export interface SessionPayload {
  v: number;
  iat: number; // issued-at, seconds
  exp: number; // expiry, seconds
  pw: string; // fingerprint of the password hash this session was opened under
  // Absent until a member id has been chosen on this session. Every reader
  // must treat undefined as "not yet identified" and never assume it is set.
  person?: MemberId;
}

/**
 * Mint a signed session token. Called by /api/auth on a correct password
 * (no opts: fresh iat/exp, no member id) and by /api/identity when a member
 * id is chosen for an already-logged-in device (member id set, iat PRESERVED
 * from the original token so re-identifying never extends the 30-day
 * session). Returns null when there is no signing key or no password hash:
 * callers answer with a misconfiguration error, never with a session.
 */
export async function createSessionToken(
  opts?: { person?: MemberId; iat?: number },
  env: Env = process.env,
): Promise<string | null> {
  const key = getSessionKey(env);
  if (!key) return null;
  const pw = await passwordFingerprint(key, env);
  if (!pw) return null;
  const iat = opts?.iat ?? Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    v: TOKEN_VERSION,
    iat,
    exp: iat + COOKIE_MAX_AGE,
    pw,
    ...(opts?.person ? { person: opts.person } : {}),
  };
  const payloadB64 = strToB64Url(JSON.stringify(payload));
  const sig = await hmacSign(key, payloadB64);
  return `${payloadB64}.${sig}`;
}

/**
 * Verify + decode a session token in one pass: signature first, then version,
 * expiry and the password fingerprint. Returns the payload on success, null on
 * any malformed, forged, expired or outdated token, and never throws. The single
 * source of truth both verifySessionToken (boolean) and decodeSessionPayload
 * (payload) call, so the token format is defined once.
 */
async function verifyAndDecode(
  token: string | undefined | null,
  env: Env,
): Promise<SessionPayload | null> {
  if (!token) return null;
  const key = getSessionKey(env);
  if (!key) return null;

  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  try {
    // Nothing in the payload is read before the signature has passed.
    if (!(await hmacVerify(key, payloadB64, providedSig))) return null;

    const payload: unknown = JSON.parse(b64UrlToStr(payloadB64));
    if (typeof payload !== "object" || payload === null) return null;
    const p = payload as Partial<SessionPayload>;
    if (p.v !== TOKEN_VERSION) return null;
    if (typeof p.iat !== "number" || typeof p.exp !== "number") return null;
    if (Math.floor(Date.now() / 1000) >= p.exp) return null;

    const pw = await passwordFingerprint(key, env);
    if (!pw || typeof p.pw !== "string" || !timingSafeEqual(p.pw, pw))
      return null;
    return p as SessionPayload;
  } catch {
    return null;
  }
}

/**
 * Verify a session token. Pure boolean: any malformed/forged/expired token
 * returns false, never throws.
 */
export async function verifySessionToken(
  token: string | undefined | null,
  env: Env = process.env,
): Promise<boolean> {
  return (await verifyAndDecode(token, env)) !== null;
}

/**
 * Verify + return the decoded payload (including `person`, if set). Used by
 * routes that need to know WHO is asking, not just whether the request is
 * authenticated. Same verification as verifySessionToken: never trust a
 * payload that has not passed signature + expiry checks.
 */
export async function decodeSessionPayload(
  token: string | undefined | null,
  env: Env = process.env,
): Promise<SessionPayload | null> {
  return verifyAndDecode(token, env);
}
