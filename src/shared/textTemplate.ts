/** Strategy for handling `{key}` placeholders with no matching entry in `vars`. */
export type FillTemplateFallback = 'empty' | 'keep';

/**
 * Substitutes `{key}` placeholders in `template` with values from `vars`.
 * Unknown placeholders (keys not present in `vars`) are handled per `fallback`:
 * `'empty'` (the default) replaces them with an empty string; `'keep'` leaves the
 * literal `{key}` text in place, which is useful for template-editor previews
 * where a leftover placeholder should stay visible as a hint of a typo.
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
  return template.replace(/\{(\w+)\}/g, (match, k: string) => {
    const value = vars[k];
    if (value !== undefined) return value;
    return fallback === 'keep' ? match : '';
  });
}
