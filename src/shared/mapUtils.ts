/**
 * Returns the value for `key` in `map`, creating and inserting `makeDefault()`
 * if absent. Shared "look up, else create+set, then return" helper used by
 * `statusStore.ts`, `commandRouter.ts`, and `audioPlayer.ts` for their
 * per-guild/per-channel lazy-init state maps.
 *
 * @param map - Map to look up (and potentially insert into).
 * @param key - Key to look up.
 * @param makeDefault - Builds the default value to insert when `key` is absent.
 * @returns The existing value for `key`, or the newly-created and inserted default.
 */
export function getOrCreate<K, V>(map: Map<K, V>, key: K, makeDefault: () => V): V {
  let value = map.get(key);
  if (!value) {
    value = makeDefault();
    map.set(key, value);
  }
  return value;
}
