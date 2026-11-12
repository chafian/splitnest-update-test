// Phase 0 spike (throwaway; runs on a GitHub Actions Windows runner, never on a developer PC):
// install SplitNest A with Squirrel, inspect what Windows sees, send a real test notification,
// upgrade to B from a local feed, then from the real feeds, then uninstall. Writes results JSON.
// Usage: node spike/lifecycle.mjs <setupA.exe> <feedDirB> <results.json> [remoteFeedUrl]
import { createRequire } from 'node:module';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const [setupA, feedB, resultsFile, remoteFeed] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = { steps: [] };
const record = (name, data) => {
  results.steps.push({ name, ...data });
  console.log(`${name}: ${JSON.stringify(data)}`);
  writeFileSync(resultsFile, JSON.stringify(results, null, 2));
};
const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', maxBuffer: 32 << 20 }).trim();
// Missing things (no key yet, no shortcut) are null, not errors.
const json = (cmd) => {
  try {
    const out = ps(`$ErrorActionPreference = 'SilentlyContinue'; ${cmd} | ConvertTo-Json -Depth 4 -Compress`);
    return out ? JSON.parse(out) : null;
  } catch (e) {
    return { error: String(e?.message ?? e).slice(0, 200) };
  }
};
const local = process.env.LOCALAPPDATA;
const roaming = process.env.APPDATA;
const installDir = path.join(local, 'splitnest');
const updateExe = path.join(installDir, 'Update.exe');
const userData = path.join(roaming, 'SplitNest');

const snapshot = () => ({
  installDir: existsSync(installDir) ? readdirSync(installDir) : null,
  shortcuts: json(`Get-ChildItem "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs" -Recurse -Filter *.lnk | Where-Object { $_.Name -like '*plit*' } | ForEach-Object {
      $sh = (New-Object -ComObject Shell.Application).NameSpace($_.DirectoryName).ParseName($_.Name)
      $l = (New-Object -ComObject WScript.Shell).CreateShortcut($_.FullName)
      [pscustomobject]@{ path = $_.FullName.Replace($env:APPDATA, '%APPDATA%'); target = $l.TargetPath.Replace($env:LOCALAPPDATA, '%LOCALAPPDATA%'); args = $l.Arguments; aumid = $sh.ExtendedProperty('System.AppUserModel.ID') } }`),
  startApps: json(`Get-StartApps | Where-Object { $_.Name -like '*plit*' -or $_.AppID -like '*plit*' }`),
  uninstallKey: json(`Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\splitnest' -ErrorAction SilentlyContinue | Select-Object DisplayName, DisplayVersion, Publisher, DisplayIcon, UninstallString`),
  processes: json(`Get-CimInstance Win32_Process -Filter "Name='splitnest.exe'" | ForEach-Object { $_.ExecutablePath.Replace($env:LOCALAPPDATA, '%LOCALAPPDATA%') } | Sort-Object -Unique`),
  userDataKept: existsSync(path.join(userData, 'keep-me.txt')),
});
const killApp = () => {
  try {
    execFileSync('taskkill.exe', ['/F', '/IM', 'splitnest.exe', '/T'], { stdio: 'ignore' });
  } catch {
    /* none */
  }
};
const selfTest = (exe) => {
  const work = mkdtempSync(path.join(tmpdir(), 'spike-st-'));
  const out = path.join(work, 'st.json');
  const r = spawnSync(exe, [`--self-test-output=${out}`, `--tw-user-data=${path.join(work, 'ud')}`], { timeout: 90_000, windowsHide: true });
  const res = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
  return { exit: r.status, ok: res?.ok ?? false };
};
const historyCount = (aumid) => {
  try {
    return Number(ps(`$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]; @([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('${aumid}')).Count`));
  } catch {
    return -1;
  }
};

