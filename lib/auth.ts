import "server-only"; // bcryptjs is Node-only; this guarantees a build error
// if lib/auth.ts is ever imported into a client or edge (middleware) bundle.
import bcrypt from "bcryptjs";
import { decodeHash } from "@/lib/session";

// SITE_PASSWORD_HASH is the bcrypt hash of the shared password (cost factor 12,
// OWASP-recommended). It is the only secret needed for password verification;
// the plaintext password is never read on the server.
//
// Store it base64-encoded. Next's env loader expands `$` in a raw
// `$2b$...` hash, which corrupts it and makes login return 401. base64
// (alphabet [A-Za-z0-9+/=]) contains no `$`, so it survives the loader with no
// manual escaping. `decodeHash` accepts both base64 and a raw `$2...` hash.
//
// Generate the value to set in the environment:
//   node -e "const b=require('bcryptjs');console.log(Buffer.from(b.hashSync(process.argv[1],12)).toString('base64'))" 'your-password'
// Encode an existing raw hash (no password needed):
//   node -e "console.log(Buffer.from(process.argv[1]).toString('base64'))" '$2b$12$...'

export async function verifyPassword(
  submitted: string,
  storedHash: string,
): Promise<boolean> {
  const hash = decodeHash(storedHash);
  if (!hash) return false;
  return bcrypt.compare(submitted, hash);
}

// Cookie name/lifetime live in the edge-safe session module so the auth route
// and the middleware share one source of truth.
export { COOKIE_NAME, COOKIE_MAX_AGE } from "@/lib/session";
