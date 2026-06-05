// Dev server discovery: detect which dev server (Vite, Next.js, Remix,
// Astro) a project uses and how to start it.
//
// Layer 1 of the React component development integration
// (specs/current/react-component-dev-integration.md).

import { accessSync, constants, readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  DevServerFramework,
  DevServerPackageManager,
} from '@open-design/contracts';

export interface DevServerDiscovery {
  framework: DevServerFramework;
  packageManager: DevServerPackageManager;
  command: string;
  args: string[];
  cwd: string;
  /** Port hint to pass to the dev server. The runner handles allocation. */
  portPlaceholder: number;
}

const FRAMEWORK_SIGNALS: Array<{
  framework: DevServerFramework;
  configFiles: string[];
  command: string;
  portFlag: string;
}> = [
  // Prefer Storybook when configured. It is a better isolated visual host for
  // production React components than the full app dev server, which may depend
  // on app routing, auth, backend APIs, or environment-specific proxy config.
  {
    framework: 'storybook',
    configFiles: [
      '.storybook/main.ts',
      '.storybook/main.js',
      '.storybook/main.mjs',
      '.storybook/main.cjs',
    ],
    command: 'storybook dev',
    portFlag: '-p',
  },
  {
    framework: 'vite',
    configFiles: ['vite.config.ts', 'vite.config.js', 'vite.config.mjs'],
    command: 'vite',
    portFlag: '--port',
  },
  {
    framework: 'next' as DevServerFramework,
    configFiles: ['next.config.ts', 'next.config.mjs', 'next.config.js'],
    command: 'next dev',
    portFlag: '-p',
  },
  {
    framework: 'remix' as DevServerFramework,
    configFiles: ['remix.config.js', 'remix.config.ts', 'remix.config.mjs'],
    command: 'remix dev',
    portFlag: '--port',
  },
  {
    framework: 'astro' as DevServerFramework,
    configFiles: ['astro.config.mjs', 'astro.config.ts', 'astro.config.js'],
    command: 'astro dev',
    portFlag: '--port',
  },
];

const PACKAGE_MANAGER_LOCKFILES: Array<{
  pm: DevServerPackageManager;
  lockfile: string;
}> = [
  { pm: 'pnpm', lockfile: 'pnpm-lock.yaml' },
  { pm: 'yarn', lockfile: 'yarn.lock' },
  { pm: 'bun', lockfile: 'bun.lockb' },
  { pm: 'npm', lockfile: 'package-lock.json' },
];

export class DevServerNotDetectedError extends Error {
  constructor(projectDir: string) {
    super(`No preview server detected in ${projectDir}. Expected Storybook (.storybook/main.*) or one of: vite.config.*, next.config.*, remix.config.*, astro.config.*`);
    this.name = 'DevServerNotDetectedError';
  }
}

/**
 * Detect the project's dev server framework, package manager, and start
 * command by examining config files and lockfiles at `projectDir`.
 */
async function discoverDevServerFromSignals(
  projectDir: string,
  port: number,
  signals: typeof FRAMEWORK_SIGNALS,
): Promise<DevServerDiscovery> {
  // 1. Detect framework
  let framework: DevServerDiscovery | null = null;
  for (const signal of signals) {
    for (const configFile of signal.configFiles) {
      const fullPath = path.join(projectDir, configFile);
      try {
        accessSync(fullPath, constants.R_OK);
        framework = {
          framework: signal.framework,
          packageManager: 'npm', // default, overwritten by lockfile detection
          command: signal.command,
          args: [],
          cwd: projectDir,
          portPlaceholder: port,
        };
        break;
      } catch {
        // Config file not present; try next one.
      }
    }
    if (framework) break;
  }

  if (!framework) {
    throw new DevServerNotDetectedError(projectDir);
  }

  // 2. Detect package manager
  for (const { pm, lockfile } of PACKAGE_MANAGER_LOCKFILES) {
    try {
      accessSync(path.join(projectDir, lockfile), constants.R_OK);
      framework.packageManager = pm;
      break;
    } catch {
      // Lockfile not present; try next.
    }
  }

  // 3. Read packageManager field from package.json (overrides lockfile heuristic)
  try {
    const raw = readFileSync(path.join(projectDir, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    const pkgManager: string | undefined = pkg.packageManager;
    if (typeof pkgManager === 'string') {
      const name = pkgManager.split('@')[0];
      if (name && (PACKAGE_MANAGER_LOCKFILES.map((e) => e.pm) as string[]).includes(name)) {
        framework.packageManager = name as DevServerPackageManager;
      }
    }
  } catch {
    // No package.json or unparseable; keep lockfile-detected value.
  }

  return framework;
}

export async function discoverDevServer(
  projectDir: string,
  port: number,
): Promise<DevServerDiscovery> {
  return discoverDevServerFromSignals(projectDir, port, FRAMEWORK_SIGNALS);
}

export async function discoverAppDevServer(
  projectDir: string,
  port: number,
): Promise<DevServerDiscovery | null> {
  const appSignals = FRAMEWORK_SIGNALS.filter((signal) => signal.framework !== 'storybook');
  try {
    const discovery = await discoverDevServerFromSignals(projectDir, port, appSignals);
    try {
      const raw = readFileSync(path.join(projectDir, 'package.json'), 'utf8');
      const pkg = JSON.parse(raw);
      if (pkg?.scripts && typeof pkg.scripts.dev === 'string') {
        discovery.command = `${discovery.packageManager} run dev`;
      }
    } catch {
      // Keep the framework binary fallback when package.json is missing.
    }
    return discovery;
  } catch (err) {
    if (err instanceof DevServerNotDetectedError) return null;
    throw err;
  }
}

/**
 * Build the CLI invocation for a detected dev server. The runner allocates
 * the concrete port and replaces the `{port}` token immediately before
 * spawning, so Vite/Next never see `--port 0`.
 */
export function buildDevServerCommand(
  discovery: DevServerDiscovery,
  _port: number,
): { command: string; args: string[] } {
  const signal = FRAMEWORK_SIGNALS.find((s) => s.framework === discovery.framework);
  const portFlag = signal?.portFlag ?? '--port';
  const portArg = '{port}';

  // Split command word into base + extra args
  const parts = discovery.command.split(/\s+/);
  const base = parts[0] ?? discovery.command;
  const extraArgs = parts.slice(1);

  const runsPackageScript = ['npm', 'pnpm', 'yarn', 'bun'].includes(base ?? '') && extraArgs[0] === 'run';

  return {
    command: base,
    args: runsPackageScript
      ? [...extraArgs, '--', portFlag, portArg, ...discovery.args]
      : [...extraArgs, portFlag, portArg, ...discovery.args],
  };
}
