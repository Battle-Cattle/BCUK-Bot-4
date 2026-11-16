import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const source = fs.readFileSync(path.join(__dirname, '../../public/shared-overlay-timing.js'), 'utf8');
const context: Record<string, any> = {};
vm.createContext(context);
vm.runInContext(source, context);
const plan = context.planSharedPlayback as (n: number, p: number, m: number) => any;

describe('planSharedPlayback', () => {
  it('waits until playAt when early', () => {
    expect(plan(1000, 1500, 3000)).toEqual({ action: 'play', delayMs: 500, seekSeconds: 0 });
  });
  it('plays at once when exactly on time', () => {
    expect(plan(1500, 1500, 3000)).toEqual({ action: 'play', delayMs: 0, seekSeconds: 0 });
  });
  it('seeks forward by how late it is', () => {
    expect(plan(2500, 1500, 3000)).toEqual({ action: 'play', delayMs: 0, seekSeconds: 1 });
  });
  it('plays when exactly at the late limit', () => {
    expect(plan(4500, 1500, 3000)).toMatchObject({ action: 'play', seekSeconds: 3 });
  });
  it('skips when later than the limit', () => {
    expect(plan(4501, 1500, 3000)).toEqual({ action: 'skip' });
  });
});
