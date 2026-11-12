// Squirrel.Windows start-up events (src/main/squirrel.ts).
import { describe, expect, it } from 'vitest';
import { squirrelAppUserModelId, squirrelCommand, squirrelEvent, updateExePath } from '../../src/main/squirrel';

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

  it('runs Update.exe for shortcuts on install, update and uninstall; nothing on obsolete or first run', () => {
    expect(squirrelCommand('install', 'splitnest.exe')).toEqual(['--createShortcut', 'splitnest.exe', '--shortcut-locations', 'StartMenu']);
    expect(squirrelCommand('updated', 'splitnest.exe')).toEqual(['--createShortcut', 'splitnest.exe', '--shortcut-locations', 'StartMenu']);
    expect(squirrelCommand('uninstall', 'splitnest.exe')).toEqual(['--removeShortcut', 'splitnest.exe', '--shortcut-locations', 'StartMenu']);
    expect(squirrelCommand('obsolete', 'splitnest.exe')).toBeNull();
    expect(squirrelCommand('firstrun', 'splitnest.exe')).toBeNull();
  });

  it('finds Update.exe one folder above the versioned app folder, only for an installed copy', () => {
    const exe = 'C:\\Users\\me\\AppData\\Local\\splitnest\\app-0.2.0\\splitnest.exe';
    expect(updateExePath(exe, (p) => p === 'C:\\Users\\me\\AppData\\Local\\splitnest\\Update.exe')).toBe('C:\\Users\\me\\AppData\\Local\\splitnest\\Update.exe');
    expect(updateExePath('C:\\portable\\SplitNest\\splitnest.exe', () => false)).toBeNull();
  });

  it("uses Squirrel's App User Model ID scheme", () => {
    expect(squirrelAppUserModelId('splitnest', 'splitnest.exe')).toBe('com.squirrel.splitnest.splitnest');
  });
});
