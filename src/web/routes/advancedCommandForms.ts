// Form parsing for the /advanced-commands page: turns the submitted settings and effects forms
// into the DB layer's input shapes, and maps write errors to the page's `?error=` codes. Range and
// length rules are enforced by the DB layer (`advancedCommandValidation.ts`); this only rejects
// fields that aren't numbers at all.
import {
  ADVANCED_COMMAND_ROLES,
  AdvancedCommandConflictError,
  AdvancedCommandValidationError,
  CommandConflictError,
  ReservedCommandError,
  type AdvancedCommandEffectsInput,
  type AdvancedCommandParam,
  type AdvancedCommandRole,
  type AdvancedCommandSettings,
  type TextAnimation,
  ALERT_TEXT_ANIMATIONS,
} from '../../db';
import { parseCheckboxField } from './validation';

/** A submitted form body: Express's urlencoded parser yields strings, or arrays for repeated fields. */
export type FormBody = Record<string, string | string[] | undefined>;

/** Thrown for a field that isn't a whole number at all; the page shows it as `?error=invalid_number`. */
class FormNumberError extends AdvancedCommandValidationError {
  constructor(field: string) {
    super('invalid_number', `${field} must be a whole number`);
  }
}

/**
 * Reads a single string field, treating a repeated field as missing.
 * @param body - The form body.
 * @param field - Field name.
 * @returns The trimmed value, or '' when absent.
 */
function text(body: FormBody, field: string): string {
  const value = body[field];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Reads a whole-number field; blank uses `blank`.
 * @param body - The form body.
 * @param field - Field name.
 * @param blank - Value for an empty field.
 * @returns The number, or `blank`.
 */
function wholeNumber<T extends number | null>(body: FormBody, field: string, blank: T): number | T {
  const value = text(body, field);
  if (value === '') return blank;
  if (!/^\d+$/.test(value)) throw new FormNumberError(field);
  return Number(value);
}

/**
 * Parses the add/update settings form.
 * @param body - The form body.
 * @returns The settings, ready for `addAdvancedCommand`/`updateAdvancedCommand`.
 * @throws {@link AdvancedCommandValidationError} for a non-numeric number field.
 */
export function parseSettingsForm(body: FormBody): AdvancedCommandSettings {
  const role = text(body, 'min_role') as AdvancedCommandRole;
  return {
    name: text(body, 'name'),
    triggerString: text(body, 'trigger') || null,
    isEnabled: parseCheckboxField(body.is_enabled),
    response: text(body, 'response') || null,
    pointCost: wholeNumber(body, 'point_cost', 0),
    priceStep: wholeNumber(body, 'price_step', 0),
    maxCost: wholeNumber(body, 'max_cost', null),
    globalCooldownSeconds: wholeNumber(body, 'global_cooldown_seconds', 0),
    userCooldownSeconds: wholeNumber(body, 'user_cooldown_seconds', 0),
    minRole: ADVANCED_COMMAND_ROLES.includes(role) ? role : 'everyone',
    liveOnly: parseCheckboxField(body.live_only),
    maxUsesPerStream: wholeNumber(body, 'max_uses_per_stream', null),
    maxUsesPerUserPerStream: wholeNumber(body, 'max_uses_per_user_per_stream', null),
    companionEnabled: parseCheckboxField(body.companion_enabled),
  };
}

/**
 * Parses the parameters textarea: one `key=value` per line; blank lines are skipped.
 * @param raw - The textarea's text.
 * @returns The parameters.
 * @throws {@link AdvancedCommandValidationError} for a line without `=`.
 */
export function parseParamLines(raw: string): AdvancedCommandParam[] {
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const eq = line.indexOf('=');
    if (eq <= 0) throw new AdvancedCommandValidationError('invalid_param', `Expected key=value, got '${line}'`);
    return { key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim() };
  });
}

/**
 * Collects the ticked overlay videos (`video_<id>` checkboxes) and their weights (`weight_<id>`).
 * Only ids in `allowedVideoIds` (the streamer's own videos) are read; ownership is re-checked
 * by the write.
 * @param body - The form body.
 * @param allowedVideoIds - The streamer's video ids.
 * @returns The selected videos.
 */
function parseVideos(body: FormBody, allowedVideoIds: number[]): AdvancedCommandEffectsInput['videos'] {
  return allowedVideoIds
    .filter((id) => parseCheckboxField(body[`video_${id}`]))
    .map((id) => ({ videoId: id, weight: wholeNumber(body, `weight_${id}`, 1) }));
}

/**
 * Parses the alert part of the effects form; unticked `alert_enabled` means no alert.
 * @param body - The form body.
 * @returns The alert, or null.
 */
function parseAlert(body: FormBody): AdvancedCommandEffectsInput['alert'] {
  if (!parseCheckboxField(body.alert_enabled)) return null;
  // Number('') is 0, which the clamp below would turn into a 1s alert; blank means the default.
  const rawSeconds = text(body, 'alert_duration_seconds');
  const seconds = rawSeconds === '' ? Number.NaN : Number(rawSeconds);
  const animation = text(body, 'alert_text_animation') as TextAnimation;
  return {
    messageTemplate: text(body, 'alert_message'),
    // Same 1–60s clamp (in 0.01s steps) the event alerts settings page applies.
    durationMs: Number.isFinite(seconds) ? Math.round(Math.min(60, Math.max(1, seconds)) * 1000) : 6000,
    textAnimation: ALERT_TEXT_ANIMATIONS.includes(animation) ? animation : 'none',
  };
}

/**
 * Parses the effects form: parameters, overlay videos and alert.
 * @param body - The form body.
 * @param allowedVideoIds - The streamer's overlay video ids.
 * @returns The effects, ready for `saveAdvancedCommandEffects`.
 * @throws {@link AdvancedCommandValidationError} for a malformed parameter line or weight.
 */
export function parseEffectsForm(body: FormBody, allowedVideoIds: number[]): AdvancedCommandEffectsInput {
  return {
    params: parseParamLines(text(body, 'params')),
    videos: parseVideos(body, allowedVideoIds),
    alert: parseAlert(body),
  };
}

/**
 * Maps an expected write error to the page's `?error=` code.
 * @param err - The caught error.
 * @returns The code, or null for an unexpected error (logged and shown as `save_failed`).
 */
export function advancedCommandErrorCode(err: unknown): string | null {
  if (err instanceof AdvancedCommandValidationError) return err.code;
  if (err instanceof AdvancedCommandConflictError) return `duplicate_${err.field}`;
  if (err instanceof CommandConflictError) return 'trigger_taken';
  if (err instanceof ReservedCommandError) return 'reserved_trigger';
  return null;
}
