// Release workflow (GitHub-hosted Windows runner only; it installs software): installs the release's
// Setup.exe for the runner's user, checks what Windows sees, runs the app's self-test from the
// installed folder, checks that the freshly installed app makes no update request (no Update.exe,
// no outgoing connection) while its first-run notice is unanswered, then uninstalls and checks
// that everything is removed except the user's data.
//   node scripts/release/installer-smoke.mjs <Setup.exe> <version> [results.json]
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { squirrelVersion } from './squirrel-version.mjs';

const [setup, version, resultsFile] = process.argv.slice(2);
if (!setup || !version) throw new Error('usage: installer-smoke.mjs <Setup.exe> <version> [results.json]');
const sqVersion = squirrelVersion(version);
if (!process.env.GITHUB_ACTIONS && !process.argv.includes('--i-know-this-installs')) {
  console.error('This installs SplitNest for the current Windows user. It is meant for CI runners only.');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (cmd) => {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'SilentlyContinue'; ${cmd}`], { encoding: 'utf8', maxBuffer: 16 << 20 }).trim();
  } catch (e) {
    // A command whose target doesn't exist (no such process, no key) still prints what it found.
    return String(e?.stdout ?? '').trim();
  }
};
const json = (cmd) => {
  const out = ps(`$(${cmd}) | ConvertTo-Json -Depth 4 -Compress`);
  return out ? JSON.parse(out) : null;
};
const installDir = path.join(process.env.LOCALAPPDATA, 'splitnest');
const lnk = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'SplitNest.lnk');
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
};
const shortcut = () =>
  json(`if (Test-Path '${lnk}') { $f = Get-Item '${lnk}'; $sh = (New-Object -ComObject Shell.Application).NameSpace($f.DirectoryName).ParseName($f.Name); [pscustomobject]@{ target = (New-Object -ComObject WScript.Shell).CreateShortcut($f.FullName).TargetPath; aumid = $sh.ExtendedProperty('System.AppUserModel.ID') } }`);
const uninstallKey = () => json(`Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\splitnest' | Select-Object DisplayName, DisplayVersion, Publisher`);
const splitnestPids = () => (ps(`(Get-CimInstance Win32_Process -Filter "Name='splitnest.exe'").ProcessId`) || '').split(/\s+/).filter(Boolean).map(Number);

// The user's data must survive install and uninstall.
const userData = path.join(process.env.APPDATA, 'SplitNest');
mkdirSync(userData, { recursive: true });
writeFileSync(path.join(userData, 'keep-me.txt'), 'kept');

try {
  const t0 = Date.now();
  const inst = spawnSync(path.resolve(setup), ['--silent'], { timeout: 300_000 });
  check('installer exits cleanly', inst.status === 0, { exit: inst.status, seconds: Math.round((Date.now() - t0) / 1000) });
  const appDir = path.join(installDir, `app-${sqVersion}`);
  check(`installed per user in %LOCALAPPDATA%\\splitnest\\app-${sqVersion}`, existsSync(path.join(appDir, 'splitnest.exe')));

  // A silent install does not start the app; start it as the Start menu entry does (Squirrel's
  // launcher, which runs the newest installed version) and watch it before anyone answers the notice.
  spawn(path.join(installDir, 'splitnest.exe'), [], { stdio: 'ignore', detached: true }).unref();
  for (let i = 0; i < 30 && !splitnestPids().length; i++) await sleep(1000);
  check('the app starts from the launcher (as from the Start menu)', splitnestPids().length > 0);
  const watchUntil = Date.now() + 45_000;
  let updateExeSeen = false;
  const remote = new Set();
  while (Date.now() < watchUntil) {
    if (ps(`(Get-CimInstance Win32_Process -Filter "Name='Update.exe'" | Where-Object { $_.CommandLine -match '--update|--checkForUpdate|--download' }).ProcessId`)) updateExeSeen = true;
    const pids = splitnestPids();
    if (pids.length) {
      const conns = ps(`Get-NetTCPConnection -State Established,SynSent -OwningProcess ${pids.join(',')} | Where-Object { $_.RemoteAddress -notin '127.0.0.1','::1' } | ForEach-Object { '{0}:{1}' -f $_.RemoteAddress, $_.RemotePort }`);
      for (const c of conns.split(/\s+/).filter(Boolean)) remote.add(c);
    }
    await sleep(2000);
  }
  check('the app is still running after 45 s', splitnestPids().length > 0);
  check('no update request before the first-run notice is answered (no Update.exe update, no outgoing connection) for 45 s', !updateExeSeen && remote.size === 0, { updateExe: updateExeSeen, connections: [...remote] });
  ps(`Stop-Process -Name splitnest -Force`);
  await sleep(2000);

  const sc = shortcut();
  check('one Start menu entry, SplitNest.lnk, with the installed App User Model ID', sc && sc.aumid === 'com.squirrel.splitnest.splitnest' && /splitnest\\splitnest\.exe$/i.test(sc.target), sc);
  const key = uninstallKey();
  check('listed in installed apps as SplitNest, publisher SplitNest, this version', key && key.DisplayName === 'SplitNest' && key.Publisher === 'SplitNest' && key.DisplayVersion === sqVersion, key);

  const work = mkdtempSync(path.join(tmpdir(), 'tw-smoke-'));
  const out = path.join(work, 'st.json');
  const st = spawnSync(path.join(appDir, 'splitnest.exe'), [`--self-test-output=${out}`, `--tw-user-data=${path.join(work, 'ud')}`], { timeout: 120_000, windowsHide: true });
  const res = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
  check('self-test passes from the installed folder (PTY host, node-pty, shells)', st.status === 0 && res?.ok === true, { exit: st.status });

  const un = spawnSync(path.join(installDir, 'Update.exe'), ['--uninstall', '-s'], { timeout: 180_000 });
  await sleep(8000);
  check('uninstaller exits cleanly', un.status === 0, { exit: un.status });
  check('Start menu entry removed', !existsSync(lnk));
  check('removed from installed apps', uninstallKey() === null);
  check("the user's data folder is kept", existsSync(path.join(userData, 'keep-me.txt')));
  const left = existsSync(installDir) ? readdirSync(installDir) : [];
  console.log(`note: left in %LOCALAPPDATA%\\splitnest after uninstalling (Squirrel's deferred cleanup): ${JSON.stringify(left)}`);
} catch (e) {
  check('installer smoke test ran without error', false, String(e?.message ?? e));
}
if (resultsFile) {
  mkdirSync(path.dirname(path.resolve(resultsFile)), { recursive: true });
  writeFileSync(resultsFile, JSON.stringify(checks, null, 2));
}
const failed = checks.filter((c) => !c.ok).length;
console.log(failed ? `INSTALLER CHECK FAILED: ${failed} of ${checks.length}` : `Installer check: all ${checks.length} passed`);
process.exit(failed ? 1 : 0);
