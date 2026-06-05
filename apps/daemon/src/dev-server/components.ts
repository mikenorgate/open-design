// Component discovery for folder-imported React projects.
//
// Walks the project's src/ directory, detects .tsx/.jsx component files,
// and extracts metadata (name, export style, companion stories/tests).
//
// Layer 3 of the React component development integration
// (specs/current/react-component-dev-integration.md).

import { accessSync, constants, lstatSync, readdirSync, statSync, readFileSync, type Stats } from 'node:fs';
import path from 'node:path';

export interface ComponentInfo {
  /** Relative path from project root: "src/components/ui/Button.tsx" */
  file: string;
  /** Component name extracted from the export: "Button" */
  name: string;
  /** How the component is exported */
  exportType: 'named' | 'default' | 'unknown';
  /** Companion story file if present, relative to project root */
  storyFile: string | null;
  /** Companion test file if present, relative to project root */
  testFile: string | null;
  /** Whether the file declares a props interface/type */
  hasProps: boolean;
  /** File size in bytes */
  size: number;
  /** Last modified timestamp (mtime ms) */
  mtime: number;
  /** Grouping based on parent directory: "ui", "metrics", "data-display" */
  domain: string;
}

export interface ComponentRegistry {
  projectId: string;
  projectDir: string;
  components: ComponentInfo[];
  indexedAt: number;
  framework: string;
  /** Total component count (directly under src/components/) */
  count: number;
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.output',
  'out',
  'coverage',
  '__pycache__',
  '.venv',
  'vendor',
  'target',
  '.od',
  '.tmp',
]);

const COMPONENT_EXTENSIONS = new Set(['.tsx', '.jsx']);

/**
 * Discover React components in a project directory. Walks
 * `src/components/` (or `components/` at the root), detects
 * .tsx/.jsx files that export React components.
 */
export function discoverComponents(
  projectDir: string,
  projectId: string,
): ComponentRegistry {
  const srcDir = resolveSrcDir(projectDir);
  const componentsDir = resolveComponentsDir(srcDir);

  const components: ComponentInfo[] = [];
  const startedAt = Date.now();

  if (componentsDir) {
    walkDir(componentsDir, componentsDir, projectDir, components);
  }

  return {
    projectId,
    projectDir,
    components: components.sort((a, b) => a.file.localeCompare(b.file)),
    indexedAt: Date.now(),
    framework: detectFramework(projectDir),
    count: components.length,
  };
}

function resolveSrcDir(projectDir: string): string {
  const candidates = [path.join(projectDir, 'src'), path.join(projectDir, 'app')];
  for (const candidate of candidates) {
    try {
      const st = statSync(candidate);
      if (st.isDirectory()) return candidate;
    } catch {
      // Doesn't exist.
    }
  }
  return projectDir; // Fallback: treat project root as source
}

function resolveComponentsDir(srcDir: string): string | null {
  const candidates = [
    path.join(srcDir, 'components'),
    path.join(srcDir, 'component'),
    path.join(srcDir, 'ui'),
  ];
  for (const candidate of candidates) {
    try {
      const st = statSync(candidate);
      if (st.isDirectory()) return candidate;
    } catch {
      // Doesn't exist.
    }
  }
  return null;
}

function walkDir(
  dir: string,
  componentsRoot: string,
  projectRoot: string,
  out: ComponentInfo[],
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir, { encoding: 'utf8' });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const base = path.basename(entry);

    // Skip hidden files and special dirs
    if (base.startsWith('.') || base.startsWith('__') || SKIP_DIRS.has(base)) {
      continue;
    }

    let st: Stats;
    try {
      const lst = lstatSync(fullPath);
      if (lst.isSymbolicLink()) continue;
      st = statSync(fullPath);
      if (!isInsideProject(projectRoot, fullPath)) continue;
    } catch {
      continue;
    }

    if (st.isDirectory()) {
      walkDir(fullPath, componentsRoot, projectRoot, out);
    } else if (st.isFile()) {
      const ext = path.extname(entry).toLowerCase();
      if (COMPONENT_EXTENSIONS.has(ext)) {
        const info = parseComponentFile(fullPath, componentsRoot, projectRoot, st);
        if (info) {
          out.push(info);
        }
      }
    }
  }
}

/**
 * Parse a single .tsx/.jsx file to extract component metadata.
 * Uses fast regex-based detection — no AST parser required.
 */
