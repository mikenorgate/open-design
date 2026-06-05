// Component status tracking: link OD artifacts to production React
// components and track sync state.
//
// Layer 6 of the React component development integration
// (specs/current/react-component-dev-integration.md).

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';

type SqliteDb = Database.Database;

export type ComponentSyncStatus = 'linked' | 'synced' | 'unsynced';

export interface ComponentMapping {
  /** Relative path in the project: "src/components/metrics/KpiCard.tsx" */
  componentPath: string;
  /** Project-relative OD artifact path: ".od/artifacts/dashboard-v1/" */
  artifactDir: string;
  /** Current sync state */
  status: ComponentSyncStatus;
  /** SHA256 hash of the artifact's primary HTML at last sync time */
  artifactHash: string | null;
  /** SHA256 hash of the source file at last sync time */
  sourceHash: string | null;
  /** ISO timestamp of last translation */
  translatedAt: string | null;
  /** ISO timestamp of last sync */
  lastSyncAt: string | null;
  sourceSkillId?: string | undefined;
}

export interface ComponentStatusReport {
  projectId: string;
  mappings: ComponentMapping[];
  summary: {
    linked: number;
    synced: number;
    unsynced: number;
  };
}

export function initComponentSyncTable(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS component_sync_mappings (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      component_path TEXT NOT NULL,
      artifact_dir TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'linked',
      artifact_hash TEXT,
      source_hash TEXT,
      translated_at TEXT,
      last_sync_at TEXT,
      source_skill_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_component_sync_project ON component_sync_mappings(project_id);
  `);
}

/** Link a component to an OD artifact. Called after translation. */
export function linkComponentToArtifact(
  db: SqliteDb,
  projectId: string,
  componentPath: string,
  artifactDir: string,
  baseDir: string,
  sourceSkillId?: string,
): ComponentMapping {
  assertProjectRelativeInput(baseDir, componentPath);
  assertProjectRelativeInput(baseDir, artifactDir);

  const id = `${projectId}:${componentPath}`;
  const now = new Date().toISOString();
  const artifactHash = hashFile(baseDir, artifactDir);
  const sourceHash = hashFile(baseDir, componentPath);

  const existing = db
    .prepare('SELECT id FROM component_sync_mappings WHERE id = ?')
    .get(id) as { id: string } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE component_sync_mappings
      SET artifact_dir = ?,
          status = 'linked',
          artifact_hash = ?,
          source_hash = ?,
          translated_at = ?,
          source_skill_id = ?,
          updated_at = ?
      WHERE id = ?
    `).run(artifactDir, artifactHash, sourceHash, now, sourceSkillId ?? null, now, id);
  } else {
    db.prepare(`
      INSERT INTO component_sync_mappings
        (id, project_id, component_path, artifact_dir, status, artifact_hash, source_hash, translated_at, source_skill_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'linked', ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, componentPath, artifactDir, artifactHash, sourceHash, now, sourceSkillId ?? null, now, now);
  }

  return {
    componentPath,
    artifactDir,
    status: 'linked',
    artifactHash,
    sourceHash,
    translatedAt: now,
    lastSyncAt: null,
    sourceSkillId,
  };
}

/** Mark a component as synced (source matches artifact). */
export function markComponentSynced(
  db: SqliteDb,
  projectId: string,
  componentPath: string,
  baseDir: string,
): ComponentMapping | null {
  assertProjectRelativeInput(baseDir, componentPath);

  const id = `${projectId}:${componentPath}`;
  const row = db
    .prepare('SELECT * FROM component_sync_mappings WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;

  const now = new Date().toISOString();
  const artifactHash = hashFile(baseDir, row.artifact_dir as string);
  const sourceHash = hashFile(baseDir, row.component_path as string);

  db.prepare(`
    UPDATE component_sync_mappings
    SET status = 'synced',
        artifact_hash = ?,
        source_hash = ?,
        last_sync_at = ?
    WHERE id = ?
  `).run(artifactHash, sourceHash, now, id);

  return {
    componentPath: row.component_path as string,
    artifactDir: row.artifact_dir as string,
    status: 'synced',
    artifactHash,
    sourceHash,
    translatedAt: row.translated_at as string | null,
    lastSyncAt: now,
    sourceSkillId: row.source_skill_id as string | undefined,
  };
}

/** Detect if a component is out of sync with its linked artifact. */
export function detectUnsynced(
  db: SqliteDb,
  projectId: string,
  baseDir: string,
): ComponentMapping[] {
  const rows = db
    .prepare('SELECT * FROM component_sync_mappings WHERE project_id = ?')
    .all(projectId) as Array<Record<string, unknown>>;

  const out: ComponentMapping[] = [];
  for (const row of rows) {
    const artifactHash = hashFile(baseDir, row.artifact_dir as string);
    const sourceHash = hashFile(baseDir, row.component_path as string);

    const status: ComponentSyncStatus =
      sourceHash === row.source_hash ? 'synced' : 'unsynced';

    if (status !== row.status) {
      db.prepare('UPDATE component_sync_mappings SET status = ? WHERE id = ?')
        .run(status, row.id);
    }

    out.push({
      componentPath: row.component_path as string,
      artifactDir: row.artifact_dir as string,
      status,
      artifactHash,
      sourceHash,
      translatedAt: row.translated_at as string | null,
      lastSyncAt: row.last_sync_at as string | null,
      sourceSkillId: row.source_skill_id as string | undefined,
    });
  }

  return out;
}

/** Get full status report for a project. */
export function getComponentStatus(
  db: SqliteDb,
  projectId: string,
  baseDir: string,
): ComponentStatusReport {
  const mappings = detectUnsynced(db, projectId, baseDir);
  return {
    projectId,
    mappings,
    summary: {
      linked: mappings.filter((m) => m.status === 'linked').length,
      synced: mappings.filter((m) => m.status === 'synced').length,
      unsynced: mappings.filter((m) => m.status === 'unsynced').length,
    },
  };
}

/** Unlink a component from its artifact. */
export function unlinkComponent(
  db: SqliteDb,
  projectId: string,
  componentPath: string,
): boolean {
  const id = `${projectId}:${componentPath}`;
  const result = db.prepare('DELETE FROM component_sync_mappings WHERE id = ?').run(id);
  return result.changes > 0;
}

/** Compute SHA256 hash of a file or the primary HTML file in a directory. */
function hashFile(baseDir: string, relativePath: string): string | null {
  try {
    // If path ends with .tsx/.jsx, hash the file directly
    if (/\.(tsx|jsx)$/i.test(relativePath)) {
      const content = readFileSync(resolveProjectRelativePath(baseDir, relativePath), 'utf8');
      return createHash('sha256').update(content).digest('hex').slice(0, 16);
    }
    // Otherwise, treat as artifact directory and hash index.html
    const indexPath = resolveProjectRelativePath(baseDir, relativePath, 'index.html');
    const content = readFileSync(indexPath, 'utf8');
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

function assertProjectRelativeInput(baseDir: string, relativePath: string): void {
  if (relativePath.trim().length === 0 || isAbsolute(relativePath)) {
    throw new Error('Path must be project-relative');
  }
  resolveProjectRelativePath(baseDir, relativePath);
}

function resolveProjectRelativePath(baseDir: string, ...relativeParts: string[]): string {
  const base = resolve(baseDir);
  const target = normalize(resolve(join(base, ...relativeParts)));
  const rel = relative(base, target);
  if (rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !/^[A-Za-z]:/.test(rel))) {
    return target;
  }
  throw new Error('Path escapes project directory');
}
