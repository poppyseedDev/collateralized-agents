import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/** Shared-secret checks for API routes. Compares SHA-256 digests so length and content don't leak through timing. */

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time string comparison. False when either side is empty. */
export function safeEqual(given: string | null | undefined, expected: string | null | undefined): boolean {
  if (!given || !expected) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

/** The token from an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/** True when the request carries `Authorization: Bearer <secret>` and the secret is configured. */
export function hasBearer(req: Request, secret: string | undefined): boolean {
  return safeEqual(bearerToken(req), secret);
}
