import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { isOverlayTraffic } from './overlayTraffic';

const req = (method: string, path: string) => ({ method, path }) as Request;

describe('isOverlayTraffic (#1011)', () => {
  it.each([
    ['GET', '/overlay/streamer1/events'],
    ['GET', '/alerts/streamer1/events'],
    ['GET', '/overlay/shared/streamer1/events'],
    ['GET', '/overlay/shared/videos/0f8fad5b.webm'],
    ['POST', '/overlay/shared/streamer1/report'],
    ['GET', '/overlay/videos/5/clip.webm'],
    ['GET', '/alerts/assets/5/ding.mp3'],
  ])('matches %s %s', (method, path) => {
    expect(isOverlayTraffic(req(method, path))).toBe(true);
  });

  it.each([
    // The overlay pages themselves, loaded once by OBS, stay under the general limiter.
    ['GET', '/overlay/streamer1'],
    ['GET', '/alerts/streamer1'],
    // Panel routes that share the prefixes.
    ['GET', '/overlay/settings/events'],
    ['GET', '/alerts/settings/events'],
    ['POST', '/overlay/shared/settings/report'],
    ['GET', '/overlay/settings'],
    ['GET', '/auth/login'],
    // Wrong method for the route.
    ['GET', '/overlay/shared/streamer1/report'],
    ['POST', '/overlay/videos/5/clip.webm'],
    // Extra path segments.
    ['GET', '/overlay/shared/videos/a/b.webm'],
  ])('does not match %s %s', (method, path) => {
    expect(isOverlayTraffic(req(method, path))).toBe(false);
  });
});
