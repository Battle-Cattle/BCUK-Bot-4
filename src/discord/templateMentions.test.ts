import { describe, it, expect } from 'vitest';
import { fillTemplateWithoutPlaceholderMentions, mentionsWrittenIn } from './templateMentions';

describe('mentionsWrittenIn (#1010)', () => {
  const ROLE = '123456789012345678';
  const USER = '234567890123456789';

  it('allows @everyone only when the template has @everyone or @here, and no roles or users', () => {
    expect(mentionsWrittenIn('@everyone {streamer} is live: {title}')).toEqual({ parse: ['everyone'], roles: [], users: [] });
    expect(mentionsWrittenIn('@here {streamer} is live')).toEqual({ parse: ['everyone'], roles: [], users: [] });
  });

  it('allows nothing for a template without mentions', () => {
    expect(mentionsWrittenIn('{streamer} is live: {title} {url}')).toEqual({ parse: [], roles: [], users: [] });
  });

  it('allows the role and user ids written in the template, once each, including the <@!id> form', () => {
    expect(mentionsWrittenIn(`<@&${ROLE}> <@${USER}> <@!${USER}> <@&${ROLE}> {title}`)).toEqual({ parse: [], roles: [ROLE], users: [USER] });
  });

  it('caps each id list at Discord\'s 100', () => {
    const roles = Array.from({ length: 120 }, (_v, i) => `<@&${String(100000000000000000n + BigInt(i))}>`).join(' ');
    expect(mentionsWrittenIn(roles).roles).toHaveLength(100);
  });
});

describe('fillTemplateWithoutPlaceholderMentions', () => {
  it('fills placeholders, keeps an unknown one as written, and keeps the template\'s own mentions', () => {
    expect(fillTemplateWithoutPlaceholderMentions('@everyone {a} {missing} <@&123456789012345678> @here', { a: 'x' }))
      .toBe('@everyone x {missing} <@&123456789012345678> @here');
  });

  it('neutralises every kind of mention inside a value', () => {
    expect(fillTemplateWithoutPlaceholderMentions('{a}', { a: '@everyone @here <@1> <@!2> <@&3>' }))
      .toBe('@\u200beveryone @\u200bhere <@\u200b1> <@\u200b!2> <@\u200b&3>');
  });

  it.each([
    ['template @ + value', '@{a}', { a: 'everyone' }, '@\u200beveryone'],
    ['partial mention in the template', '@eve{a}', { a: 'ryone' }, '@\u200beveryone'],
    ['value ending in @ + template text', '{a}here', { a: 'hi @' }, 'hi @\u200bhere'],
    ['empty value between template pieces', '@{a}everyone', { a: '' }, '@\u200beveryone'],
    ['role mention around a value', '<@&{a}>', { a: '123' }, '<@\u200b&123>'],
    ['user mention around a value', '<@!{a}>', { a: '123456789012345678' }, '<@\u200b!123456789012345678>'],
    ['digits split across the edge', '<@&1234{a}>', { a: '5678' }, '<@\u200b&12345678>'],
    ['two adjacent values', '{a}{b}', { a: 'x @', b: 'here' }, 'x @\u200bhere'],
  ])('neutralises a mention formed across a placeholder edge: %s', (_name, template, vars, expected) => {
    expect(fillTemplateWithoutPlaceholderMentions(template, vars)).toBe(expected);
  });

  it('leaves text with no mention unchanged, and a template mention next to a value live', () => {
    expect(fillTemplateWithoutPlaceholderMentions('Watch {a}!', { a: 'https://twitch.tv/x' })).toBe('Watch https://twitch.tv/x!');
    expect(fillTemplateWithoutPlaceholderMentions('@here{a}', { a: ' is live' })).toBe('@here is live');
  });

  it('keeps track of positions past a value with emoji (two UTF-16 units each)', () => {
    expect(fillTemplateWithoutPlaceholderMentions('{a} @here {b}', { a: '😀😀', b: '@everyone' }))
      .toBe('😀😀 @here @\u200beveryone');
  });
});
