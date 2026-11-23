/** Strategy for handling `{key}` placeholders with no matching entry in `vars`. */
export type FillTemplateFallback = 'empty' | 'keep';

const PLACEHOLDER_PATTERN = /\{(\w+)\}/g;

/**
 * Substitutes `{key}` placeholders in `template` with values from `vars`.
 * Unknown placeholders (keys not present in `vars`) are handled per `fallback`:
 * `'empty'` (the default) replaces them with an empty string; `'keep'` leaves the
 * literal `{key}` text in place, which is useful for template-editor previews
 * where a leftover placeholder should stay visible as a hint of a typo. Only `vars`' own
 * keys count: an inherited `Object.prototype` name such as `{constructor}` or `{toString}`
 * is an unknown placeholder, not a lookup that renders a function's source into chat.
 *
 * @param template - Template string containing zero or more `{key}` placeholders.
 * @param vars - Map of placeholder names to their substitution values.
 * @param fallback - How to handle placeholders with no matching key in `vars`. Defaults to `'empty'`.
 * @returns The template with all placeholders substituted.
 */
export function fillTemplate(
  template: string,
  vars: Record<string, string>,
  fallback: FillTemplateFallback = 'empty',
): string {
  return template.replace(PLACEHOLDER_PATTERN, (match, k: string) => resolvePlaceholder(match, k, vars, fallback));
}

/**
 * The text one `{key}` placeholder is replaced with, per {@link fillTemplate}'s rules.
 * @param match - The placeholder as written, e.g. `{user}`.
 * @param key - The placeholder's name, e.g. `user`.
 * @param vars - Map of placeholder names to their substitution values.
 * @param fallback - How to handle a placeholder with no matching key in `vars`.
 * @returns The substitution value, or the fallback text for an unknown placeholder.
 */
function resolvePlaceholder(match: string, key: string, vars: Record<string, string>, fallback: FillTemplateFallback): string {
  const value = Object.hasOwn(vars, key) ? vars[key] : undefined;
  if (value !== undefined) return value;
  return fallback === 'keep' ? match : '';
}

/**
 * Zero-width space put in front of chat text that would otherwise begin with a Twitch chat
 * command character, so Twitch shows it as text instead of reading it as a command (e.g. `/me`).
 */
export const CHAT_COMMAND_GUARD = '\u200B';

/**
 * Whether `text`, ignoring leading whitespace, begins with a character Twitch chat reads as the
 * start of a command (`/` or `.`).
 * @param text - Chat text to check.
 * @returns The command character `text` begins with, or null if it begins with neither.
 */
export function leadingChatCommandChar(text: string): '/' | '.' | null {
  const first = text.trimStart()[0];
  return first === '/' || first === '.' ? first : null;
}

/**
 * Fills `template` as {@link fillTemplate} does, for a message that is sent to Twitch chat. When
 * the filled text begins with `/` or `.` and that character came from a placeholder value (such
 * as a viewer's `{args}`) rather than from the template's own text, {@link CHAT_COMMAND_GUARD} is
 * put in front of it and Twitch shows it as plain text instead of running it as a chat command
 * like `/me`. A command the streamer wrote is sent unchanged: `/me {args}`, and also
 * `{args}/me waves` when `{args}` is empty.
 * @param template - Template string containing zero or more `{key}` placeholders.
 * @param vars - Map of placeholder names to their substitution values.
 * @returns The filled template, guarded if a placeholder value made it start with a command character.
 */
export function fillChatTemplate(template: string, vars: Record<string, string>): string {
  const pieces: { text: string; fromPlaceholder: boolean }[] = [];
  let literalStart = 0;
  for (const m of template.matchAll(PLACEHOLDER_PATTERN)) {
    pieces.push({ text: template.slice(literalStart, m.index), fromPlaceholder: false });
    pieces.push({ text: resolvePlaceholder(m[0], m[1]!, vars, 'empty'), fromPlaceholder: true }); // group 1 always matches (\w+)
    literalStart = m.index + m[0].length;
  }
  pieces.push({ text: template.slice(literalStart), fromPlaceholder: false });
  const filled = pieces.map((p) => p.text).join('');
  // Where the first non-whitespace character came from: the template's own text, or a placeholder value.
  const lead = pieces.find((p) => p.text.trim() !== '');
  if (!lead?.fromPlaceholder || leadingChatCommandChar(filled) === null) return filled;
  return `${CHAT_COMMAND_GUARD}${filled.trimStart()}`;
}
