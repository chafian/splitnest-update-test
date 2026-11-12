// Electron main process: window lifecycle, security policy, persistence,
// shell discovery and session authorization.
// First: Squirrel's install/update/uninstall launches do their job and exit before anything else runs.
import { INSTALLED_APP_ID, INSTALLED_TOAST_CLSID, updateExePath } from './squirrel';
import { app, BrowserWindow, dialog, Menu, nativeImage, Notification, session, webContents } from 'electron';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { IPC } from '../shared/ipc';
import { PRODUCT } from '../shared/product';
import type { SessionEvent } from '../shared/types';
import { runFile } from './exec';
import { registerIpc } from './ipc';
import { createLaunchResolver, isDirectory, ShellCache } from './launch-resolver';
import { createLogger } from './logger';
import { PtyHostClient } from './pty-host-client';
import { runSelfTest } from './self-test';
import { OpenFileWatcher } from './file-watch';
import { AgentMonitor } from './agent-monitor';
import { AgentSessionTracker } from './agent-sessions';
import { GitStatusService } from './git-status';
import { NotificationService, notifyIdPrefix, showAgainOnceRegistered, type NativeNotification } from './notifications';
import { findPaneOfTab } from '../shared/layout';
import { QuitCoordinator, quitDialogModel, type QuitChoice, type QuitPrompt, type SaveAllResult } from './quit-flow';
import { SessionBroker } from './session-broker';
import { fileExists, findOnPath } from './shells';
import { StateStore } from './state-store';

const startedAt = Date.now() - Math.round(performance.now());
/** Must match --titlebar-height in the renderer's tokens.css. */
const TITLE_BAR_HEIGHT = 40;

app.setName(PRODUCT.name);
// Installed with Squirrel: notifications must carry the App User Model ID and activator CLSID of
// the Start menu entry that squirrel.ts writes, or Windows treats them as another app's (and
// Electron would add a second entry).
if (process.platform === 'win32' && updateExePath(process.execPath)) {
  app.setAppUserModelId(INSTALLED_APP_ID);
  app.setToastActivatorCLSID(INSTALLED_TOAST_CLSID);
}
const userDataArg = process.argv.find((a) => a.startsWith('--tw-user-data='));
if (userDataArg) app.setPath('userData', path.resolve(userDataArg.slice('--tw-user-data='.length)));
const selfTestArg = process.argv.find((a) => a.startsWith('--self-test-output='));

if (!selfTestArg && !app.requestSingleInstanceLock()) {
  app.exit(0);
}

const log = createLogger(path.join(app.getPath('userData'), 'logs', PRODUCT.logFileName), !app.isPackaged);
const stateFile = path.join(app.getPath('userData'), PRODUCT.stateFileName);

// After a rename, copy saved workspaces from the previous app-data folder once.
// The old file is left untouched; nothing is copied if a state file already exists.
if (!userDataArg && !selfTestArg && !existsSync(stateFile)) {
  for (const legacy of PRODUCT.legacyNames) {
    const old = path.join(app.getPath('appData'), legacy, PRODUCT.stateFileName);
    if (!existsSync(old)) continue;
    try {
      mkdirSync(path.dirname(stateFile), { recursive: true });
      copyFileSync(old, stateFile);
      log.info(`copied saved workspaces from previous app name "${legacy}"`);
    } catch (error) {
      log.warn(`could not copy saved workspaces from "${legacy}": ${(error as Error).message}`);
    }
    break;
  }
}
const store = new StateStore(stateFile, log);
const shells = new ShellCache({ env: process.env, exists: fileExists, run: runFile });

const rendererIndex = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
const devServerUrl = typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === 'string' ? MAIN_WINDOW_VITE_DEV_SERVER_URL : '';

function isTrustedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (devServerUrl) return parsed.origin === new URL(devServerUrl).origin;
    parsed.hash = '';
    parsed.search = '';
    return parsed.href === pathToFileURL(rendererIndex).href;
  } catch {
    return false;
  }
}

const nodePtyPath = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'node-pty')
  : path.join(app.getAppPath(), 'node_modules', 'node-pty');

let mainWindow: BrowserWindow | null = null;

const deliver = (ownerId: number, event: SessionEvent): boolean => {
  const target = webContents.fromId(ownerId);
  if (!target || target.isDestroyed()) return false;
  target.send(IPC.sessionEvent, event);
  return true;
};

