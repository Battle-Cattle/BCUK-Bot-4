import { describe, it, expect } from 'vitest';
import {
  parseUploadId, claimConversionProgress, setConversionProgress, getConversionProgress, releaseConversionProgress,
} from './overlayConversionProgress';

const ID = '0123456789abcdef0123456789abcdef';

describe('parseUploadId', () => {
  it('accepts 32 lowercase hex characters', () => {
    expect(parseUploadId(ID)).toBe(ID);
  });

  it.each([undefined, '', 'abc', ID.toUpperCase(), `${ID}0`, '../../etc/passwd', 42])('rejects %s', (value) => {
    expect(parseUploadId(value)).toBeNull();
  });
});

describe('conversion progress store', () => {
  it('stores, updates and clears an upload\'s progress for its owner', () => {
    const owner = claimConversionProgress(1, ID)!;
    setConversionProgress(1, ID, owner, { stage: 'queued', percent: null });
    expect(getConversionProgress(1, ID)).toEqual({ stage: 'queued', percent: null });
    setConversionProgress(1, ID, owner, { stage: 'converting', percent: 40 });
    expect(getConversionProgress(1, ID)).toEqual({ stage: 'converting', percent: 40 });
    releaseConversionProgress(1, ID, owner);
    expect(getConversionProgress(1, ID)).toBeUndefined();
  });

  it('never shows one streamer another streamer\'s upload, even with its ID', () => {
    const owner = claimConversionProgress(1, ID)!;
    setConversionProgress(1, ID, owner, { stage: 'converting', percent: 10 });
    expect(getConversionProgress(2, ID)).toBeUndefined();
    releaseConversionProgress(1, ID, owner);
  });

  it('lets only one request own an upload ID at a time', () => {
    const first = claimConversionProgress(1, ID)!;
    expect(claimConversionProgress(1, ID)).toBeNull();
    setConversionProgress(1, ID, first, { stage: 'converting', percent: 20 });
    // A request that didn't get the claim can neither overwrite nor clear the owner's progress.
    const stranger = Symbol('stranger');
    setConversionProgress(1, ID, stranger, { stage: 'converting', percent: 90 });
    releaseConversionProgress(1, ID, stranger);
    expect(getConversionProgress(1, ID)).toEqual({ stage: 'converting', percent: 20 });
    releaseConversionProgress(1, ID, first);
    expect(claimConversionProgress(1, ID)).not.toBeNull();
  });
});
