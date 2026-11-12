/** Path of the shared video overlay's Manager settings page (#917). */
export const SHARED_SETTINGS_PATH = '/overlay/shared/settings';

/**
 * Key shared uploads publish conversion progress under. The progress store is keyed by streamer
 * id; shared uploads belong to no streamer and their upload ids are random, so a fixed key that
 * no streamer row uses (ids start at 1) is enough.
 */
export const SHARED_PROGRESS_KEY = 0;