try {
  // Existing user data must survive install, update and uninstall.
  mkdirSync(userData, { recursive: true });
  writeFileSync(path.join(userData, 'keep-me.txt'), 'kept');
  record('before', snapshot());

  // 1. Install A (Squirrel runs --squirrel-install, then starts the app with --squirrel-firstrun).
  const t0 = Date.now();
  const inst = spawnSync(setupA, ['--silent'], { timeout: 180_000 });
  await sleep(15_000);
  record('installed A', { setupExit: inst.status, seconds: (Date.now() - t0) / 1000, ...snapshot() });
  killApp();
  await sleep(2000);
  const appA = readdirSync(installDir).find((d) => d.startsWith('app-'));
  record('self-test from installed A', { appDir: appA, ...selfTest(path.join(installDir, appA, 'splitnest.exe')) });

  // 2. A real Windows notification from the installed app (Settings > Notifications > test).
  {
    const { chromium } = require('playwright-core');
    const port = 9400 + Math.floor(Math.random() * 300);
    const ud = mkdtempSync(path.join(tmpdir(), 'spike-ud-'));
    const app = spawn(path.join(installDir, appA, 'splitnest.exe'), [`--tw-user-data=${ud}`, `--remote-debugging-port=${port}`], { stdio: 'ignore' });
    let browser = null;
    let page = null;
    for (let i = 0; i < 60 && !page; i++) {
      await sleep(500);
      try {
        browser ??= await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        page = browser.contexts().flatMap((c) => c.pages()).find((x) => x.url().includes('index.html')) ?? null;
      } catch {
        /* not yet */
      }
    }
    let testResult = null;
    if (page) {
      await page.keyboard.press('Control+,');
      await page.click('.settings-nav__item:has-text("Notifications")');
      await page.click('button:has-text("Send a test notification")');
      await sleep(6000);
      testResult = await page.textContent('[data-testid="notification-test-result"]').catch(() => null);
      await browser.close().catch(() => undefined);
    }
    await sleep(2000);
    record('test notification from installed A', {
      attached: !!page,
      result: testResult,
      historySquirrelId: historyCount('com.squirrel.splitnest.splitnest'),
      historyElectronDefaultId: historyCount('electron.app.SplitNest'),
      ...snapshot(),
    });
    try {
      execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(app.pid)], { stdio: 'ignore' });
    } catch {
      /* gone */
    }
    await sleep(2000);
  }

  // 3. Upgrade A -> B from a local feed (what Electron's autoUpdater does: Update.exe --update <feed>).
  {
    const r = spawnSync(updateExe, ['--update', feedB], { timeout: 300_000, encoding: 'utf8' });
    await sleep(3000);
    const appDirs = readdirSync(installDir).filter((d) => d.startsWith('app-'));
    record('upgraded to B (local feed)', { exit: r.status, appDirs, ...snapshot() });
    const appB = appDirs.sort().at(-1);
    record('self-test from upgraded B', { appDir: appB, ...selfTest(path.join(installDir, appB, 'splitnest.exe')) });
    // Starting from the shortcut's command runs the newest version.
    spawn(updateExe, ['--processStart', 'splitnest.exe'], { stdio: 'ignore', detached: true }).unref();
    await sleep(10_000);
    record('started through Update.exe --processStart', { processes: snapshot().processes });
    killApp();
    await sleep(2000);
  }

  // 4. The real feed (update service or GitHub), if given: ask Update.exe whether there is an update.
  if (remoteFeed) {
    const r = spawnSync(updateExe, ['--checkForUpdate', remoteFeed], { timeout: 120_000, encoding: 'utf8' });
    record('checkForUpdate against the remote feed', { feed: remoteFeed, exit: r.status, stdoutTail: (r.stdout ?? '').slice(-600) });
  }

  // 5. Uninstall.
  {
    const r = spawnSync(updateExe, ['--uninstall', '-s'], { timeout: 180_000 });
    await sleep(8000);
    record('uninstalled', { exit: r.status, ...snapshot() });
  }
} catch (e) {
  record('error', { message: String(e?.stack ?? e) });
}
writeFileSync(resultsFile, JSON.stringify(results, null, 2));