// eslint-disable-next-line prefer-const -- assigned after the broker that it calls back into
let broker: SessionBroker;
const host = new PtyHostClient(
  path.join(__dirname, 'pty-host.js'),
  nodePtyPath,
  (event) => broker.handleHostEvent(event),
  (reason) => broker.handleHostExit(reason),
  log,
);
broker = new SessionBroker(
  host,
  createLaunchResolver({
    getWorkspace: (id) => store.getWorkspace(id),
    getShells: () => shells.get(),
    isDirectory,
    exists: fileExists,
    run: runFile,
    env: process.env,
    homeDir: os.homedir(),
    // Automated runs must not write test commands into the user's PowerShell history, nor
    // take its shared lock (they kill shells at the end). Never in packaged builds.
    isolatePowerShellHistory: !app.isPackaged && process.env.TW_E2E === '1',
  }),
  deliver,
  log,
  { onOutput: (workspaceId) => gitStatus.noteOutput(workspaceId) },
);

/** Editor tabs with unsaved changes, as last reported by the renderer. */
let unsavedEditors = 0;

const fileWatcher = new OpenFileWatcher(
  (t) => {
    const contents = webContents.fromId(t.ownerId);
    if (contents && !contents.isDestroyed()) contents.send(IPC.fileChanged, { workspaceId: t.workspaceId, path: t.relativePath });
  },
  { onError: (message) => log.warn(message) },
);

const agentMonitor = new AgentMonitor({
  sessions: () => broker.runningProcesses(),
  report: (ownerId, sessionId, agent) => {
    const contents = webContents.fromId(ownerId);
    if (contents && !contents.isDestroyed()) contents.send(IPC.sessionAgent, { sessionId, agent });
  },
  powershellPath: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  log: (message) => log.warn(message),
  resume: {
    tracker: new AgentSessionTracker({
      // Development E2E runs point this at a temporary folder (never in packaged builds).
      home: (!app.isPackaged && process.env.TW_E2E === '1' && process.env.TW_E2E_AGENT_HOME) || os.homedir(),
      readText: async (file, maxBytes) => {
        try {
          const handle = await fsp.open(file, 'r');
          try {
            const buf = Buffer.alloc(maxBytes);
            const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
            return buf.subarray(0, bytesRead).toString('utf8');
          } finally {
            await handle.close();
          }
        } catch {
          return null;
        }
      },
      list: (dir) => fsp.readdir(dir).catch(() => []),
      mtimeMs: (file) => fsp.stat(file).then(
        (s) => s.mtimeMs,
        () => null,
      ),
      now: () => Date.now(),
    }),
    report: (ownerId, sessionId, resume) => {
      const contents = webContents.fromId(ownerId);
      if (contents && !contents.isDestroyed()) contents.send(IPC.sessionResume, { sessionId, resume });
    },
  },
});

// Branch and changed lines per workspace folder (read-only Git; see git-status.ts).
const gitStatus = new GitStatusService({
  run: runFile,
  findGit: () => findOnPath('git.exe', process.env, fileExists),
  workspaces: () => store.state.workspaces,
  enabled: () => store.state.settings.showGitStatus,
  home: os.homedir(),
  publish: (workspaceId, status) => {
    const contents = mainWindow?.webContents;
    if (contents && !contents.isDestroyed()) contents.send(IPC.gitStatus, { workspaceId, status });
  },
});
// Development-only: E2E checks count Git checks (how often terminal output causes one).
if (!app.isPackaged && process.env.TW_E2E === '1') (globalThis as Record<string, unknown>).__twGitRuns = () => gitStatus.runs;

/** Save-all requests sent to the renderer, waiting for its answer. */
const pendingSaveAll = new Map<number, (result: SaveAllResult) => void>();
let saveAllSeq = 0;

function requestSaveAll(win: BrowserWindow, timeoutMs = 120_000): Promise<SaveAllResult> {
  return new Promise((resolve) => {
    const id = ++saveAllSeq;
    const timer = setTimeout(() => {
      pendingSaveAll.delete(id);
      resolve({ ok: false, failed: unsavedEditors });
    }, timeoutMs);
    pendingSaveAll.set(id, (result) => {
      clearTimeout(timer);
      pendingSaveAll.delete(id);
      resolve(result);
    });
    if (win.isDestroyed()) {
      pendingSaveAll.get(id)?.({ ok: false, failed: unsavedEditors });
      return;
    }
    win.webContents.send(IPC.saveAllRequest, id);
  });
}

const e2eMode = !app.isPackaged && process.env.TW_E2E === '1';

/** Taskbar overlay for "an agent needs you": a small amber dot (drawn here, no image file). */
function needsYouBadge(): Electron.NativeImage {
  const size = 16;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
      const ring = d <= 7.5 ? 1 : 0; // dark outline for contrast on light taskbars
      const dot = Math.max(0, Math.min(1, 6.5 - d)); // anti-aliased edge
      const i = (y * size + x) * 4;
      const a = Math.max(dot, ring * 0.9);
      // BGRA, premultiplied: amber #f5a524 inside, #1a1a1a outline.
      const [r, g, b] = dot > 0 ? [0xf5, 0xa5, 0x24] : [0x1a, 0x1a, 0x1a];
      px[i] = Math.round(b * a);
      px[i + 1] = Math.round(g * a);
      px[i + 2] = Math.round(r * a);
      px[i + 3] = Math.round(255 * a);
    }
  }
  return nativeImage.createFromBitmap(px, { width: size, height: size });
}

