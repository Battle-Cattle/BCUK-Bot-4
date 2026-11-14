import { describe, it, expect } from 'vitest';
import { fitStreamerEventText, truncateForColumn } from './eventLogText';

describe('truncateForColumn', () => {
  it('leaves text that fits unchanged', () => {
    expect(truncateForColumn('a'.repeat(500), 500)).toBe('a'.repeat(500));
  });

  it('cuts longer text to the limit, ending with an ellipsis', () => {
    const result = truncateForColumn('a'.repeat(547), 500);
    expect(result).toHaveLength(500);
    expect(result).toBe(`${'a'.repeat(499)}…`);
  });

  it('never splits a surrogate pair at the cut', () => {
    const result = truncateForColumn(`${'a'.repeat(498)}😀${'b'.repeat(10)}`, 500);
    expect(result).toBe(`${'a'.repeat(498)}…`);
    expect(result.length).toBeLessThanOrEqual(500);
  });
});

describe('fitStreamerEventText (#1012)', () => {
  it('fits the detail to 500 and the display name to 255, keeping a null detail null', () => {
    const fitted = fitStreamerEventText('n'.repeat(300), `${'T'.repeat(45)}: ${'x'.repeat(500)}`);
    expect(fitted.displayName).toHaveLength(255);
    expect(fitted.detail).toHaveLength(500);
    expect(fitStreamerEventText('Viewer', null)).toEqual({ displayName: 'Viewer', detail: null });
  });
});
