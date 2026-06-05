// Dev server HTTP routes for the daemon.
//
// Registers /api/projects/:id/dev-server/start, status, stop, restart,
// and health endpoints. Follows the same pattern as host-tools-routes.ts
// and other domain route registrars.

import type { Express } from 'express';
import nodePath from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { RouteDeps } from '../server-context.js';
import { discoverAppDevServer, discoverDevServer, buildDevServerCommand, DevServerNotDetectedError } from './discovery.js';
import { getDevServerRunner } from './runner.js';
import { discoverComponents } from './components.js';
import { extractComponentProps } from './props.js';
import {
  initComponentSyncTable,
  linkComponentToArtifact,
  markComponentSynced,
  getComponentStatus,
  unlinkComponent,
} from './component-status.js';
import type {
  DevServerStartRequest,
  DevServerStartResponse,
  DevServerStatusResponse,
  DevServerStopResponse,
  DevServerRestartResponse,
  DevServerHealthResponse,
} from '@open-design/contracts';

export interface RegisterDevServerRoutesDeps
  extends RouteDeps<'db' | 'http' | 'paths' | 'projectStore' | 'projectFiles'> {}

/** Parse a .env-style file into a key/value record, ignoring comments and blank lines. */
function parseEnvFile(filePath: string): Record<string, string> {
  try {
    const text = readFileSync(filePath, 'utf8');
    const result: Record<string, string> = {};
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx < 1) continue;
      const key = line.slice(0, eqIdx).trim();
      let val = line.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[key] = val;
    }
    return result;
  } catch {
    return {};
  }
}

/** Load env vars from the project directory (.env, .env.local) into the current process env. */
function loadProjectEnv(projectDir: string): NodeJS.ProcessEnv {
  const files = ['.env', '.env.local'];
  const merged: Record<string, string> = {};
  for (const file of files) {
    const filePath = nodePath.join(projectDir, file);
    if (existsSync(filePath)) {
      Object.assign(merged, parseEnvFile(filePath));
    }
  }
  return { ...process.env, ...merged };
}

