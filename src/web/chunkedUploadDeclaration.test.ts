import { describe, expect, it } from 'vitest';
import { isUploadId, parseDeclaration } from './chunkedUploadDeclaration';

describe('parseDeclaration', () => {
  it('accepts a name, numeric size and type, keeping only the base name', () => {
    expect(parseDeclaration({ name: '../x/clip.mov', size: '12', type: 'video/quicktime' }))
      .toEqual({ name: 'clip.mov', size: 12, type: 'video/quicktime' });
  });

  it('rejects missing names and non-positive or fractional sizes', () => {
    expect(parseDeclaration({ name: '', size: 1 })).toBeNull();
    expect(parseDeclaration({ name: 'a', size: 0 })).toBeNull();
    expect(parseDeclaration({ name: 'a', size: 1.5 })).toBeNull();
    expect(parseDeclaration(null)).toBeNull();
  });
});

describe('isUploadId', () => {
  it('accepts only UUIDs', () => {
    expect(isUploadId('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(true);
    expect(isUploadId('../etc/passwd')).toBe(false);
  });
});
