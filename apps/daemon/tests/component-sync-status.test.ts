import Database from 'better-sqlite3';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  initComponentSyncTable,
  linkComponentToArtifact,
  markComponentSynced,
} from '../src/dev-server/component-status.js';

const tempDirs: string[] = [];

function makeProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'od-component-sync-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('component sync status', () => {
  it('rejects component and artifact paths that escape the linked project', async () => {
    const baseDir = makeProject();
    await mkdir(path.join(baseDir, 'src'), { recursive: true });
    await writeFile(path.join(baseDir, 'src', 'Widget.tsx'), 'export function Widget(){ return <div /> }');
    const db = new Database(':memory:');
    initComponentSyncTable(db);

    expect(() =>
      linkComponentToArtifact(db, 'project-1', '../outside.tsx', 'artifacts/widget', baseDir),
    ).toThrow(/escapes project directory|project-relative/i);
    expect(() =>
      linkComponentToArtifact(db, 'project-1', 'src/Widget.tsx', '/tmp/outside', baseDir),
    ).toThrow(/project-relative/i);
    expect(() => markComponentSynced(db, 'project-1', '../outside.tsx', baseDir))
      .toThrow(/escapes project directory|project-relative/i);

    db.close();
  });
});
