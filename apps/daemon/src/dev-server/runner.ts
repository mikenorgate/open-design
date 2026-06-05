// Dev server runner: spawn, health-check, and lifecycle management for
// Vite / Next.js / Remix / Astro dev servers.
//
// Designed to mirror apps/daemon/src/runtimes/launch.ts in structure.
// Each project gets at most one running dev server. The daemon allocates
// ports from OD_DEV_SERVER_PORT_START (default 7457) upward.

import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import { request } from 'node:http';
import type {
  DevServerStatus,
  DevServerFramework,
  DevServerPackageManager,
} from '@open-design/contracts';

// --- Port allocation ------------------------------------------------

const DEFAULT_PORT_START = 7457;
const DEFAULT_PORT_END = 7556;

function portRangeStart(): number {
  const env = process.env.OD_DEV_SERVER_PORT_START;
  if (env) {
    const parsed = parseInt(env, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) return parsed;
  }
  return DEFAULT_PORT_START;
}

function portRangeEnd(): number {
  const start = portRangeStart();
  return Math.min(start + 99, 65535);
}

async function allocatePort(startHint: number): Promise<number | null> {
  const min = portRangeStart();
  const max = portRangeEnd();
  if (startHint >= min && startHint <= max) {
    const port = await tryBindPort(startHint);
    if (port !== null) return port;
  }
  for (let port = min; port <= max; port++) {
    const result = await tryBindPort(port);
    if (result !== null) return result;
  }
  return null;
}

async function tryBindPort(port: number): Promise<number | null> {
  const ipv4 = await tryBindPortOnHost(port, '0.0.0.0');
  if (ipv4 === null) return null;
  const ipv6Local = await tryBindPortOnHost(port, '::1');
  return ipv6Local === null ? null : ipv4;
}

function tryBindPortOnHost(port: number, host: string): Promise<number | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.on('error', () => resolve(null));
    server.listen(port, host, () => {
      const addr = server.address() as AddressInfo;
      const bound = addr.port;
      server.close(() => resolve(bound));
    });
  });
}

// --- Dev server handle -----------------------------------------------

export interface DevServerHandle {
  projectId: string;
  port: number;
  url: string;
  status: DevServerStatus;
  framework: DevServerFramework;
  packageManager: DevServerPackageManager;
  startedAt: number;
  pid: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  lastHealthCheck: number;
  process: ChildProcess | null;
}

export interface DevServerStartOptions {
  projectId: string;
  projectDir: string;
  command: string;
  args: string[];
  framework: DevServerFramework;
  packageManager: DevServerPackageManager;
  env?: NodeJS.ProcessEnv;
  portPlaceholder?: number;
}

export class DevServerRunner extends EventEmitter {
  private servers = new Map<string, DevServerHandle>();
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private readonly HEALTH_INTERVAL_MS = 15_000;
  private readonly MAX_CONSECUTIVE_FAILURES = 3;

  async start(opts: DevServerStartOptions): Promise<DevServerHandle> {
    const existing = this.servers.get(opts.projectId);
    if (existing && existing.status === 'running') return existing;
    if (existing) await this.stop(opts.projectId);

    const port = await allocatePort(opts.portPlaceholder ?? portRangeStart());
    if (port === null) {
      throw new Error(`No free port available in range ${portRangeStart()}-${portRangeEnd()}`);
    }

    const args = opts.args.map((arg) => (arg === '{port}' ? String(port) : arg));
    const env = { ...(opts.env ?? process.env), PORT: String(port), BROWSER: 'none' };

    const handle: DevServerHandle = {
      projectId: opts.projectId, port,
      url: `http://localhost:${port}`, status: 'starting',
      framework: opts.framework, packageManager: opts.packageManager,
      startedAt: Date.now(), pid: null, lastError: null,
      consecutiveFailures: 0, lastHealthCheck: Date.now(), process: null,
    };

    this.servers.set(opts.projectId, handle);

    try {
      await this.spawnProcess(opts.projectDir, opts.command, args, env, handle);
      handle.status = 'running';
      handle.startedAt = Date.now();
      this.emit('started', opts.projectId, port, handle.url);
      this.startHealthChecks();
      return handle;
    } catch (err) {
      handle.status = 'error';
      handle.lastError = err instanceof Error ? err.message : String(err);
      this.emit('start_error', opts.projectId, handle.lastError);
      throw err;
    }
  }

  async stop(projectId: string): Promise<void> {
    const handle = this.servers.get(projectId);
    if (!handle) return;
    if (handle.process) {
      await terminateDevServerProcess(handle.process);
    }
    handle.status = 'stopped';
    handle.process = null; handle.pid = null;
    this.servers.delete(projectId);
    this.emit('stopped', projectId);
    if (this.servers.size === 0) this.stopHealthChecks();
  }

  async restart(projectId: string, opts: DevServerStartOptions): Promise<DevServerHandle> {
    await this.stop(projectId);
    return this.start(opts);
  }

  get(projectId: string): DevServerHandle | undefined { return this.servers.get(projectId); }

  getAll(): DevServerHandle[] { return [...this.servers.values()]; }

