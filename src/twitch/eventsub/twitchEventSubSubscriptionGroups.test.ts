import { describe, it, expect, vi } from 'vitest';

vi.mock('../../shared/config', () => ({}));

import { getAlertTypesCoveredBySubscriptionGroups } from './twitchEventSubSubscriptionGroups';
import { ALERT_EVENT_TYPES } from '../../db/alertConfig';

// ---------------------------------------------------------------------------
// Subscription-group alert-type coverage (exhaustiveness)
//
// Guards against a new AlertEventType being added (to ALERT_EVENT_TYPES / the DB schema) without
// also wiring it into a SUBSCRIPTION_GROUPS entry's `alertTypes` — a gap that would otherwise
// compile fine and only surface at runtime as "the EventSub subscription is never created, so
// the alert silently never fires."
// ---------------------------------------------------------------------------
describe('subscription-group alert-type coverage', () => {
  it('covers every ALERT_EVENT_TYPES member in some subscription group', () => {
    const covered = getAlertTypesCoveredBySubscriptionGroups();
    for (const type of ALERT_EVENT_TYPES) {
      expect(covered.has(type)).toBe(true);
    }
  });

  it('does not cover any type outside ALERT_EVENT_TYPES (catches stale/typo\'d entries)', () => {
    const covered = getAlertTypesCoveredBySubscriptionGroups();
    for (const type of covered) {
      expect(ALERT_EVENT_TYPES).toContain(type);
    }
  });
});
