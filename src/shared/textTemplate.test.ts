import { describe, it, expect } from 'vitest';
import { fillTemplate, fillChatTemplate, leadingChatCommandChar, CHAT_COMMAND_GUARD } from './textTemplate';

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

  it('defaults to the empty fallback when no fallback argument is given', () => {
    expect(fillTemplate('Hi {unknown}!', {})).toBe(fillTemplate('Hi {unknown}!', {}, 'empty'));
  });

  it('replaces unknown placeholders with an empty string when fallback is explicitly "empty"', () => {
    expect(fillTemplate('Hi {unknown}!', {}, 'empty')).toBe('Hi !');
  });

  it('leaves unknown placeholders as the literal {key} text when fallback is "keep"', () => {
    expect(fillTemplate('Hi {unknown}!', {}, 'keep')).toBe('Hi {unknown}!');
  });

  it('still substitutes known placeholders when fallback is "keep"', () => {
    expect(fillTemplate('{streamer} is playing {game}', { streamer: 'alice', game: 'Chess' }, 'keep'))
      .toBe('alice is playing Chess');
  });

  it('mixes known substitutions and kept-literal unknowns in "keep" mode', () => {
    expect(fillTemplate('{streamer} — {unknown}', { streamer: 'alice' }, 'keep')).toBe('alice — {unknown}');
  });

  it('treats inherited Object.prototype names as unknown placeholders rather than rendering them', () => {
    expect(fillTemplate('{constructor} {toString} {__proto__}', { user: 'alice' })).toBe('  ');
    expect(fillTemplate('{constructor} {hasOwnProperty}', {}, 'keep')).toBe('{constructor} {hasOwnProperty}');
  });
});

describe('leadingChatCommandChar', () => {
  it('returns the command character a text begins with, ignoring leading whitespace', () => {
    expect(leadingChatCommandChar('/me hi')).toBe('/');
    expect(leadingChatCommandChar('  .me hi')).toBe('.');
  });

  it('returns null for text that does not begin with a command character', () => {
    expect(leadingChatCommandChar('hi /me')).toBeNull();
    expect(leadingChatCommandChar('')).toBeNull();
  });
});

describe('fillChatTemplate', () => {
  it('guards a response that a viewer\'s {args} makes start with /', () => {
    expect(fillChatTemplate('{args}', { args: '/me hi' })).toBe(`${CHAT_COMMAND_GUARD}/me hi`);
  });

  it('guards a response that a placeholder makes start with ., dropping the leading whitespace', () => {
    expect(fillChatTemplate(' {args}', { args: '.me hi' })).toBe(`${CHAT_COMMAND_GUARD}.me hi`);
  });

  it('leaves a template the streamer wrote as /me {args} unchanged', () => {
    expect(fillChatTemplate('/me {args}', { args: 'waves' })).toBe('/me waves');
  });

  it('guards a / from a placeholder when the template itself starts with a different command character', () => {
    expect(fillChatTemplate('{arg}.', { arg: '/me' })).toBe(`${CHAT_COMMAND_GUARD}/me.`);
  });

  it('leaves a response that does not start with a command character unchanged', () => {
    expect(fillChatTemplate('{user} said {args}', { user: 'bob', args: '/me hi' })).toBe('bob said /me hi');
  });

  it('replaces unknown placeholders with an empty string, like fillTemplate', () => {
    expect(fillChatTemplate('Hi {unknown}!', {})).toBe('Hi !');
  });
});
