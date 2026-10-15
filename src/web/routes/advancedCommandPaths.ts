// Paths shared by the /advanced-commands page's route modules.

/** The page every advanced-command route redirects back to. */
export const BASE_PATH = '/advanced-commands';
/** Redirect for a signed-in user with no streamer record. */
export const NOT_A_STREAMER_REDIRECT = `${BASE_PATH}?error=not_a_streamer`;
