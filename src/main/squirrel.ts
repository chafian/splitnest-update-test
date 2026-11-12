// Squirrel.Windows installer integration (see forge.config.ts, MakerSquirrel).
//
// The installed app lives in %LocalAppData%\splitnest\app-<version>\, next to Squirrel's
// Update.exe and a small splitnest.exe launcher that always starts the newest version. Squirrel
// starts the app with an extra argument while installing, updating and uninstalling it; the app
// must then do that job and quit at once, without opening a window or taking the single-instance
// lock. This module is imported first by main.ts so that it runs before any other start-up code.
//
// Start menu entry: SplitNest writes it itself, at Programs\SplitNest.lnk, with the App User Model
// ID and toast activator CLSID the installed app uses (see main.ts). That is where Electron looks
// before showing a notification; Squirrel's own --createShortcut puts it in a Programs\<company>\
// subfolder, so Electron added a second entry at the first notification, which Squirrel's
// uninstall then left behind (measured on a GitHub Actions runner, docs/TESTING.md).
import { spawnSync } from 'node:child_process';
import { existsSync, rmdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { shell } from 'electron';
import { PRODUCT } from '../shared/product';

export type SquirrelEvent = 'install' | 'updated' | 'uninstall' | 'obsolete' | 'firstrun';

/** Toast activator CLSID of installed builds (fixed: it is written into the Start menu entry). */
export const INSTALLED_TOAST_CLSID = '{6F3B9C2E-4A1D-4E7B-9C58-2B7D1E0A9F43}';

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

/** Windows App User Model ID of the installed app (Squirrel's scheme). */
export function squirrelAppUserModelId(packageName: string, exeName: string): string {
  return `com.squirrel.${packageName}.${exeName.replace(/\.exe$/i, '')}`;
}

export const INSTALLED_APP_ID = squirrelAppUserModelId(PRODUCT.executableName, `${PRODUCT.executableName}.exe`);

/** Where Electron looks for the app's Start menu entry (Programs\<app name>.lnk). */
export function startMenuShortcut(appData: string): string {
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${PRODUCT.name}.lnk`);
}

/** Squirrel's own entry, in a Programs\<company>\ subfolder (removed: SplitNest writes its own). */
export function squirrelSubfolderShortcut(appData: string): string {
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', PRODUCT.name, `${PRODUCT.name}.lnk`);
}

/**
 * What an event changes, as a plan (tested without touching Windows):
 * - install / updated: write the Start menu entry (pointing at the launcher in the install folder);
 * - uninstall: remove it, plus the notification activator and notification settings registered
 *   for the installed app's ID;
 * - obsolete (an old version after an update) and firstrun: nothing.
 */
export function squirrelPlan(event: SquirrelEvent, execPath: string, appData: string) {
  const launcher = path.resolve(path.dirname(execPath), '..', `${PRODUCT.executableName}.exe`);
  const shortcut = startMenuShortcut(appData);
  const remove = [squirrelSubfolderShortcut(appData)];
  if (event === 'install' || event === 'updated') {
    return { write: { shortcut, target: launcher, appUserModelId: INSTALLED_APP_ID, toastActivatorClsid: INSTALLED_TOAST_CLSID }, remove, registry: [] as string[] };
  }
  if (event === 'uninstall') {
    return {
      write: null,
      remove: [shortcut, ...remove],
      registry: [`HKCU\\Software\\Classes\\CLSID\\${INSTALLED_TOAST_CLSID}`, `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${INSTALLED_APP_ID}`],
    };
  }
  return null;
}

/**
 * Handles a Squirrel event and returns true when the process must exit now (everything except
 * the first run after installing, which is a normal start).
 */
export function handleSquirrelEvent(argv: readonly string[], execPath: string): boolean {
  if (process.platform !== 'win32') return false;
  const event = squirrelEvent(argv);
  if (!event || event === 'firstrun') return false;
  const appData = process.env.APPDATA;
  const plan = appData && updateExePath(execPath) ? squirrelPlan(event, execPath, appData) : null;
  if (appData && plan) {
    for (const p of plan.remove) rmSync(p, { force: true });
    try {
      rmdirSync(path.dirname(squirrelSubfolderShortcut(appData))); // only if empty
    } catch {
      /* absent or not empty */
    }
    if (plan.write) {
      shell.writeShortcutLink(plan.write.shortcut, 'replace', {
        target: plan.write.target,
        cwd: path.dirname(plan.write.target),
        icon: plan.write.target,
        iconIndex: 0,
        description: PRODUCT.name,
        appUserModelId: plan.write.appUserModelId,
        toastActivatorClsid: plan.write.toastActivatorClsid,
      });
    }
    for (const key of plan.registry) spawnSync('reg.exe', ['delete', key, '/f'], { windowsHide: true, timeout: 10_000 });
  }
  return true;
}

if (handleSquirrelEvent(process.argv, process.execPath)) process.exit(0);
