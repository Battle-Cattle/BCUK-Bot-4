/**
 * Reads the token from an `Authorization: Bearer <token>` header. The scheme name is matched
 * case-insensitively, as RFC 9110 §11.1 requires (`bearer`, `BEARER`), and spaces around the token
 * are allowed. Shared by the Bearer-token auth middleware and the Stream Deck limiter's key, so the
 * two always agree on which token a request carries (#923).
 * @param header - The raw `Authorization` header, if any.
 * @returns The token, or null for a missing header, another scheme, or no token.
 */
export function parseBearerToken(header: string | undefined): string | null {
  const match = /^\s*bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return match?.[1] ?? null;
}
