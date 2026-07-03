import { describe, it, expect } from 'vitest';
import { fillTemplate } from './textTemplate';

describe('fillTemplate', () => {
  it('substitutes a single placeholder', () => {
    expect(fillTemplate('Hello {user}!', { user: 'alice' })).toBe('Hello alice!');
  });

  it('substitutes multiple distinct placeholders', () => {
    expect(fillTemplate('{user} said {args}', { user: 'bob', args: 'hi there' })).toBe('bob said hi there');
  });

  it('substitutes repeated occurrences of the same placeholder', () => {
    expect(fillTemplate('{user}-{user}', { user: 'x' })).toBe('x-x');
  });

  it('replaces unknown placeholders with an empty string', () => {
    expect(fillTemplate('Hi {unknown}!', {})).toBe('Hi !');
  });

  it('returns the template unchanged when it has no placeholders', () => {
    expect(fillTemplate('no placeholders here', { user: 'alice' })).toBe('no placeholders here');
  });

  it('returns an empty string for an empty template', () => {
    expect(fillTemplate('', { user: 'alice' })).toBe('');
  });
});
