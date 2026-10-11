// Edge-safe session primitive. Imported by BOTH the Node auth route
// (app/api/auth/route.ts) and the edge middleware (proxy.ts), so this module
// must use ONLY Web-standard APIs (crypto.subtle, btoa/atob, TextEncoder). No
// node:crypto, no bcryptjs (bcrypt lives in lib/auth.ts, never imported here).
//
// CRITICAL: KEEP THIS FILE FREE OF RUNTIME IMPORTS. The only import allowed is
// a type-only import, which is erased at compile time. Any runtime import that
// transitively pulls a Node module (bcryptjs, node:crypto, fs) would poison the
// edge middleware bundle and break auth at deploy time. If a helper is needed
// only on the server, put it in lib/auth.ts instead.
//
// The session cookie holds an opaque, server-signed token:
// base64url(payload).base64url(HMAC). The payload carries an explicit issued-at
// and expiry, the HMAC is verified server-side (timing-safe), and the signing
// key is decoupled from the password (see getSessionKey). The cookie never
// contains the password hash.

import type { MemberId } from "./members";

export const COOKIE_NAME = "app_session";
export const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days, in seconds
const TOKEN_VERSION = 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
  if (!raw) return null;
  const v = raw.trim();
  if (!v) return null;
  // A real bcrypt hash starts with $2a$/$2b$/$2y$. Base64 never contains `$`.
  if (v.startsWith("$2")) return v;
  try {
    const decoded = atob(v);
    if (decoded.startsWith("$2")) return decoded;
  } catch {
    // not valid base64: fall through
  }
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
 * The HMAC signing key for session tokens.
 *
 * Prefers a dedicated SESSION_SECRET, which decouples sessions from the
 * password: rotating the password does not log anyone out, only rotating
 * SESSION_SECRET does. Falls back to the decoded password hash so the app works
 * with no additional required secret.
 *
 * Returns null only when NEITHER is configured, i.e. dev mode, where the proxy
 * allows requests through.
 */
export function getSessionKey(): string | null {
  const explicit = process.env.SESSION_SECRET;
  if (explicit && explicit.length >= 16) return explicit;
  return decodeHash(process.env.SITE_PASSWORD_HASH);
}

// -- base64url helpers (binary-safe, edge + node) -----------------------------
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

function b64UrlToStr(b64url: string): string {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return decoder.decode(bytes);
}

async function hmacSign(key: string, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
  return bytesToB64Url(new Uint8Array(sig));
}

/**
 * Constant-time string equality. crypto.subtle has no timingSafeEqual and
 * node:crypto is unavailable in middleware, so we XOR-accumulate. Both operands
 * are server-produced base64url HMACs of identical length on the happy path.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++)
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export interface SessionPayload {
  v: number;
  iat: number; // issued-at, seconds
  exp: number; // expiry, seconds
  // Absent until a member id has been chosen on this session. Every reader
  // must treat undefined as "not yet identified" and never assume it is set.
  person?: MemberId;
}

/**
 * Mint a signed session token. Called by /api/auth on a correct password
 * (no args: fresh iat/exp, no member id) and by /api/identity when a member
 * id is chosen for an already-logged-in device (member id set, iat PRESERVED
 * from the original token so re-identifying never extends the 30-day
 * session). Returns null only if no signing key is configured (dev mode).
 */
export async function createSessionToken(opts?: {
  person?: MemberId;
  iat?: number;
}): Promise<string | null> {
  const key = getSessionKey();
  if (!key) return null;
  const iat = opts?.iat ?? Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    v: TOKEN_VERSION,
    iat,
    exp: iat + COOKIE_MAX_AGE,
    ...(opts?.person ? { person: opts.person } : {}),
  };
  const payloadB64 = strToB64Url(JSON.stringify(payload));
  const sig = await hmacSign(key, payloadB64);
  return `${payloadB64}.${sig}`;
}

/**
 * Verify + decode a session token in one pass: signature (timing-safe) +
 * version + not-expired. Returns the payload on success, null on any
 * malformed/forged/expired token, and never throws. The single source of truth
 * both verifySessionToken (boolean) and decodeSessionPayload (payload) call,
 * so the token format is defined once.
 */
async function verifyAndDecode(
  token: string | undefined | null,
): Promise<SessionPayload | null> {
  if (!token) return null;
  const key = getSessionKey();
  if (!key) return null;

  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  let expectedSig: string;
  try {
    expectedSig = await hmacSign(key, payloadB64);
  } catch {
    return null;
  }
  if (!timingSafeEqual(providedSig, expectedSig)) return null;

  try {
    const payload = JSON.parse(b64UrlToStr(payloadB64)) as SessionPayload;
    if (payload.v !== TOKEN_VERSION) return null;
    if (typeof payload.exp !== "number") return null;
    if (Math.floor(Date.now() / 1000) >= payload.exp) return null;
    return payload;
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
): Promise<boolean> {
  return (await verifyAndDecode(token)) !== null;
}

/**
 * Verify + return the decoded payload (including `person`, if set). Used by
 * routes that need to know WHO is asking, not just whether the request is
 * authenticated. Same verification as verifySessionToken: never trust a
 * payload that has not passed signature + expiry checks.
 */
export async function decodeSessionPayload(
  token: string | undefined | null,
): Promise<SessionPayload | null> {
  return verifyAndDecode(token);
}
