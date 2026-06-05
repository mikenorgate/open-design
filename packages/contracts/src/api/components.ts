// Component discovery types for the React component development
// integration (Layer 3).
//
// See specs/current/react-component-dev-integration.md.

/** Metadata about a discovered React component. */
export interface ComponentInfo {
  /** Relative path from project root: "src/components/ui/Button.tsx" */
  file: string;
  /** Component name extracted from export: "Button" */
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

/** Full component registry for a project. */
export interface ComponentRegistryResponse {
  projectId: string;
  projectDir: string;
  components: ComponentInfo[];
  indexedAt: number;
  framework: string;
  count: number;
}
