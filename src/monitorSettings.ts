import fs from 'fs';
import path from 'path';

const SETTINGS_FILE = path.join(process.cwd(), 'monitor-settings.json');

interface MonitorSettings {
  twitchMonitorEnabled: boolean;
}

let cachedSettings: MonitorSettings | null = null;

function readSettings(): MonitorSettings {
  if (cachedSettings) {
    return cachedSettings;
  }

  try {
    const content = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    cachedSettings = JSON.parse(content) as MonitorSettings;
  } catch (err) {
    console.warn(`[MonitorSettings] Failed to read ${SETTINGS_FILE}:`, err);
    cachedSettings = { twitchMonitorEnabled: true };
  }

  return cachedSettings;
}

function writeSettings(settings: MonitorSettings): void {
  const json = JSON.stringify(settings, null, 2);
  // Write temp file beside the target so rename() stays on the same filesystem.
  const tmpFile = path.join(path.dirname(SETTINGS_FILE), `.monitor-settings-${process.pid}.tmp`);
  const fd = fs.openSync(tmpFile, 'w', 0o600);
  try {
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpFile, SETTINGS_FILE);
  // Only update the cache after a successful disk write to keep cache/disk in sync.
  cachedSettings = settings;
}

export function getMonitorEnabled(): boolean {
  return readSettings().twitchMonitorEnabled;
}

export function setMonitorEnabled(enabled: boolean): void {
  const settings = readSettings();
  settings.twitchMonitorEnabled = enabled;
  writeSettings(settings);
}
