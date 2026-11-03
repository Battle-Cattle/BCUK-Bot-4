import { describe, it, expect } from 'vitest';
import { parseUploadId, setConversionProgress, getConversionProgress, clearConversionProgress } from './overlayConversionProgress';

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
  it('stores, updates and clears an upload\'s progress', () => {
    setConversionProgress(1, ID, { stage: 'queued', percent: null });
    expect(getConversionProgress(1, ID)).toEqual({ stage: 'queued', percent: null });
    setConversionProgress(1, ID, { stage: 'converting', percent: 40 });
    expect(getConversionProgress(1, ID)).toEqual({ stage: 'converting', percent: 40 });
    clearConversionProgress(1, ID);
    expect(getConversionProgress(1, ID)).toBeUndefined();
  });

  it('never shows one streamer another streamer\'s upload, even with its ID', () => {
    setConversionProgress(1, ID, { stage: 'converting', percent: 10 });
    expect(getConversionProgress(2, ID)).toBeUndefined();
    clearConversionProgress(1, ID);
  });
});
