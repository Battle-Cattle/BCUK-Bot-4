import fs from 'fs';
import path from 'path';

const SETTINGS_FILE = path.join(process.cwd(), 'monitor-settings.json');

interface MonitorSettings {
  twitchMonitorEnabled: boolean;
  eventSubToken?: string;
}

let cachedSettings: MonitorSettings | null = null;

function readSettings(): MonitorSettings {
  if (cachedSettings) {
    return cachedSettings;
  }

  try {
    const content = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    cachedSettings = JSON.parse(content) as MonitorSettings;
  } catch {
    cachedSettings = { twitchMonitorEnabled: true };
  }

  return cachedSettings;
}

function writeSettings(settings: MonitorSettings): void {
  cachedSettings = settings;
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
}

export function getMonitorEnabled(): boolean {
  return readSettings().twitchMonitorEnabled;
}

export function setMonitorEnabled(enabled: boolean): void {
  const settings = readSettings();
  settings.twitchMonitorEnabled = enabled;
  writeSettings(settings);
}

/** Returns the stored EventSub user token, or null if not yet authorised. */
export function getEventSubToken(): string | null {
  return readSettings().eventSubToken ?? null;
}

export function setEventSubToken(token: string): void {
  const settings = readSettings();
  settings.eventSubToken = token;
  writeSettings(settings);
}
