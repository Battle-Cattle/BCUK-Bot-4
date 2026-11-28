import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const template = readFileSync(join(__dirname, '../../views/companion-keys.ejs'), 'utf8');

describe('companion-keys developer docs', () => {
  it('documents the required PKCE parameters on the login and token calls', () => {
    expect(template).toContain('code_challenge_method=S256');
    expect(template).toContain('"code_verifier": "..."');
  });
});