  getStatus(projectId: string) {
    const handle = this.servers.get(projectId);
    if (!handle) return { projectId, url: null, port: null, status: 'stopped' as const, framework: null, packageManager: null, startedAt: null, uptimeMs: null, lastError: null, pid: null };
    return { projectId: handle.projectId, url: handle.url, port: handle.port, status: handle.status, framework: handle.framework, packageManager: handle.packageManager, startedAt: handle.startedAt, uptimeMs: handle.status === 'running' ? Date.now() - handle.startedAt : null, lastError: handle.lastError, pid: handle.pid };
  }

  async shutdown(): Promise<void> {
    this.stopHealthChecks();
    await Promise.all([...this.servers.keys()].map((id) => this.stop(id)));
  }

  private spawnProcess(cwd: string, command: string, args: string[], env: NodeJS.ProcessEnv, handle: DevServerHandle): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // npm/yarn/storybook/vite can spawn grandchildren. Put POSIX launches
        // in their own process group so stop/restart can terminate the whole
        // tree instead of leaving listeners behind on the allocated port.
        detached: process.platform !== 'win32',
      });
      handle.process = child;
      handle.pid = child.pid ?? null;
      let settled = false;
      let outputTail = '';
      const appendOutput = (chunk: Buffer) => {
        outputTail = `${outputTail}${chunk.toString()}`.slice(-4000);
      };
      const settle = (fn: () => void) => { if (settled) return; settled = true; fn(); };

      child.on('error', (err) => { handle.lastError = err.message; settle(() => reject(err)); });
      child.on('exit', (code, signal) => {
        if (code !== 0 && !settled) {
          const suffix = outputTail.trim() ? `\n${outputTail.trim().split('\n').slice(-20).join('\n')}` : '';
          const msg = signal ? `Dev server exited with signal ${signal}${suffix}` : `Dev server exited with code ${code}${suffix}`;
          handle.lastError = msg;
          settle(() => reject(new Error(msg)));
        }
        handle.process = null; handle.pid = null;
      });

      const readySignals = [
        /(?:Local|ready|started|compiled|running).*https?:\/\/localhost:\d+/i,
        /ready in \d+/i, /server (?:ready|running)/i,
      ];

      if (child.stdout) {
        let buf = '';
        child.stdout.on('data', (chunk: Buffer) => {
          appendOutput(chunk);
          buf += chunk.toString();
          for (const re of readySignals) { if (re.test(buf)) { settle(() => resolve()); return; } }
        });
      }

      if (child.stderr) {
        let buf = '';
        child.stderr.on('data', (chunk: Buffer) => {
          appendOutput(chunk);
          buf += chunk.toString();
          if (/\bfatal\b/i.test(buf) || /\bEADDRINUSE\b/i.test(buf)) {
            const err = new Error(buf.trim().split('\n').pop() ?? 'Unknown dev server error');
            handle.lastError = err.message;
            settle(() => reject(err));
          }
        });
      }

      const timeoutMs = 60_000;
      let pollCount = 0;
      const poll = setInterval(() => {
        pollCount++;
        if (pollCount * 500 > timeoutMs) { clearInterval(poll); settle(() => reject(new Error(`Dev server did not start within ${timeoutMs}ms`))); return; }
        this.httpGet(handle.port, '/').then(() => { clearInterval(poll); settle(() => resolve()); }).catch(() => {});
      }, 500);
    });
  }

  private startHealthChecks(): void {
    if (this.healthInterval) return;
    this.healthInterval = setInterval(() => this.runHealthChecks(), this.HEALTH_INTERVAL_MS);
    this.healthInterval.unref();
  }

  private stopHealthChecks(): void {
    if (this.healthInterval) { clearInterval(this.healthInterval); this.healthInterval = null; }
  }

  private async runHealthChecks(): Promise<void> {
    const checks = [...this.servers.entries()]
      .filter(([, h]) => h.status === 'running')
      .map(async ([pid, handle]) => {
        try { await this.httpGet(handle.port, '/'); handle.consecutiveFailures = 0; handle.lastHealthCheck = Date.now(); }
        catch {
          handle.consecutiveFailures++;
          handle.lastHealthCheck = Date.now();
          this.emit('health_fail', pid, handle.consecutiveFailures);
          if (handle.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
            handle.status = 'error';
            handle.lastError = `Health check failed ${handle.consecutiveFailures} times`;
            this.emit('unhealthy', pid, handle.lastError);
          }
        }
      });
    await Promise.all(checks);
  }

  private httpGet(port: number, pathname: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: 'localhost', port, path: pathname, method: 'GET', timeout: 5_000 }, (res) => { res.resume(); resolve(); });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });
  }
}

let runnerInstance: DevServerRunner | null = null;

export function getDevServerRunner(): DevServerRunner {
  if (!runnerInstance) runnerInstance = new DevServerRunner();
  return runnerInstance;
}

export function resetDevServerRunner(): void {
  if (runnerInstance) { void runnerInstance.shutdown().catch(() => {}); runnerInstance = null; }
}

async function terminateDevServerProcess(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;

  await new Promise<void>((resolve) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(forceKill);
      child.off('exit', done);
      resolve();
    };

    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }).on('exit', () => {});
        } else {
          process.kill(-pid, signal);
        }
      } catch {
        try { child.kill(signal); } catch { /* already gone */ }
      }
    };

    const forceKill = setTimeout(() => {
      killTree('SIGKILL');
      setTimeout(done, 250).unref();
    }, 5_000);
    forceKill.unref();
    child.once('exit', done);
    killTree('SIGTERM');
  });
}
