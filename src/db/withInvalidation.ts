/**
 * Runs `operation`, then unconditionally calls `invalidate`. Shared by the `*Writes.ts` facade
 * wrappers that always need a post-write cache invalidation — the underlying DB modules (`users.ts`, `guildCommandOverrides.ts`, `customCommands.ts`, `counters.ts`, `alertConfig.ts`,
 * `sfx.ts`) are pure DB layers with no cache knowledge of their own.
 * @param operation - The DB write to perform.
 * @param invalidate - The cache-invalidation callback to run once `operation` succeeds.
 * @returns The value returned by `operation`.
 */
export async function withInvalidation<T>(operation: () => Promise<T>, invalidate: () => void): Promise<T> {
  const result = await operation();
  invalidate();
  return result;
}
