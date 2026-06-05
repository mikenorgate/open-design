// Component props types for the React component development
// integration (Layer 5).
//
// See specs/current/react-component-dev-integration.md.

/** A single component prop. */
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

/** Full props for one component. */
export interface ComponentPropsResponse {
  componentName: string;
  filePath: string;
  props: PropInfo[];
  storybookDefaults?: Record<string, unknown>;
  parsedFrom: 'storybook' | 'typescript' | 'regex';
}
