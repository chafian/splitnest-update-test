// Squirrel.Windows installer integration (see forge.config.ts, MakerSquirrel).
//
// The installed app lives in %LocalAppData%\splitnest\app-<version>\, next to Squirrel's
// Update.exe. Squirrel starts the app with an extra argument while installing, updating and
// uninstalling it; the app must then do that job (shortcuts) and quit at once, without opening a
// window or taking the single-instance lock. This module is imported first by main.ts so that it
// runs before any other module's start-up code.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export type SquirrelEvent = 'install' | 'updated' | 'uninstall' | 'obsolete' | 'firstrun';

/** The Squirrel event in the app's arguments (`--squirrel-install 0.2.0`, …), or null. */
export function squirrelEvent(argv: readonly string[]): SquirrelEvent | null {
  const m = /^--squirrel-(install|updated|uninstall|obsolete|firstrun)$/.exec(argv[1] ?? '');
  return m ? (m[1] as SquirrelEvent) : null;
}

/** Squirrel's Update.exe for an installed copy (one folder up from app-<version>), or null. */
export function updateExePath(execPath: string, exists: (p: string) => boolean = existsSync): string | null {
  const p = path.resolve(path.dirname(execPath), '..', 'Update.exe');
  return exists(p) ? p : null;
}

/**
 * The Update.exe arguments for an event, or null when there is nothing to run. Shortcuts go to the
 * Start menu only (no desktop clutter); `--createShortcut` on an update keeps the existing one.
 */
export function squirrelCommand(event: SquirrelEvent, exeName: string): string[] | null {
  if (event === 'install' || event === 'updated') return ['--createShortcut', exeName, '--shortcut-locations', 'StartMenu'];
  if (event === 'uninstall') return ['--removeShortcut', exeName, '--shortcut-locations', 'StartMenu'];
  return null;
}

/** Windows App User Model ID of the installed app's Start menu shortcut (Squirrel's scheme). */
export function squirrelAppUserModelId(packageName: string, exeName: string): string {
  return `com.squirrel.${packageName}.${exeName.replace(/\.exe$/i, '')}`;
}

/**
 * Handles a Squirrel event and returns true when the process must exit now (everything except
 * the first run after installing, which is a normal start).
 */
export function handleSquirrelEvent(argv: readonly string[], execPath: string): boolean {
  if (process.platform !== 'win32') return false;
  const event = squirrelEvent(argv);
  if (!event || event === 'firstrun') return false;
  const update = updateExePath(execPath);
  const args = squirrelCommand(event, path.basename(execPath));
  if (update && args) spawnSync(update, args, { windowsHide: true, timeout: 15_000 });
  return true;
}

if (handleSquirrelEvent(process.argv, process.execPath)) process.exit(0);
