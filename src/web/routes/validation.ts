/**
 * Parses an HTML checkbox form field: present-and-`'on'` means checked, anything else
 * (absent, unchecked, or a repeated field arriving as an array) means unchecked.
 */
export function parseCheckboxField(value: string | string[] | undefined): boolean {
  return !Array.isArray(value) && value === 'on';
}

/**
 * Parse a positive integer id form field. A repeated field (arriving as an array) is
 * rejected rather than silently taking the first value, so a duplicated/tampered id
 * can't slip past validation — mirrors `parsePositiveBigIntId`.
 */
export function parsePositiveIntId(value: string | string[] | undefined): number | null {
  if (Array.isArray(value)) return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Parse a positive BIGINT id form field directly to `bigint`, avoiding precision loss above
 * `Number.MAX_SAFE_INTEGER`. A repeated field (arriving as an array) is rejected rather than
 * silently taking the first value, so a duplicated/tampered id can't slip past validation.
 */
export function parsePositiveBigIntId(value: string | string[] | undefined): bigint | null {
  if (Array.isArray(value)) return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed > 0n ? parsed : null;
}

/**
 * Parse a weight form field into a positive integer ≥ 1 (floored), or null when
 * the value is missing, non-numeric, not positive, or an array (repeated field).
 * Rejecting arrays is consistent with `parsePositiveIntId` — a duplicated weight
 * field can't slip through silently.
 * @param raw - Raw value from a form field.
 * @returns A positive integer weight, or null when invalid.
 */
export function parseWeight(raw: string | string[] | undefined): number | null {
  if (Array.isArray(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.floor(n);
}

/**
 * Returns `value` trimmed if it is a string, or an empty string otherwise.
 * @param value - Any value from a form or request body.
 * @returns Trimmed string, or `''` for non-string inputs.
 */
export function trimField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Trims `value` and returns it if non-empty, or `null` if blank/missing.
 * @param value - Raw string from a form field.
 * @returns Non-empty trimmed string, or `null`.
 */
export function normalizeRequiredText(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Allowlist regex for valid trigger strings (e.g. `!clap`, `!my-cmd_1`).
 * Permits an optional single-char prefix (`!`, `?`, `#`, `@`), then one alphanumeric
 * character, followed by zero or more alphanumeric, underscore, or hyphen characters.
 * Rejects HTML-special characters such as `<`, `>`, `&`, and `"`.
 */
const TRIGGER_RE = /^[!?#@]?[a-z0-9][a-z0-9_-]*$/;

/**
 * Normalizes a required single-word (no whitespace) text field to lowercase and
 * validates it against the trigger-name allowlist (`TRIGGER_RE`).
 * Returns `null` if the value is blank, contains whitespace, or contains characters
 * outside the safe allowlist (e.g. HTML-special chars like `<`, `>`, `&`, `"`).
 * @param value - Raw string from a form field.
 * @returns Lowercased, allowlist-validated single-token string, or `null`.
 */
export function normalizeSingleTokenRequiredText(value: string | undefined): string | null {
  const normalized = normalizeRequiredText(value);
  if (!normalized || /\s/.test(normalized)) return null;
  const lower = normalized.toLowerCase();
  return TRIGGER_RE.test(lower) ? lower : null;
}

/**
 * Validates and returns a Discord snowflake ID (17–20 digits), or `null` if invalid.
 * @param value - Raw string from a form field.
 * @returns The trimmed snowflake string, or `null`.
 */
export function normalizeDiscordId(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\d{17,20}$/.test(trimmed) ? trimmed : null;
}

/**
 * Returns `value` if it is a string present in `allowed`, otherwise `null`.
 * Used to sanitize query parameters against an explicit allowlist.
 * @param value - Raw query parameter value.
 * @param allowed - Set of permitted string values.
 * @returns The matched string, or `null`.
 */
export function filterQueryParam(value: unknown, allowed: ReadonlySet<string>): string | null {
  return typeof value === 'string' && allowed.has(value) ? value : null;
}

/**
 * Returns true if `redirectUri` is a loopback HTTP URL (127.0.0.1 or localhost,
 * any port). Per RFC 8252 §7.3, only loopback redirects are accepted for the
 * companion app's OAuth flow — anything else risks leaking the authorization
 * code to an attacker-controlled host.
 * @param redirectUri - The redirect URI string to validate.
 * @returns Whether the URI is a permitted loopback redirect target.
 */
export function isLoopbackRedirectUri(redirectUri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
}

/**
 * Regex for a Twitch custom reward's UUID (v1–v5, RFC 4122 variant), used to validate
 * `:twitchRewardId` route params and reward-id form fields.
 */
const REWARD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Extracts and validates a Twitch reward UUID.
 * @param value - The `:twitchRewardId` route param or form field value.
 * @returns The validated UUID, or null if malformed or repeated (an array value).
 */
export function parseRewardIdParam(value: string | string[]): string | null {
  if (Array.isArray(value)) return null;
  return REWARD_ID_RE.test(value) ? value : null;
}
