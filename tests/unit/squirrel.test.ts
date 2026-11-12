// Squirrel.Windows start-up events (src/main/squirrel.ts).
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { writeShortcutLink: vi.fn(() => true) } }));
const { INSTALLED_APP_ID, INSTALLED_TOAST_CLSID, squirrelAppUserModelId, squirrelEvent, squirrelPlan, startMenuShortcut, updateExePath } = await import('../../src/main/squirrel');

const APPDATA = 'C:\\Users\\me\\AppData\\Roaming';
const EXE = 'C:\\Users\\me\\AppData\\Local\\splitnest\\app-0.2.0\\splitnest.exe';

describe('Squirrel.Windows integration', () => {
  it('recognises only the exact Squirrel event in first position', () => {
    expect(squirrelEvent(['splitnest.exe', '--squirrel-install', '0.2.0'])).toBe('install');
    expect(squirrelEvent(['splitnest.exe', '--squirrel-updated', '0.2.1'])).toBe('updated');
    expect(squirrelEvent(['splitnest.exe', '--squirrel-uninstall', '0.2.1'])).toBe('uninstall');
    expect(squirrelEvent(['splitnest.exe', '--squirrel-obsolete', '0.2.0'])).toBe('obsolete');
    expect(squirrelEvent(['splitnest.exe', '--squirrel-firstrun'])).toBe('firstrun');
    expect(squirrelEvent(['splitnest.exe'])).toBeNull();
    expect(squirrelEvent(['splitnest.exe', '--tw-user-data=x', '--squirrel-install'])).toBeNull();
    expect(squirrelEvent(['splitnest.exe', '--squirrel-installx'])).toBeNull();
  });

  it('install and update write one Start menu entry where Electron looks, with the installed IDs, pointing at the launcher', () => {
    for (const ev of ['install', 'updated'] as const) {
      const plan = squirrelPlan(ev, EXE, APPDATA)!;
      expect(plan.write).toEqual({
        shortcut: `${APPDATA}\\Microsoft\\Windows\\Start Menu\\Programs\\SplitNest.lnk`,
        target: 'C:\\Users\\me\\AppData\\Local\\splitnest\\splitnest.exe',
        appUserModelId: 'com.squirrel.splitnest.splitnest',
        toastActivatorClsid: INSTALLED_TOAST_CLSID,
      });
      expect(plan.remove).toEqual([`${APPDATA}\\Microsoft\\Windows\\Start Menu\\Programs\\SplitNest\\SplitNest.lnk`]);
      expect(plan.registry).toEqual([]);
    }
  });

  it('uninstall removes the entry, the notification activator and the notification settings of the installed app only', () => {
    const plan = squirrelPlan('uninstall', EXE, APPDATA)!;
    expect(plan.write).toBeNull();
    expect(plan.remove).toContain(startMenuShortcut(APPDATA));
    expect(plan.registry).toEqual([
      `HKCU\\Software\\Classes\\CLSID\\${INSTALLED_TOAST_CLSID}`,
      `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${INSTALLED_APP_ID}`,
    ]);
  });

  it('an old version after an update, and the first run, change nothing', () => {
    expect(squirrelPlan('obsolete', EXE, APPDATA)).toBeNull();
    expect(squirrelPlan('firstrun', EXE, APPDATA)).toBeNull();
  });

  it('finds Update.exe one folder above the versioned app folder, only for an installed copy', () => {
    expect(updateExePath(EXE, (p) => p === 'C:\\Users\\me\\AppData\\Local\\splitnest\\Update.exe')).toBe('C:\\Users\\me\\AppData\\Local\\splitnest\\Update.exe');
    expect(updateExePath('C:\\portable\\SplitNest\\splitnest.exe', () => false)).toBeNull();
  });

  it("uses Squirrel's App User Model ID scheme, and a well-formed fixed activator CLSID", () => {
    expect(squirrelAppUserModelId('splitnest', 'splitnest.exe')).toBe('com.squirrel.splitnest.splitnest');
    expect(INSTALLED_APP_ID).toBe('com.squirrel.splitnest.splitnest');
    expect(INSTALLED_TOAST_CLSID).toMatch(/^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/);
  });
});
