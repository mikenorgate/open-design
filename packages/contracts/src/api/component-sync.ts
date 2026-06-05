// Component sync status contracts for the React component
// development integration (Layer 6).
//
// See specs/current/react-component-dev-integration.md.

/** Sync state between an OD artifact and a React component. */
export type ComponentSyncStatus = 'linked' | 'synced' | 'unsynced';

export interface ComponentMapping {
  componentPath: string;
  artifactDir: string;
  status: ComponentSyncStatus;
  artifactHash: string | null;
  sourceHash: string | null;
  translatedAt: string | null;
  lastSyncAt: string | null;
  sourceSkillId?: string;
}

export interface ComponentStatusReportResponse {
  projectId: string;
  mappings: ComponentMapping[];
  summary: { linked: number; synced: number; unsynced: number };
}

export interface ComponentLinkRequest {
  componentPath: string;
  artifactDir: string;
  sourceSkillId?: string;
}

export interface ComponentSyncRequest {
  componentPath: string;
}

export interface ComponentUnlinkRequest {
  componentPath: string;
}

export interface ComponentLinkResponse {
  mapping: ComponentMapping;
}

export interface ComponentSyncResponse {
  mapping: ComponentMapping;
}

export interface ComponentUnlinkResponse {
  unlinked: boolean;
}