function parseComponentFile(
  filePath: string,
  componentsRoot: string,
  projectRoot: string,
  st: Stats,
): ComponentInfo | null {
  let source: string;
  try {
    source = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const relativePath = path.relative(projectRoot, filePath);
  const dirName = path.dirname(filePath);
  const baseName = path.basename(filePath, path.extname(filePath));
  const domain = path.relative(componentsRoot, dirName) || 'root';

  // Detect component name and export type
  const { name, exportType } = detectComponentExport(source, baseName);

  // Skip files that don't look like React components (no JSX or createElement)
  if (!looksLikeComponent(source)) return null;

  // Detect companion files
  const storyFile = findCompanionFile(filePath, baseName, '.stories.tsx') ??
    findCompanionFile(filePath, baseName, '.stories.jsx');
  const testFile = findCompanionFile(filePath, baseName, '.test.tsx') ??
    findCompanionFile(filePath, baseName, '.test.ts') ??
    findCompanionFile(filePath, baseName, '.spec.tsx') ??
    findCompanionFile(filePath, baseName, '.spec.ts');

  // Detect props
  const hasProps = /\b(?:interface|type)\s+\w*Props\b/.test(source);

  return {
    file: relativePath,
    name,
    exportType,
    storyFile: storyFile ? path.relative(projectRoot, storyFile) : null,
    testFile: testFile ? path.relative(projectRoot, testFile) : null,
    hasProps,
    size: st.size,
    mtime: st.mtime.getTime(),
    domain,
  };
}

/**
 * Detect the component name and export style from source text.
 */
function detectComponentExport(
  source: string,
  fallbackName: string,
): { name: string; exportType: 'named' | 'default' | 'unknown' } {
  // Try: export default function Foo(
  let m = source.match(/export\s+default\s+function\s+(\w+)\s*\(/);
  if (m?.[1]) return { name: m[1], exportType: 'default' };

  // Try: export default function (anonymous)
  if (/export\s+default\s+function\s*\(/.test(source)) {
    return { name: fallbackName, exportType: 'default' };
  }

  // Try: export function Foo(
  m = source.match(/export\s+function\s+(\w+)\s*\(/);
  if (m?.[1]) return { name: m[1], exportType: 'named' };

  // Try: export const Foo = ... or export const Foo:
  m = source.match(/export\s+const\s+(\w+)\s*[:=]/);
  if (m?.[1]) return { name: m[1], exportType: 'named' };

  // Try: export default Foo;
  m = source.match(/export\s+default\s+(\w+)\s*;?/);
  if (m?.[1]) return { name: m[1], exportType: 'default' };

  // Try: export { Foo } or export { Foo as default }
  m = source.match(/export\s*\{([^}]*)\}/);
  if (m?.[1]) {
    const specifiers = m[1];
    const defaultMatch = specifiers.match(/(\w+)\s+as\s+default/);
    if (defaultMatch?.[1]) return { name: defaultMatch[1], exportType: 'default' };
    const namedMatch = specifiers.match(/(\w+)(?:\s+as\s+\w+)?/);
    if (namedMatch?.[1]) return { name: namedMatch[1], exportType: 'named' };
  }

  // Nothing detected — use filename as fallback
  return { name: fallbackName, exportType: 'unknown' };
}

/**
 * Quick heuristic: does this file look like a React component?
 * Checks for JSX, React.createElement, or React imports.
 */
function looksLikeComponent(source: string): boolean {
  // JSX syntax: <Foo> or <div> or self-closing <Foo />
  if (/<\w+[^>]*\/?>/.test(source)) return true;
  // React.createElement
  if (/React\.createElement/.test(source)) return true;
  // Has a React import
  if (/from\s+['"]react['"]/.test(source)) return true;
  return false;
}

function findCompanionFile(
  componentPath: string,
  baseName: string,
  suffix: string,
): string | null {
  const dir = path.dirname(componentPath);
  const candidate = path.join(dir, baseName + suffix);
  try {
    accessSync(candidate, constants.R_OK);
    return candidate;
  } catch {
    return null;
  }
}

function isInsideProject(projectRoot: string, fullPath: string): boolean {
  const root = path.resolve(projectRoot);
  const target = path.resolve(fullPath);
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function detectFramework(projectDir: string): string {
  try {
    accessSync(path.join(projectDir, 'next.config.ts'), constants.R_OK);
    return 'next';
  } catch {}
  try {
    accessSync(path.join(projectDir, 'next.config.mjs'), constants.R_OK);
    return 'next';
  } catch {}
  try {
    accessSync(path.join(projectDir, 'vite.config.ts'), constants.R_OK);
    return 'vite';
  } catch {}
  try {
    accessSync(path.join(projectDir, 'vite.config.js'), constants.R_OK);
    return 'vite';
  } catch {}
  return 'unknown';
}