/**
 * Development-only automation (unpackaged, TW_E2E=1): notifications are recorded in
 * `globalThis.__twNotices` instead of shown, so E2E runs never touch Windows' Notification
 * Center or the Start menu entry; `__twNoticeClick(i)` stands in for a click.
 */
function e2eNotification(o: { title: string; body: string; silent: boolean }): NativeNotification {
  const g = globalThis as unknown as { __twNotices?: { title: string; body: string; silent: boolean; shown: boolean; closed: boolean; click(): void }[]; __twNoticeClick?: (i: number) => void };
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  const rec = { ...o, shown: false, closed: false, click: () => (handlers.get('click') ?? []).forEach((h) => h()) };
  (g.__twNotices ??= []).push(rec);
  g.__twNoticeClick ??= (i: number) => g.__twNotices?.[i]?.click();
  return {
    show: () => {
      rec.shown = true;
      (handlers.get('show') ?? []).forEach((h) => h());
    },
    close: () => {
      rec.closed = true;
    },
    on: (event: string, listener: (...args: never[]) => void) => handlers.set(event, [...(handlers.get(event) ?? []), listener as (...args: unknown[]) => void]),
  };
}

// Windows doesn't display the notification that registers SplitNest (see showAgainOnceRegistered).
const windowsNotification = showAgainOnceRegistered({
  create: (o) => new Notification({ title: o.title, body: o.body, silent: o.silent, id: o.id, groupId: o.groupId }),
  // Electron's registration is a Start menu shortcut named after the app.
  registered: () => process.platform !== 'win32' || existsSync(path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${app.getName()}.lnk`)),
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
});

const notifications = new NotificationService({
  create: (o) => (e2eMode ? e2eNotification(o) : windowsNotification(o)),
  supported: () => e2eMode || Notification.isSupported(),
  window: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
  settings: () => store.state.settings,
  names: (workspaceId, tabId) => {
    const ws = store.getWorkspace(workspaceId);
    const tab = ws ? findPaneOfTab(ws.layout, tabId)?.tabs.find((t) => t.id === tabId) : undefined;
    if (!ws || !tab) return null;
    return { workspace: ws.name, tab: 'name' in tab && typeof tab.name === 'string' ? tab.name : null };
  },
  activate: (target) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.notifyActivate, target);
  },
  badge: (() => {
    let shown = false;
    let image: Electron.NativeImage | null = null;
    return (on: boolean) => {
      if (on === shown || !mainWindow || mainWindow.isDestroyed()) return;
      shown = on;
      image ??= needsYouBadge();
      mainWindow.setOverlayIcon(on ? image : null, on ? 'An agent needs you' : '');
    };
  })(),
  now: () => Date.now(),
  log: (m) => log.warn(m),
  idPrefix: notifyIdPrefix(process.argv.find((a) => a.startsWith('--tw-notify-id='))?.slice('--tw-notify-id='.length)),
});

/** Development-only automation: E2E sets `globalThis.__twQuitAsk` instead of clicking a native dialog. */
function e2eQuitAsk(): ((p: QuitPrompt) => Promise<QuitChoice>) | null {
  if (!e2eMode) return null;
  const g = globalThis as unknown as { __twQuitAsk?: (p: QuitPrompt) => Promise<QuitChoice>; __twQuitPrompts?: QuitPrompt[] };
  if (!g.__twQuitAsk) return null;
  return (p) => {
    (g.__twQuitPrompts ??= []).push(p);
    return g.__twQuitAsk!(p);
  };
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 460,
    show: false,
    title: PRODUCT.name,
    backgroundColor: '#0c0c0e',
    autoHideMenuBar: true,
    // The app draws its own title bar; Windows still draws the native
    // minimize / maximize / close buttons (with snap layouts) on top of it.
    titleBarStyle: 'hidden',
    // Must match --bg-titlebar (Sidebar surface) in tokens.css.
    titleBarOverlay: { color: '#111113', symbolColor: '#b4b4be', height: TITLE_BAR_HEIGHT },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  const ownerId = win.webContents.id;

  win.once('ready-to-show', () => {
    win.show();
    log.info(`window shown ${Date.now() - startedAt} ms after process start`);
  });

  // Sessions belong to a page instance: a reload or renderer crash ends them.
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      broker.closeAllForOwner(ownerId);
      fileWatcher.unwatchOwner(ownerId);
      unsavedEditors = 0;
    }
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    log.error(`renderer gone: ${details.reason}`);
    broker.closeAllForOwner(ownerId);
    fileWatcher.unwatchOwner(ownerId);
  });
  win.webContents.on('destroyed', () => {
    broker.closeAllForOwner(ownerId);
    fileWatcher.unwatchOwner(ownerId);
  });

  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    });
  }

  // Window close and app quit (before-quit closes the window) both go through here.
  const quit = new QuitCoordinator({
    liveSessions: () => broker.liveCount(ownerId),
    unsavedFiles: () => unsavedEditors,
    ask: async (prompt) => {
      const test = e2eQuitAsk();
      if (test) return test(prompt);
      const model = quitDialogModel(prompt);
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        title: PRODUCT.name,
        message: model.message,
        detail: model.detail,
        buttons: model.buttons,
        defaultId: model.buttons.length - 1,
        cancelId: model.buttons.length - 1,
        noLink: true,
      });
      return model.choices[response] ?? 'cancel';
    },
    saveAll: () => requestSaveAll(win),
    onSaveFailed: (result) => {
      // The renderer already shows which file failed and why; the window stays open.
      log.warn(`quit cancelled: ${result.failed} file(s) not saved`);
      if (!win.isDestroyed()) win.webContents.send(IPC.quitAborted, result);
    },
    proceed: () => {
      if (!win.isDestroyed()) win.close();
    },
  });
  win.on('focus', () => notifications.windowFocused());
  // The page's own focus signals stay "focused" while the window is minimized or behind another
  // program, so main tells it (agent notifications depend on it).
  const sendFocus = () => {
    if (!win.isDestroyed()) win.webContents.send(IPC.windowFocus, win.isFocused() && win.isVisible() && !win.isMinimized());
  };
  for (const e of ['focus', 'blur', 'minimize', 'restore', 'show', 'hide'] as const) win.on(e as 'focus', sendFocus);
  win.webContents.on('did-finish-load', sendFocus);
  win.on('close', (event) => {
    if (!quit.requestClose()) event.preventDefault();
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    void shutdown();
  });

  if (devServerUrl) void win.loadURL(devServerUrl);
  else void win.loadFile(rendererIndex, e2eMode ? { search: 'e2e=1' } : undefined);
  return win;
}

let shuttingDown = false;
let readyToQuit = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down');
  // Before the shells end: an agent ending because SplitNest quits must not clear what Resume reopens.
  agentMonitor.stop();
  await broker.shutdown(3000);
  await store.flush();
  host.stop();
  fileWatcher.dispose();
  agentMonitor.stop();
  gitStatus.dispose();
  notifications.dispose();
  readyToQuit = true;
  app.quit();
}

function applySecurityPolicy(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      if (!isTrustedUrl(url)) event.preventDefault();
    });
    contents.on('will-redirect', (event, url) => {
      if (!isTrustedUrl(url)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('before-quit', (event) => {
  if (readyToQuit || selfTestArg) return;
  event.preventDefault();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  else void shutdown();
});

app.on('window-all-closed', () => {
  void shutdown();
});

void app.whenReady().then(async () => {
  log.info(`${PRODUCT.name} ${app.getVersion()} starting (electron ${process.versions.electron}, packaged=${app.isPackaged})`);
  if (selfTestArg) {
    const code = await runSelfTest(selfTestArg.slice('--self-test-output='.length), nodePtyPath, path.join(__dirname, 'pty-host.js'), log);
    app.exit(code);
    return;
  }
  Menu.setApplicationMenu(null);
  applySecurityPolicy();
  registerIpc({
    getWindow: () => mainWindow,
    isTrustedUrl,
    store,
    shells,
    broker,
    log,
    isDirectory,
    setUnsavedEditors: (count) => {
      unsavedEditors = count;
    },
    fileWatcher,
    agentMonitor,
    gitStatus,
    notifications,
    resolveSaveAll: (id, result) => pendingSaveAll.get(id)?.(result),
    appInfo: () => ({
      productName: PRODUCT.name,
      version: app.getVersion(),
      electron: process.versions.electron,
      stateFilePath: store.filePath,
      logFilePath: log.filePath,
      isPackaged: app.isPackaged,
    }),
    e2ePickFolder: !app.isPackaged ? process.env.TW_E2E_PICK_FOLDER : undefined,
  });
  host.start();
  agentMonitor.start();
  void shells.get();
  mainWindow = createWindow();
  // A click on a notification whose object is gone (or that started SplitNest) still brings the window up.
  if (process.platform === 'win32') {
    Notification.handleActivation(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
  }
});
