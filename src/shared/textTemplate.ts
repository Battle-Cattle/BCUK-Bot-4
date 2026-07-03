/**
 * Substitutes `{key}` placeholders in `template` with values from `vars`.
 * Unknown placeholders (keys not present in `vars`) are replaced with an empty string.
 *
 * @param template - Template string containing zero or more `{key}` placeholders.
 * @param vars - Map of placeholder names to their substitution values.
 * @returns The template with all placeholders substituted.
 */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
}