export function registerDevServerRoutes(app: Express, ctx: RegisterDevServerRoutesDeps) {
  const { db } = ctx;
  const { sendApiError } = ctx.http;
  const { getProject } = ctx.projectStore;

  // GET /api/projects/:id/dev-server/status
  app.get('/api/projects/:id/dev-server/status', async (req, res) => {
    try {
      const projectId = String(req.params.id ?? '').trim();
      if (!projectId) {
        return res.status(400).json({ error: 'Missing project id' });
      }

      const project = getProject(db, projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const runner = getDevServerRunner();
      const status: DevServerStatusResponse = runner.getStatus(projectId);
      res.json(status);
    } catch (err) {
      sendApiError(res, err, 'Failed to get dev server status');
    }
  });

  // POST /api/projects/:id/dev-server/start
  app.post('/api/projects/:id/dev-server/start', async (req, res) => {
    try {
      const projectId = String(req.params.id ?? '').trim();
      if (!projectId) {
        return res.status(400).json({ error: 'Missing project id' });
      }

      const project = getProject(db, projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const baseDir = project.metadata?.baseDir as string | undefined;
      if (!baseDir) {
        return res.status(400).json({
          error: 'Project was not imported from a folder. Only folder-imported projects support dev servers.',
        });
      }

      const body = (req.body ?? {}) as DevServerStartRequest;
      const port = typeof body.port === 'number' ? body.port : undefined;

      const discovery = await discoverDevServer(baseDir, port ?? 0);
      const built = buildDevServerCommand(discovery, port ?? 0);

      const runner = getDevServerRunner();
      const projectEnv = loadProjectEnv(baseDir);
      const handle = await runner.start({
        projectId,
        projectDir: baseDir,
        command: built.command,
        args: built.args,
        portPlaceholder: discovery.portPlaceholder,
        framework: discovery.framework,
        packageManager: discovery.packageManager,
        env: projectEnv,
      });

      if (discovery.framework === 'storybook') {
        const appDiscovery = await discoverAppDevServer(baseDir, handle.port + 1);
        if (appDiscovery) {
          const appBuilt = buildDevServerCommand(appDiscovery, handle.port + 1);
          try {
            await runner.start({
              projectId: `${projectId}:app`,
              projectDir: baseDir,
              command: appBuilt.command,
              args: appBuilt.args,
              portPlaceholder: appDiscovery.portPlaceholder,
              framework: appDiscovery.framework,
              packageManager: appDiscovery.packageManager,
              env: projectEnv,
            });
          } catch (err) {
            console.warn(`[dev-server] Could not start auxiliary app server for project ${projectId}:`, err instanceof Error ? err.message : err);
          }
        }
      }

      const response: DevServerStartResponse = {
        projectId: handle.projectId,
        url: handle.url,
        port: handle.port,
        status: handle.status as 'starting' | 'running',
        framework: handle.framework,
        packageManager: handle.packageManager,
      };

      res.json(response);
    } catch (err) {
      if (err instanceof DevServerNotDetectedError) {
        return res.status(400).json({ error: err.message });
      }
      sendApiError(res, err, 'Failed to start dev server');
    }
  });

  // POST /api/projects/:id/dev-server/stop
  app.post('/api/projects/:id/dev-server/stop', async (req, res) => {
    try {
      const projectId = String(req.params.id ?? '').trim();
      if (!projectId) {
        return res.status(400).json({ error: 'Missing project id' });
      }

      const runner = getDevServerRunner();
      await runner.stop(projectId);
      await runner.stop(`${projectId}:app`);

      const response: DevServerStopResponse = {
        projectId,
        status: 'stopped',
      };

      res.json(response);
    } catch (err) {
      sendApiError(res, err, 'Failed to stop dev server');
    }
  });

  // POST /api/projects/:id/dev-server/restart
  app.post('/api/projects/:id/dev-server/restart', async (req, res) => {
    try {
      const projectId = String(req.params.id ?? '').trim();
      if (!projectId) {
        return res.status(400).json({ error: 'Missing project id' });
      }

      const project = getProject(db, projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const baseDir = project.metadata?.baseDir as string | undefined;
      if (!baseDir) {
        return res.status(400).json({
          error: 'Project was not imported from a folder.',
        });
      }

      const body = (req.body ?? {}) as DevServerStartRequest;
      const discovery = await discoverDevServer(baseDir, body.port ?? 0);
      const built = buildDevServerCommand(discovery, body.port ?? 0);

      const runner = getDevServerRunner();
      const projectEnv = loadProjectEnv(baseDir);
      const handle = await runner.restart(projectId, {
        projectId,
        projectDir: baseDir,
        command: built.command,
        args: built.args,
        portPlaceholder: discovery.portPlaceholder,
        framework: discovery.framework,
        packageManager: discovery.packageManager,
        env: projectEnv,
      });

      await runner.stop(`${projectId}:app`);
      if (discovery.framework === 'storybook') {
        const appDiscovery = await discoverAppDevServer(baseDir, handle.port + 1);
        if (appDiscovery) {
          const appBuilt = buildDevServerCommand(appDiscovery, handle.port + 1);
          try {
            await runner.start({
              projectId: `${projectId}:app`,
              projectDir: baseDir,
              command: appBuilt.command,
              args: appBuilt.args,
              portPlaceholder: appDiscovery.portPlaceholder,
              framework: appDiscovery.framework,
              packageManager: appDiscovery.packageManager,
              env: projectEnv,
            });
          } catch (err) {
            console.warn(`[dev-server] Could not start auxiliary app server for project ${projectId}:`, err instanceof Error ? err.message : err);
          }
        }
      }

      const response: DevServerRestartResponse = {
        projectId: handle.projectId,
        url: handle.url,
        port: handle.port,
        status: handle.status as 'starting' | 'running',
      };

      res.json(response);
    } catch (err) {
      if (err instanceof DevServerNotDetectedError) {
        return res.status(400).json({ error: err.message });
      }
      sendApiError(res, err, 'Failed to restart dev server');
    }
  });

  // GET /api/projects/:id/dev-server/health
  app.get('/api/projects/:id/dev-server/health', async (req, res) => {
    try {
      const projectId = String(req.params.id ?? '').trim();
      if (!projectId) {
        return res.status(400).json({ error: 'Missing project id' });
      }

      const runner = getDevServerRunner();
      const handle = runner.get(projectId);

      const response: DevServerHealthResponse = {
        projectId,
        healthy: handle?.status === 'running',
        status: handle?.status ?? 'stopped',
        lastCheck: handle?.lastHealthCheck ?? 0,
        consecutiveFailures: handle?.consecutiveFailures ?? 0,
      };

      res.json(response);
    } catch (err) {
      sendApiError(res, err, 'Failed to check dev server health');
    }
  });

  // GET /api/projects/:id/dev-server/components
  app.get('/api/projects/:id/dev-server/components', async (req, res) => {
    try {
      const projectId = String(req.params.id ?? '').trim();
      if (!projectId) {
        return res.status(400).json({ error: 'Missing project id' });
      }

      const project = getProject(db, projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const baseDir = project.metadata?.baseDir as string | undefined;
      if (!baseDir) {
        return res.status(400).json({
          error: 'Component discovery only works for folder-imported projects.',
        });
      }

      const registry = discoverComponents(baseDir, projectId);
      res.json(registry);
    } catch (err) {
      sendApiError(res, err, 'Failed to discover components');
    }
  });

  // GET /api/projects/:id/dev-server/components/:component/props
  app.get('/api/projects/:id/dev-server/components/:component/props', async (req, res) => {
    try {
      const projectId = String(req.params.id ?? '').trim();
      const componentName = String(req.params.component ?? '').trim();
      if (!projectId || !componentName) {
        return res.status(400).json({ error: 'Missing project id or component name' });
      }

      const project = getProject(db, projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const baseDir = project.metadata?.baseDir as string | undefined;
      if (!baseDir) {
        return res.status(400).json({ error: 'Not a folder-imported project' });
      }

      const registry = discoverComponents(baseDir, projectId);
      const component = registry.components.find((c) => c.name === componentName);
      if (!component) {
        return res.status(404).json({ error: 'Component not found', componentName });
      }

      const fullPath = nodePath.join(baseDir, component.file);
      let source: string;
      try {
        source = readFileSync(fullPath, 'utf8');
      } catch {
        return res.status(404).json({ error: 'Component file not readable', path: fullPath });
      }

      const props = extractComponentProps(fullPath, source);
      res.json(props ?? { componentName, filePath: component.file, props: [] });
    } catch (err) {
      sendApiError(res, err, 'Failed to extract component props');
    }
  });

  // POST /api/projects/:id/component-sync/link
  app.post('/api/projects/:id/component-sync/link', async (req, res) => {
    try {
      const projectId = String(req.params.id ?? '').trim();
      const { componentPath, artifactDir, sourceSkillId } = (req.body ?? {}) as {
        componentPath?: string;
        artifactDir?: string;
        sourceSkillId?: string;
      };
      if (!projectId || !componentPath || !artifactDir) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      const project = getProject(db, projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const baseDir = project.metadata?.baseDir as string | undefined;
      if (!baseDir) return res.status(400).json({ error: 'Not a folder-imported project' });
      const mapping = linkComponentToArtifact(db, projectId, componentPath, artifactDir, baseDir, sourceSkillId);
      res.json({ mapping });
    } catch (err) {
      sendApiError(res, err, 'Failed to link component');
    }
  });

  // GET /api/projects/:id/component-sync/status
  app.get('/api/projects/:id/component-sync/status', async (req, res) => {
    try {
      const projectId = String(req.params.id ?? '').trim();
      if (!projectId) return res.status(400).json({ error: 'Missing project id' });
      const project = getProject(db, projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const baseDir = project.metadata?.baseDir as string | undefined;
      if (!baseDir) return res.status(400).json({ error: 'Not a folder-imported project' });
      const report = getComponentStatus(db, projectId, baseDir);
      res.json(report);
    } catch (err) {
      sendApiError(res, err, 'Failed to get component status');
    }
  });

  // POST /api/projects/:id/component-sync/sync
  app.post('/api/projects/:id/component-sync/sync', async (req, res) => {
    try {
      const projectId = String(req.params.id ?? '').trim();
      const { componentPath } = (req.body ?? {}) as { componentPath?: string };
      if (!projectId || !componentPath) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      const project = getProject(db, projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const baseDir = project.metadata?.baseDir as string | undefined;
      if (!baseDir) return res.status(400).json({ error: 'Not a folder-imported project' });
      const mapping = markComponentSynced(db, projectId, componentPath, baseDir);
      if (!mapping) return res.status(404).json({ error: 'Component mapping not found' });
      res.json({ mapping });
    } catch (err) {
      sendApiError(res, err, 'Failed to sync component');
    }
  });

  // POST /api/projects/:id/component-sync/unlink
  app.post('/api/projects/:id/component-sync/unlink', async (req, res) => {
    try {
      const projectId = String(req.params.id ?? '').trim();
      const { componentPath } = (req.body ?? {}) as { componentPath?: string };
      if (!projectId || !componentPath) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      const ok = unlinkComponent(db, projectId, componentPath);
      res.json({ unlinked: ok });
    } catch (err) {
      sendApiError(res, err, 'Failed to unlink component');
    }
  });
}
