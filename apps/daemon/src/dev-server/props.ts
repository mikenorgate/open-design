// Prop extraction for React components.
//
// Parses TypeScript .tsx files to extract component props and renders
// them as live-slider/select/toggle controls in the OD sidebar.
//
// Layer 5 of the React component development integration
// (specs/current/react-component-dev-integration.md).

import { readFileSync } from 'fs';
import path from 'path';

export interface PropInfo {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'ReactNode' | 'function' | 'unknown';
  required: boolean;
  defaultValue?: unknown;
  enumValues?: string[];
  min?: number;
  max?: number;
  description?: string;
}

export interface ComponentProps {
  componentName: string;
  filePath: string;
  props: PropInfo[];
  storybookDefaults?: Record<string, unknown>;
  parsedFrom: 'storybook' | 'typescript' | 'regex';
}

/** Extract props from a .tsx component file. Priority: Storybook > TS > regex. */
export function extractComponentProps(
  filePath: string,
  source: string,
): ComponentProps | null {
  const baseName = path.basename(filePath, path.extname(filePath));

  const storyPath = findCompanionFile(filePath, baseName, '.stories.tsx');
  if (storyPath) {
    const storySource = tryReadFile(storyPath);
    if (storySource) {
      const storyDefaults = extractStorybookArgs(storySource);
      if (storyDefaults && Object.keys(storyDefaults).length > 0) {
        return {
          componentName: baseName,
          filePath,
          props: Object.entries(storyDefaults).map(([name, value]) => ({
            name,
            type: inferPropType(value),
            required: false,
            defaultValue: value,
          })),
          storybookDefaults: storyDefaults,
          parsedFrom: 'storybook',
        };
      }
    }
  }

  const tsProps = extractTypeScriptProps(source);
  if (tsProps && tsProps.length > 0) {
    return { componentName: baseName, filePath, props: tsProps, parsedFrom: 'typescript' };
  }

  const regexProps = extractRegexProps(source);
  if (regexProps && regexProps.length > 0) {
    return { componentName: baseName, filePath, props: regexProps, parsedFrom: 'regex' };
  }

  return null;
}

// --- Storybook args ---

function extractStorybookArgs(source: string): Record<string, unknown> | null {
  const argsMatch = source.match(/(?:args|argTypes)\s*:\s*\{([^}]*)\}/s);
  if (!argsMatch?.[1]) return null;

  const argsBlock = argsMatch[1];
  const parsed: Record<string, unknown> = {};

  const lines = argsBlock.split(/\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
    const simple = trimmed.match(/(\w+)\s*:\s*(.+?)\s*,?\s*$/);
    if (simple?.[1] && simple[2]) {
      const key = simple[1];
      const raw = simple[2].replace(/,\s*$/, '').trim();
      parsed[key] = parseRawValue(raw);
    }
  }

  return Object.keys(parsed).length > 0 ? parsed : null;
}

function parseRawValue(raw: string): unknown {
  if (raw.startsWith('"') || raw.startsWith("'")) return raw.slice(1, -1);
  const num = Number(raw);
  if (!isNaN(num) && /^\d+$/.test(raw)) return num;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null' || raw === 'undefined') return null;
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  return raw;
}

// --- TypeScript props ---

function extractTypeScriptProps(source: string): PropInfo[] | null {
  const match = source.match(/(?:interface|type)\s+(\w+)(?:Props)?\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/s);
  if (!match?.[2]) return null;

  const body = match[2];
  const props: PropInfo[] = [];

  const lines = body.split(/[;\n]/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
    if (trimmed === '{' || trimmed === '}') continue;

    const propMatch = trimmed.match(/(\w+)\s*(\?)?\s*:\s*(.+?)(?:;|\s*\/\/.*|$)/);
    if (!propMatch?.[1] || !propMatch[3]) continue;

    const name = propMatch[1];
    const optional = propMatch[2] === '?';
    const typeStr = propMatch[3].trim();

    if (name === 'Props' || name.startsWith('children')) continue;

    props.push({
      name,
      type: classifyType(typeStr),
      required: !optional,
    });
  }

  return props.length > 0 ? props : null;
}

function classifyType(typeStr: string): PropInfo['type'] {
  const t = typeStr.toLowerCase().trim();
  if (t === 'string' || t === 'str') return 'string';
  if (t === 'number' || t === 'num' || t === 'int' || t === 'float') return 'number';
  if (t === 'boolean' || t === 'bool') return 'boolean';
  if (t === 'reactnode' || t === 'react.reactnode' || t === 'react.reactnode') return 'ReactNode';
  if (t.startsWith('(') || t.startsWith('()') || t.includes('=>') ||
      /React\.(?:FC|FunctionComponent|ComponentType)/.test(typeStr) ||
      typeStr.includes('&') || typeStr.includes('extends')) {
    return 'function';
  }
  if (t.includes('|')) {
    const values = t.split('|').map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter((s) => s.length > 0 && !s.includes('(') && !s.includes('=>'));
    return values.length > 0 ? 'enum' : 'string';
  }
  return 'string';
}

// --- Regex fallback ---

function extractRegexProps(source: string): PropInfo[] | null {
  const props: PropInfo[] = [];
  const destructureMatch = source.match(/function\s+\w+\s*\(\s*\{([^}]*)\}\s*(?::\s*\w+\s*\w*)?\s*\)/);
  if (!destructureMatch?.[1]) return null;

  const params = destructureMatch[1];
  const parts = params.split(',').map((p) => p.trim());

  for (const part of parts) {
    const nameDefault = part.match(/(\w+)\s*(?:=\s*(.+?))?\s*$/);
    if (!nameDefault?.[1]) continue;
    const name = nameDefault[1];
    const rawDefault = nameDefault[2];
    const type: PropInfo['type'] = inferPropType(rawDefault);
    const prop: PropInfo = { name, type, required: !rawDefault };
    if (rawDefault) prop.defaultValue = parseRawValue(rawDefault);
    if (type === 'number' && typeof prop.defaultValue === 'number') {
      prop.min = 0;
      prop.max = (prop.defaultValue as number) > 100 ? (prop.defaultValue as number) * 2 : (prop.defaultValue as number) * 10;
    }
    props.push(prop);
  }

  return props.length > 0 ? props : null;
}

function inferPropType(value: unknown): PropInfo['type'] {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (value === null || value === undefined) return 'string';
  if (Array.isArray(value)) return 'enum';
  return 'string';
}

// --- Helpers ---

function tryReadFile(filePath: string): string | null {
  try { return readFileSync(filePath, 'utf8'); } catch { return null; }
}

function findCompanionFile(componentPath: string, baseName: string, suffix: string): string | null {
  try { return path.resolve(path.join(path.dirname(componentPath), baseName + suffix)); } catch { return null; }
}
