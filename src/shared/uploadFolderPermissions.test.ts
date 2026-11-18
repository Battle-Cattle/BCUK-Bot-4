import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('./logger', () => ({ createLogger: () => mockLog }));

const config = vi.hoisted(() => ({
  OVERLAY_FOLDER: './o', ALERT_ASSETS_FOLDER: './a', SFX_FOLDER: './s', UPLOAD_INCOMING_FOLDER: './i',
}));
vi.mock('./config', () => config);

import { checkUploadFolderPermissions, describePermissionProblems, uploadFolders } from './uploadFolderPermissions';

const UID = 1000;
/** Real-folder tests need POSIX modes: on Windows `chmod` only toggles the read-only bit. */
const isWindows = process.platform === 'win32';
let dir: string;
let alert: ReturnType<typeof vi.fn<(message: string) => Promise<unknown>>>;

beforeEach(() => {
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-perms-'));
  alert = vi.fn<(message: string) => Promise<unknown>>().mockResolvedValue(true);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('uploadFolders', () => {
  it('lists the overlay, alert asset, SFX and incoming upload folders', () => {
    expect(uploadFolders()).toEqual({ OVERLAY_FOLDER: './o', ALERT_ASSETS_FOLDER: './a', SFX_FOLDER: './s', UPLOAD_INCOMING_FOLDER: './i' });
  });
});

describe('describePermissionProblems', () => {
  it('flags group- and world-writable modes', () => {
    expect(describePermissionProblems({ mode: 0o40777, uid: UID }, UID)).toEqual(['writable by group or others (mode 777)']);
    expect(describePermissionProblems({ mode: 0o40770, uid: UID }, UID)).toHaveLength(1);
    expect(describePermissionProblems({ mode: 0o40702, uid: UID }, UID)).toHaveLength(1);
  });

  it('flags a folder owned by another uid', () => {
    expect(describePermissionProblems({ mode: 0o40700, uid: 0 }, UID)).toEqual([`owned by uid 0, not the bot's uid ${UID}`]);
  });

  it('accepts a 0o700 (or read-only-shared 0o755) folder owned by the process uid', () => {
    expect(describePermissionProblems({ mode: 0o40700, uid: UID }, UID)).toEqual([]);
    expect(describePermissionProblems({ mode: 0o40755, uid: UID }, UID)).toEqual([]);
  });
});

describe('checkUploadFolderPermissions', () => {
  it.skipIf(isWindows)('warns and alerts the owner about a real 0o777 folder', async () => {
    fs.chmodSync(dir, 0o777);
    const warnings = await checkUploadFolderPermissions(alert, { folders: { OVERLAY_FOLDER: dir }, uid: fs.statSync(dir).uid, platform: 'linux' });
    expect(warnings).toEqual([`OVERLAY_FOLDER (${dir}) is writable by group or others (mode 777)`]);
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('OVERLAY_FOLDER'));
    expect(alert).toHaveBeenCalledOnce();
    expect(alert.mock.calls[0]![0]).toContain(`OVERLAY_FOLDER (${dir})`);
    expect(alert.mock.calls[0]![0]).toContain('chmod -R go-w');
  });

  it.skipIf(isWindows)('does not warn about a real 0o700 folder owned by the process uid', async () => {
    fs.chmodSync(dir, 0o700);
    const warnings = await checkUploadFolderPermissions(alert, { folders: { OVERLAY_FOLDER: dir }, uid: fs.statSync(dir).uid, platform: 'linux' });
    expect(warnings).toEqual([]);
    expect(alert).not.toHaveBeenCalled();
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it('warns about a folder owned by a different uid (stubbed stat)', async () => {
    const stat = vi.fn().mockResolvedValue({ mode: 0o40700, uid: 0 });
    const warnings = await checkUploadFolderPermissions(alert, { uid: UID, platform: 'linux', stat });
    expect(stat).toHaveBeenCalledTimes(4);
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain(`owned by uid 0, not the bot's uid ${UID}`);
    expect(alert).toHaveBeenCalledOnce();
  });

  it('lists every problem with a folder in one line', async () => {
    const stat = vi.fn().mockResolvedValue({ mode: 0o40777, uid: 0 });
    const [line] = await checkUploadFolderPermissions(alert, { folders: { SFX_FOLDER: '/x' }, uid: UID, platform: 'linux', stat });
    expect(line).toBe(`SFX_FOLDER (${path.resolve('/x')}) is writable by group or others (mode 777) and owned by uid 0, not the bot's uid ${UID}`);
  });

  it('skips the check on win32', async () => {
    const stat = vi.fn().mockResolvedValue({ mode: 0o40777, uid: 0 });
    expect(await checkUploadFolderPermissions(alert, { uid: UID, platform: 'win32', stat })).toEqual([]);
    expect(stat).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it('skips a folder that does not exist yet without logging', async () => {
    const warnings = await checkUploadFolderPermissions(alert, { folders: { OVERLAY_FOLDER: path.join(dir, 'missing') }, platform: 'linux', uid: UID });
    expect(warnings).toEqual([]);
    expect(mockLog.warn).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it('logs and skips a folder whose stat fails for another reason', async () => {
    const stat = vi.fn().mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    const warnings = await checkUploadFolderPermissions(alert, { folders: { OVERLAY_FOLDER: '/x' }, platform: 'linux', uid: UID, stat });
    expect(warnings).toEqual([]);
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("Couldn't check the permissions of OVERLAY_FOLDER"), expect.anything());
    expect(alert).not.toHaveBeenCalled();
  });

  it('defaults to the process platform and uid', async () => {
    fs.chmodSync(dir, 0o700);
    const warnings = await checkUploadFolderPermissions(alert, { folders: { OVERLAY_FOLDER: dir } });
    expect(warnings).toEqual([]);
  });
});
