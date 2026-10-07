import { describe, it, expect } from 'vitest';
import { NOT_A_STREAMER_REDIRECT } from './overlayAdminShared';

describe('NOT_A_STREAMER_REDIRECT', () => {
  it('points back at the overlay settings page with the not_a_streamer error', () => {
    expect(NOT_A_STREAMER_REDIRECT).toBe('/overlay/settings?error=not_a_streamer');
  });
});
