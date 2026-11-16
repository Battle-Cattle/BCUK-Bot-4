/**
 * Decides how to start a shared overlay video that should begin at `playAt`.
 * @param {number} nowServerMs - Current time on the server's clock (local time + clock offset), in ms.
 * @param {number} playAtMs - Server time the video should start at, in ms.
 * @param {number} maxLateMs - Most the start may be late before the video is skipped, in ms.
 * @returns {{action: 'skip'} | {action: 'play', delayMs: number, seekSeconds: number}} `skip` when
 *   too late; otherwise `play` after `delayMs` (0 when due), seeking `seekSeconds` in to catch up.
 */
function planSharedPlayback(nowServerMs, playAtMs, maxLateMs) {
  const lateMs = nowServerMs - playAtMs;
  if (lateMs > maxLateMs) return { action: 'skip' };
  if (lateMs <= 0) return { action: 'play', delayMs: Math.max(0, -lateMs), seekSeconds: 0 };
  return { action: 'play', delayMs: 0, seekSeconds: lateMs / 1000 };
}
