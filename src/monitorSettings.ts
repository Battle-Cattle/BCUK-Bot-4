import fs from 'fs';
import path from 'path';

const SETTINGS_FILE = path.join(process.cwd(), 'monitor-settings.json');

interface MonitorSettings {
  twitchMonitorEnabled: boolean;
  eventSubToken?: string;
}

function readSettings(): MonitorSettings {
  try {
    const content = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    return JSON.parse(content) as MonitorSettings;
  } catch {
    return { twitchMonitorEnabled: true };
  }
}

function writeSettings(settings: MonitorSettings): void {
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
