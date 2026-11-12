// The whole Windows update lifecycle against real GitHub Releases (GitHub-hosted runner only: it
// installs software). Meant for a test repository whose releases were made by release.yml:
//   node tests/windows/update-lifecycle.mjs <owner/repo> <older tag> <newer version> <results.json>
//
//  1. install the older release's Setup.exe;
//  2. start it: no update request (no Update.exe, no outgoing connection) while the first-run
//     notice is unanswered;
//  3. answer "Keep automatic updates": the update is found and downloaded in the background from
//     the repository's GitHub Releases, and "Update ready" appears;
//  4. "Restart now": SplitNest quits and the newer version starts; settings are kept;
//  5. the newer version: one Start menu entry, a real notification under the installed App ID;
//  6. a corrupted update package is refused and the installed version keeps working;
//  7. uninstall.
import { createRequire } from 'node:module';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const { chromium } = require('playwright-core');
const [repo, oldTag, newVersion, resultsFile] = process.argv.slice(2);
if (!process.env.GITHUB_ACTIONS) {
  console.error('This installs SplitNest for the current Windows user. It is meant for CI runners only.');
  process.exit(2);
}
const oldVersion = oldTag.replace(/^v/, '');
mkdirSync(path.dirname(path.resolve(resultsFile)), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (cmd) => {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'SilentlyContinue'; ${cmd}`], { encoding: 'utf8', maxBuffer: 16 << 20 }).trim();
  } catch (e) {
    // A command whose target doesn't exist (no such process, no key) still prints what it found.
    return String(e?.stdout ?? '').trim();
  }
};
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
  writeFileSync(resultsFile, JSON.stringify(checks, null, 2));
};
const installDir = path.join(process.env.LOCALAPPDATA, 'splitnest');
const updateExe = path.join(installDir, 'Update.exe');
const appExe = (v) => path.join(installDir, `app-${v}`, 'splitnest.exe');
const procPaths = () => (ps(`Get-CimInstance Win32_Process -Filter "Name='splitnest.exe'" | ForEach-Object { $_.ExecutablePath }`) || '').split(/\r?\n/).filter(Boolean);
const killApp = async () => {
  ps('Stop-Process -Name splitnest -Force');
  await sleep(2500);
};
const stateFile = path.join(process.env.APPDATA, 'SplitNest', 'workspace-state.json');
const attach = async (exe, args = []) => {
  const port = 9400 + Math.floor(Math.random() * 300);
  spawn(exe, [`--remote-debugging-port=${port}`, ...args], { stdio: 'ignore', detached: true }).unref();
  let browser = null;
  let page = null;
  for (let i = 0; i < 80 && !page; i++) {
    await sleep(500);
    try {
      browser ??= await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      page = browser.contexts().flatMap((c) => c.pages()).find((x) => x.url().includes('index.html')) ?? null;
    } catch {
      /* not yet */
    }
  }
  if (!page) throw new Error('could not attach to the app');
  page.setDefaultTimeout(20_000);
  return { browser, page };
};

try {
  // 1. Install the older release.
  const setup = path.join(mkdtempSync(path.join(tmpdir(), 'tw-upd-')), 'Setup.exe');
  execFileSync('curl.exe', ['-sSfL', '-o', setup, `https://github.com/${repo}/releases/download/${oldTag}/SplitNest-win32-x64-Setup.exe`]);
  const inst = spawnSync(setup, ['--silent'], { timeout: 300_000 });
  await sleep(10_000);
  check(`installed ${oldTag}`, inst.status === 0 && existsSync(appExe(oldVersion)), { exit: inst.status });
  await killApp();

  // 2. Start it (the user's normal profile) and watch: nothing before the notice is answered.
  let { browser, page } = await attach(appExe(oldVersion));
  await page.waitForSelector('[data-testid="update-notice"]', { timeout: 30_000 });
  const until = Date.now() + 45_000;
  let updateExeSeen = false;
  const remote = new Set();
  while (Date.now() < until) {
    if (ps(`(Get-CimInstance Win32_Process -Filter "Name='Update.exe'" | Where-Object { $_.CommandLine -match '--update|--checkForUpdate|--download' }).ProcessId`)) updateExeSeen = true;
    const pids = (ps(`(Get-CimInstance Win32_Process -Filter "Name='splitnest.exe'").ProcessId`) || '').split(/\s+/).filter(Boolean);
    if (pids.length) {
      for (const c of ps(`Get-NetTCPConnection -State Established,SynSent -OwningProcess ${pids.join(',')} | Where-Object { $_.RemoteAddress -notin '127.0.0.1','::1' } | ForEach-Object { '{0}:{1}' -f $_.RemoteAddress, $_.RemotePort }`).split(/\s+/).filter(Boolean)) remote.add(c);
    }
    await sleep(2000);
  }
  check('no update request while the first-run notice is unanswered (45 s)', !updateExeSeen && remote.size === 0, { updateExe: updateExeSeen, connections: [...remote] });

  // 3. Keep automatic updates: found and downloaded in the background.
  await page.click('[data-testid="update-notice-keep"]');
  const t0 = Date.now();
  const ready = await page.waitForSelector('[data-testid="update-ready"]', { timeout: 300_000 }).then(() => true).catch(() => false);
  check(`update to ${newVersion} downloaded in the background and "Update ready" shown`, ready && existsSync(appExe(newVersion)), { seconds: Math.round((Date.now() - t0) / 1000), staged: existsSync(appExe(newVersion)) });

  // 4. Restart now (no running shell, so the quit flow does not ask).
  await page.click('[data-testid="update-restart"]');
  await browser.close().catch(() => undefined);
  const restarted = await (async () => {
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      if (procPaths().some((p) => p.toLowerCase() === appExe(newVersion).toLowerCase())) return true;
    }
    return false;
  })();
  check(`"Restart now": SplitNest restarted as ${newVersion}`, restarted, { running: procPaths() });
  const settings = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')).settings : null;
  check('settings kept across the update (notice answered, updates on)', settings?.updateNoticeSeen === true && settings?.updateCheck === true);
  await killApp();

  // 5. The newer version: Start menu entry and a real notification.
  const lnk = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const entries = ps(`Get-ChildItem '${lnk}' -Recurse -Filter *.lnk | Where-Object { $_.Name -like '*plit*' } | ForEach-Object { $_.FullName }`).split(/\r?\n/).filter(Boolean);
  check('one Start menu entry after the update', entries.length === 1, entries.map((e) => path.basename(e)));
  ({ browser, page } = await attach(appExe(newVersion)));
  await page.keyboard.press('Control+,');
  await page.click('.settings-nav__item:has-text("Notifications")');
  await page.click('button:has-text("Send a test notification")');
  await sleep(6000);
  const delivered = Number(ps(`$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]; @([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('com.squirrel.splitnest.splitnest')).Count`));
  check('a notification from the updated app is delivered under the installed App ID', delivered >= 1, { history: delivered });
  await browser.close().catch(() => undefined);
  await killApp();

  // 6. A corrupted update package is refused; the installed version keeps working.
  const bad = mkdtempSync(path.join(tmpdir(), 'tw-bad-'));
  const pk = readdirSync(path.join(installDir, 'packages')).find((f) => f.endsWith(`${newVersion}-full.nupkg`));
  if (pk) {
    const fake = pk.replace(newVersion, '9.9.9');
    copyFileSync(path.join(installDir, 'packages', pk), path.join(bad, fake));
    const releases = readFileSync(path.join(installDir, 'packages', 'RELEASES'), 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/).find((l) => l.includes(pk));
    const buf = readFileSync(path.join(bad, fake));
    buf[buf.length >> 1] ^= 0xff; // corrupt the package; RELEASES keeps the original SHA-1
    writeFileSync(path.join(bad, fake), buf);
    writeFileSync(path.join(bad, 'RELEASES'), releases.replace(pk, fake));
    const r = spawnSync(updateExe, ['--update', bad], { timeout: 180_000, encoding: 'utf8' });
    const st = mkdtempSync(path.join(tmpdir(), 'tw-st-'));
    const out = path.join(st, 'st.json');
    spawnSync(appExe(newVersion), [`--self-test-output=${out}`, `--tw-user-data=${path.join(st, 'ud')}`], { timeout: 120_000, windowsHide: true });
    const ok = existsSync(out) && JSON.parse(readFileSync(out, 'utf8')).ok === true;
    check('a corrupted update is refused and the installed version still works', r.status !== 0 && !existsSync(appExe('9.9.9')) && ok, { updateExit: r.status, selfTest: ok });
  } else {
    check('a corrupted update is refused and the installed version still works', false, 'package of the new version not found');
  }

  // 7. Uninstall.
  const un = spawnSync(updateExe, ['--uninstall', '-s'], { timeout: 180_000 });
  await sleep(8000);
  check('uninstalled; settings kept', un.status === 0 && existsSync(stateFile) && !ps(`Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\splitnest' | Select-Object -ExpandProperty DisplayName`), { exit: un.status });
} catch (e) {
  check('update lifecycle ran without error', false, String(e?.stack ?? e).slice(0, 600));
}
const failed = checks.filter((c) => !c.ok).length;
console.log(failed ? `UPDATE LIFECYCLE FAILED: ${failed} of ${checks.length}` : `Update lifecycle: all ${checks.length} passed`);
process.exit(failed ? 1 : 0);
