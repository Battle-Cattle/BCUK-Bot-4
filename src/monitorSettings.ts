import fs from 'fs';
import path from 'path';

const SETTINGS_FILE = path.join(process.cwd(), 'monitor-settings.json');

interface MonitorSettings {
  twitchMonitorEnabled: boolean;
  customCommandsLiveReplies: boolean;
  counterLiveWrites: boolean;
}

const DEFAULTS: MonitorSettings = {
  twitchMonitorEnabled: false,
  customCommandsLiveReplies: false,
  counterLiveWrites: false,
};

let cachedSettings: MonitorSettings | null = null;

function readSettings(): MonitorSettings {
  if (cachedSettings) {
    return cachedSettings;
  }

  try {
    const content = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed.twitchMonitorEnabled === 'boolean') {
      cachedSettings = {
        twitchMonitorEnabled: parsed.twitchMonitorEnabled,
        customCommandsLiveReplies: typeof parsed.customCommandsLiveReplies === 'boolean' ? parsed.customCommandsLiveReplies : false,
        counterLiveWrites: typeof parsed.counterLiveWrites === 'boolean' ? parsed.counterLiveWrites : false,
      };
    } else {
      console.warn('[MonitorSettings] Settings file has unexpected shape — using defaults');
      cachedSettings = { ...DEFAULTS };
    }
  } catch {
    cachedSettings = { ...DEFAULTS };
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

export function getCustomCommandsLiveReplies(): boolean {
  return readSettings().customCommandsLiveReplies;
}

export function getCounterLiveWrites(): boolean {
  return readSettings().counterLiveWrites;
}

export function setAllLive(enabled: boolean): void {
  writeSettings({ twitchMonitorEnabled: enabled, customCommandsLiveReplies: enabled, counterLiveWrites: enabled });
}
