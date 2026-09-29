/**
 * Creates a promise along with its `resolve`/`reject` functions, so a test can settle it on demand.
 * @returns The promise and its settle functions.
 */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
