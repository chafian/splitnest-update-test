import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { PRODUCT } from './src/shared/product';

/**
 * The Vite plugin normally packages only `.vite/`. node-pty is a native,
 * externalized dependency, so its runtime files are kept explicitly and
 * unpacked from the ASAR archive (native binaries, ConPTY DLL, and the JS
 * worker it starts by file path).
 */
const NODE_PTY = '/node_modules/node-pty';
const NODE_PTY_KEEP = ['/package.json', '/lib', '/prebuilds', '/prebuilds/win32-x64', '/LICENSE', '/typings'];

function ignore(file: string): boolean {
  if (!file) return false;
  if (file === '/package.json' || file === '/node_modules' || file === NODE_PTY) return false;
  if (file === '/.vite' || file.startsWith('/.vite/')) return false;
  if (file.startsWith(`${NODE_PTY}/`)) {
    const rel = file.slice(NODE_PTY.length);
    if (rel.endsWith('.pdb') || rel.endsWith('.test.js') || rel.endsWith('.js.map')) return true;
    if (rel.startsWith('/prebuilds/') && !rel.startsWith('/prebuilds/win32-x64')) return true;
    return !NODE_PTY_KEEP.some((keep) => rel === keep || rel.startsWith(`${keep}/`));
  }
  return true;
}

const config: ForgeConfig = {
  // TW_OUT_DIR lets you build while a copy from out/ is still running.
  outDir: process.env.TW_OUT_DIR || 'out',
  packagerConfig: {
    name: PRODUCT.name,
    executableName: PRODUCT.executableName,
    appBundleId: PRODUCT.appId,
    asar: { unpack: '**/node_modules/node-pty/**' },
    ignore,
    win32metadata: {
      CompanyName: PRODUCT.name,
      FileDescription: PRODUCT.name,
      ProductName: PRODUCT.name,
    },
    icon: 'assets/icon',
  },
  rebuildConfig: {
    // node-pty ships N-API prebuilds; no Electron-specific rebuild is needed.
    onlyModules: [],
  },
  makers: [
    // Windows installer (Squirrel.Windows): per-user install, Start menu shortcut, updates.
    new MakerSquirrel({
      name: PRODUCT.executableName,
      exe: `${PRODUCT.executableName}.exe`,
      setupExe: 'SplitNest-win32-x64-Setup.exe',
      setupIcon: 'assets/icon.ico',
      iconUrl: 'https://raw.githubusercontent.com/chafian/splitnest/main/assets/icon.ico',
      authors: 'Souf CH',
      description: 'Windows terminal workspace for AI coding agents',
      noMsi: true,
    }),
    // Portable build (no installer, no automatic updates).
    new MakerZIP({}, ['win32']),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/main.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/pty-host/pty-host.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
