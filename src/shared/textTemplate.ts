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
  return template.replace(PLACEHOLDER_PATTERN, (match, k: string) => {
    const value = Object.hasOwn(vars, k) ? vars[k] : undefined;
    if (value !== undefined) return value;
    return fallback === 'keep' ? match : '';
  });
}

/**
 * Zero-width space put in front of chat text that would otherwise begin with a Twitch chat
 * command character, so Twitch shows it as text instead of reading it as a command (e.g. `/me`).
 */
export const CHAT_COMMAND_GUARD = '​';

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
 * the filled text begins with `/` or `.` but the template itself doesn't begin with that
 * character, the character came from a placeholder value (such as a viewer's `{args}`), so
 * {@link CHAT_COMMAND_GUARD} is put in front of it and Twitch shows it as plain text instead of
 * running it as a chat command like `/me`. A template the streamer wrote as `/me {args}` is sent
 * unchanged.
 * @param template - Template string containing zero or more `{key}` placeholders.
 * @param vars - Map of placeholder names to their substitution values.
 * @returns The filled template, guarded if a placeholder value made it start with a command character.
 */
export function fillChatTemplate(template: string, vars: Record<string, string>): string {
  const filled = fillTemplate(template, vars);
  const commandChar = leadingChatCommandChar(filled);
  if (commandChar === null || leadingChatCommandChar(template) === commandChar) return filled;
  return `${CHAT_COMMAND_GUARD}${filled.trimStart()}`;
}
