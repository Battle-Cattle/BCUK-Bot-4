// The one place Loyalty Points' default earn rates are defined. Applied when a streamer has no
// `loyalty_points_config` row; the table's rate columns have no DB-level DEFAULT (migration
// 0003), so nothing else can drift from these. A plain app default, not an env-configurable
// value, so it lives here rather than in config.ts.

/** The config shown, and used, for a streamer who has never saved one: off, with these rates. */
export const DEFAULT_LOYALTY_POINTS_CONFIG = Object.freeze({
  enabled: false,
  pointsPerMessage: 10,
  cooldownSeconds: 60,
  pointsPerSub: 1000,
  pointsPerGiftSub: 1000,
});
