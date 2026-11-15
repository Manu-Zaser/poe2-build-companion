import { app } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Small log file in the user data folder (for support), plus the console in development. */
export function log(message: string) {
  const line = `${new Date().toISOString()} ${message}\n`;
  if (!app.isPackaged) process.stdout.write(line);
  try {
    const dir = app.getPath('userData');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'companion.log'), line);
  } catch {
    // logging must never break the app
  }
}
