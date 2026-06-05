import { connect } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DevServerRunner } from '../src/dev-server/runner.js';

const tempDirs: string[] = [];

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'od-dev-runner-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: 'localhost', port });
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 500);
    socket.once('connect', () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

describe('DevServerRunner', () => {
  it.skipIf(process.platform === 'win32')('stops grandchildren spawned by package scripts on POSIX', async () => {
    const dir = await makeProject();
    const childScript = path.join(dir, 'child.cjs');
    const parentScript = path.join(dir, 'parent.cjs');
    await writeFile(childScript, `
      const http = require('node:http');
      http.createServer((_req, res) => res.end('ok')).listen(Number(process.env.PORT), 'localhost', () => {
        console.log('Local: http://localhost:' + process.env.PORT);
      });
    `);
    await writeFile(parentScript, `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: ['ignore', 'inherit', 'inherit'] });
      setInterval(() => {}, 1000);
    `);

    const runner = new DevServerRunner();
    const handle = await runner.start({
      projectId: 'runner-test',
      projectDir: dir,
      command: process.execPath,
      args: [parentScript],
      framework: 'vite',
      packageManager: 'npm',
    });

    expect(await canConnect(handle.port)).toBe(true);
    await runner.stop('runner-test');
    expect(await canConnect(handle.port)).toBe(false);
  }, 10_000);
});
