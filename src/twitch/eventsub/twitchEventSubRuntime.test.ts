import { describe, it, expect, vi } from 'vitest';
import {
  registerEventSubOverlayRuntime, overlayRuntimeRegistry,
  registerEventSubCompanionRuntime, companionRuntimeRegistry,
  registerEventSubAlertRuntime, alertRuntimeRegistry,
  registerEventSubDashboardRuntime, dashboardEventRuntimeRegistry,
  registerEventSubTwitchRuntime, twitchRuntimeRegistry,
} from './twitchEventSubRuntime';

// createRuntimeRegistry's own register/get contract is covered by
// commands/twitchRuntime.test.ts; these tests only confirm each
// registerEventSub*Runtime function delegates to the right registry.

describe('registerEventSubOverlayRuntime', () => {
  it('stores the runtime on overlayRuntimeRegistry', () => {
    const runtime = { pushOverlayEvent: vi.fn() };
    registerEventSubOverlayRuntime(runtime);
    expect(overlayRuntimeRegistry.get()).toBe(runtime);
  });
});

describe('registerEventSubCompanionRuntime', () => {
  it('stores the runtime on companionRuntimeRegistry', () => {
    const runtime = { pushCompanionEvent: vi.fn() };
    registerEventSubCompanionRuntime(runtime);
    expect(companionRuntimeRegistry.get()).toBe(runtime);
  });
});

describe('registerEventSubAlertRuntime', () => {
  it('stores the runtime on alertRuntimeRegistry', () => {
    const runtime = { pushAlertEvent: vi.fn() };
    registerEventSubAlertRuntime(runtime);
    expect(alertRuntimeRegistry.get()).toBe(runtime);
  });
});

describe('registerEventSubDashboardRuntime', () => {
  it('stores the runtime on dashboardEventRuntimeRegistry', () => {
    const runtime = { pushDashboardEvent: vi.fn() };
    registerEventSubDashboardRuntime(runtime);
    expect(dashboardEventRuntimeRegistry.get()).toBe(runtime);
  });
});

describe('registerEventSubTwitchRuntime', () => {
  it('stores the runtime on twitchRuntimeRegistry', () => {
    const runtime = { send: vi.fn().mockResolvedValue(undefined) };
    registerEventSubTwitchRuntime(runtime);
    expect(twitchRuntimeRegistry.get()).toBe(runtime);
  });
});
