/** Flush enough microtask levels for deep async chains to settle. */
export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
