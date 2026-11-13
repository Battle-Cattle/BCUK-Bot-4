import type { MessageMentionOptions } from 'discord.js';

// Keeps Discord mentions in a message filled from a panel user's template to the ones that user
// wrote: `mentionsWrittenIn` builds the `allowedMentions` for it, and
// `fillTemplateWithoutPlaceholderMentions` fills the template so placeholder values (untrusted
// text such as a stream title) can't add or complete a mention. Used by the Twitch monitor's
// live announcements (#1010).

/** Discord's limit on how many role or user ids `allowedMentions` may list (each). */
const MAX_ALLOWED_MENTION_IDS = 100;

/**
 * Builds `allowedMentions` that allow exactly the mentions written into a message template:
 * `@everyone`/`@here` only if the template has one, and the role (`<@&id>`) and user (`<@id>`,
 * `<@!id>`) ids it names. Pass it with the content made by filling that template, so a mention
 * that arrives through a placeholder (e.g. a stream title a streamer sets freely) shows as text
 * without notifying anyone, while the ones the panel user wrote still ping.
 * @param template - The message template as written, before its placeholders are filled.
 * @returns The mention options to send with the filled content.
 */
export function mentionsWrittenIn(template: string): MessageMentionOptions {
  const roles = new Set<string>();
  const users = new Set<string>();
  for (const match of template.matchAll(/<@(&|!)?(\d{17,20})>/g)) {
    (match[1] === '&' ? roles : users).add(match[2]!);
  }
  return {
    parse: /@(everyone|here)\b/.test(template) ? ['everyone'] : [],
    roles: [...roles].slice(0, MAX_ALLOWED_MENTION_IDS),
    users: [...users].slice(0, MAX_ALLOWED_MENTION_IDS),
  };
}

/** Zero-width space: put after an `@`, it stops Discord reading the text as a mention. */
const ZERO_WIDTH_SPACE = '\u200b';

/** Every kind of text Discord reads as a mention: `@everyone`, `@here`, and user/role mentions (`<@id>`, `<@!id>`, `<@&id>`). */
const MENTION_PATTERN = /@(?:everyone|here)|<@[!&]?\d+>/g;

/** A `{name}` placeholder, as `fillTemplate` reads them. */
const PLACEHOLDER_PATTERN = /\{(\w+)\}/g;

/** Filled template text, with where each of its characters came from. */
interface TrackedFill {
  /** The filled text. */
  text: string;
  /** For each character of `text`, its index in the template, or -1 for a character from a placeholder value. */
  origin: number[];
}

/**
 * Fills `{name}` placeholders as `fillTemplate` does with its `'keep'` fallback (a placeholder with
 * no value stays as written), recording where each output character came from.
 * @param template - Message template with `{name}` placeholders.
 * @param vars - Placeholder values.
 * @returns The filled text and each character's origin.
 */
function fillTracked(template: string, vars: Record<string, string>): TrackedFill {
  const pieces: string[] = [];
  const origin: number[] = [];
  /**
   * Copies template characters into the output, recording their template positions.
   * @param from - Template index of the first character to copy.
   * @param to - Template index just past the last character to copy.
   */
  const copyTemplate = (from: number, to: number): void => {
    pieces.push(template.slice(from, to));
    for (let i = from; i < to; i++) origin.push(i);
  };
  let cursor = 0;
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const end = match.index + match[0].length;
    const value = Object.hasOwn(vars, match[1]!) ? vars[match[1]!] : undefined;
    copyTemplate(cursor, match.index);
    if (value === undefined) {
      copyTemplate(match.index, end);
    } else {
      pieces.push(value);
      // One entry per UTF-16 code unit, matching how the text is indexed.
      origin.push(...Array<number>(value.length).fill(-1));
    }
    cursor = end;
  }
  copyTemplate(cursor, template.length);
  return { text: pieces.join(''), origin };
}

/**
 * Whether output characters `[start, end)` were all written in the template, next to each other
 * in the same order. A mention assembled from template text either side of a placeholder (even an
 * empty one), or with any character from a placeholder value, isn't.
 * @param origin - Each output character's template index, or -1 (see {@link TrackedFill}).
 * @param start - Index of the first character to check.
 * @param end - Index just past the last character to check.
 * @returns True when the span is a contiguous piece of the template.
 */
function isWrittenInTemplate(origin: number[], start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const at = origin[i]!; // i < end <= origin.length, the same length as the text
    if (at < 0 || (i > start && at !== origin[i - 1]! + 1)) return false;
  }
  return true;
}

/**
 * Fills `{name}` placeholders (as `fillTemplate` with its `'keep'` fallback does) so that only
 * mentions written in the template itself can ping. Every mention in the filled text that isn't a
 * contiguous piece of the template — one inside a placeholder value, one pieced together from
 * template text and a value (`@{title}` with title `everyone`, `@eve{title}` with `ryone`), or
 * from template text either side of an empty value (`@{title}everyone`) — gets a zero-width space
 * after its `@`, so it shows as written but is plain text to Discord. Needed on top of
 * `allowedMentions`, which allows mention types and ids but can't tell where in the content a
 * mention came from: Discord's `everyone` parse type covers both `@everyone` and `@here`.
 * @param template - Message template written by a panel user, with `{name}` placeholders.
 * @param vars - Untrusted placeholder values; a placeholder with no value is left as written.
 * @returns The filled content.
 */
export function fillTemplateWithoutPlaceholderMentions(template: string, vars: Record<string, string>): string {
  const { text, origin } = fillTracked(template, vars);
  let result = '';
  let cursor = 0;
  for (const match of text.matchAll(MENTION_PATTERN)) {
    if (isWrittenInTemplate(origin, match.index, match.index + match[0].length)) continue;
    const afterAt = text.indexOf('@', match.index) + 1;
    result += `${text.slice(cursor, afterAt)}${ZERO_WIDTH_SPACE}`;
    cursor = afterAt;
  }
  return result + text.slice(cursor);
}
