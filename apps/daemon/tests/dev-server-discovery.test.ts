import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildDevServerCommand,
  discoverAppDevServer,
  discoverDevServer,
} from '../src/dev-server/discovery.js';

const tempDirs: string[] = [];

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'od-dev-server-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('dev-server discovery', () => {
  it('prefers Storybook over the app framework when both are configured', async () => {
    const dir = await makeProject();
    await mkdir(path.join(dir, '.storybook'));
    await writeFile(path.join(dir, '.storybook', 'main.ts'), 'export default {};');
    await writeFile(path.join(dir, 'vite.config.ts'), 'export default {};');
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.33.2' }));

    const discovery = await discoverDevServer(dir, 0);

    expect(discovery.framework).toBe('storybook');
    expect(discovery.packageManager).toBe('pnpm');
    expect(buildDevServerCommand(discovery, 0).args).toEqual(['dev', '-p', '{port}']);
  });

  it('uses the package dev script for auxiliary app discovery and passes port args after --', async () => {
    const dir = await makeProject();
    await writeFile(path.join(dir, 'vite.config.ts'), 'export default {};');
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite --host 0.0.0.0' } }));

    const discovery = await discoverAppDevServer(dir, 7457);

    expect(discovery?.framework).toBe('vite');
    expect(discovery?.command).toBe('npm run dev');
    expect(buildDevServerCommand(discovery!, 7457)).toEqual({
      command: 'npm',
      args: ['run', 'dev', '--', '--port', '{port}'],
    });
  });
});
