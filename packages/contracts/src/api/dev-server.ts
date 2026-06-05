// Dev server lifecycle management.
//
// Layer 1 of the React component development integration (see
// specs/current/react-component-dev-integration.md). The daemon
// discovers, starts, health-checks, and stops dev servers (Vite,
// Next.js, etc.) for folder-imported projects.

/** Detected dev server framework. */
export type DevServerFramework = 'storybook' | 'vite' | 'next' | 'remix' | 'astro' | 'unknown';

/** Detected package manager. */
export type DevServerPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** Status of a dev server instance. */
export type DevServerStatus = 'stopped' | 'starting' | 'running' | 'error';

/** Request body: start a dev server for a project. */
export interface DevServerStartRequest {
  /** Optional port; the daemon allocates one if not provided. */
  port?: number;
  /** Optional command override (e.g. "npx vite --port {port}"). */
  command?: string;
}

/** Response body for dev server start. */
export interface DevServerStartResponse {
  projectId: string;
  url: string;
  port: number;
  status: 'starting' | 'running';
  framework: DevServerFramework;
  packageManager: DevServerPackageManager;
}

/** Response body for dev server status. */
export interface DevServerStatusResponse {
  projectId: string;
  url: string | null;
  port: number | null;
  status: DevServerStatus;
  framework: DevServerFramework | null;
  packageManager: DevServerPackageManager | null;
  startedAt: number | null;
  uptimeMs: number | null;
  lastError: string | null;
  pid: number | null;
}

/** Response body for dev server stop. */
export interface DevServerStopResponse {
  projectId: string;
  status: 'stopped';
}

/** Response body for dev server restart. */
export interface DevServerRestartResponse {
  projectId: string;
  url: string;
  port: number;
  status: 'starting' | 'running';
}

/** Response body for dev server health check. */
export interface DevServerHealthResponse {
  projectId: string;
  healthy: boolean;
  status: DevServerStatus;
  lastCheck: number;
  consecutiveFailures: number;
}

/** Resolved dev server proxy path for an iframe to load. */
export interface DevServerProxyInfo {
  projectId: string;
  devServerUrl: string;
  /** Path to load in an iframe: /api/projects/:id/dev-server/proxy/ */
  proxyBasePath: string;
}

/** Build the proxy URL path for a project's dev server. */
export function devServerProxyPath(projectId: string, subPath?: string): string {
  const encoded = encodeURIComponent(projectId);
  const suffix = subPath ? `/${subPath.replace(/^\/+/, '')}` : '';
  return `/api/projects/${encoded}/dev-server/proxy${suffix}`;
}
