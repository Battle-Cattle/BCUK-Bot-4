import { describe, it, expect } from 'vitest';
import type { Response } from 'express';
import { isLiveReportNonce, issueReportNonce } from './sharedOverlayReportNonce';

const conn = () => ({}) as Response;

describe('shared overlay report nonces', () => {
  it('issues a fresh 64-hex nonce per call', () => {
    const res = conn();
    const a = issueReportNonce(res);
    const b = issueReportNonce(conn());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it('accepts only a nonce held by one of the given connections', () => {
    const mine = conn();
    const other = conn();
    const nonce = issueReportNonce(mine);
    const otherNonce = issueReportNonce(other);
    expect(isLiveReportNonce(nonce, [other, mine])).toBe(true);
    expect(isLiveReportNonce(otherNonce, [mine])).toBe(false);
    expect(isLiveReportNonce(nonce, undefined)).toBe(false);
    expect(isLiveReportNonce(nonce, [conn()])).toBe(false);
  });

  it('refuses missing, malformed and non-string nonces', () => {
    const res = conn();
    const nonce = issueReportNonce(res);
    expect(isLiveReportNonce(undefined, [res])).toBe(false);
    expect(isLiveReportNonce(123, [res])).toBe(false);
    expect(isLiveReportNonce(nonce.toUpperCase(), [res])).toBe(false);
    expect(isLiveReportNonce(nonce.slice(2), [res])).toBe(false);
  });

  it('replaces a connection\'s nonce when it is issued again', () => {
    const res = conn();
    const old = issueReportNonce(res);
    const fresh = issueReportNonce(res);
    expect(isLiveReportNonce(old, [res])).toBe(false);
    expect(isLiveReportNonce(fresh, [res])).toBe(true);
  });
});
