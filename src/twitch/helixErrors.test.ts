import { describe, it, expect } from 'vitest';
import { assertHelixOk } from './helixErrors';

function response(status: number): Response {
  return { ok: status >= 200 && status < 300, status } as Response;
}

describe('assertHelixOk', () => {
  it('does nothing for an OK response', () => {
    expect(() => assertHelixOk(response(200), 'getThing')).not.toThrow();
  });

  it('throws the standard labelled error with the status for a non-OK response', () => {
    expect(() => assertHelixOk(response(500), 'getThing')).toThrow('[TwitchAPI] getThing failed: 500');
  });
});
