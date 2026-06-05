# React Component Development — Full End-to-End Integration Plan

## Overview

This plan maps the work needed to make Open Design a visual design tool for
real production React components. Today OD produces standalone HTML/JSX
previewed in sandboxed iframes with vendored React 18 + Babel standalone. A
full integration would let OD:

1. Discover components in a folder-imported React project
2. Render them live from the project's actual dev server (Tailwind, shadcn/ui,
   CSS variables, imports all working)
3. Enable OD's comment mode, inspect, and tweaks on real React components
4. Drive component props through live sliders (no agent round-trip for prop
   exploration)
5. Write tweaks back to `.tsx` source files through the agent

The plan is ordered as six layers, each building on the previous. Layers 1–3
are straightforward engineering; layers 4–6 need more design work.

## Current implementation status

This spec remains the long-term plan. The current source-tree implementation now supports:

- folder-linked React projects starting a preview server from the workspace;
- Storybook-first discovery, with an auxiliary full app dev server when Storybook is configured;
- an App Preview tab that opens and stays pinned while the dev server is running;
- Inspect, Comment, Draw, and Reload controls on App Preview;
- root-relative app requests routed through the app proxy so framework proxy rules still apply;
- Vite HMR and Storybook WebSocket proxying;
- React page context capture for route, document title, and component summaries;
- App Preview context attached to chat sends, queued sends, and element comments;
- production `.tsx` and `.jsx` files opening visual React preview unless an explicit artifact manifest selects the standalone React artifact renderer;
- daemon APIs for component discovery, prop extraction, and component-sync status.

Not complete yet:

- Component Picker and Prop Controls are not mounted.
- Inspect style edits are live preview changes only; they are not persisted back to source.
- Story mapping still uses sibling story files and simple Storybook title parsing.
- React owner stacks are best-effort and depend on what the running React build exposes.
- Optional framework plugin packages are deferred; bridge injection currently lives in the daemon proxy.

---

## Layer 1 — Dev Server Lifecycle Management

### What exists today

The daemon spawns long-running agent CLI processes (`claude`, `codex`, etc.)
with full lifecycle management: detection, spawn, streaming, cancel, restart.
`apps/daemon/src/runtimes/` owns all of this. The agent runtime registry
(`runtimes/defs/`) has per-adapter definitions with binary paths, argument
builders, env setup, stdin/stderr/stdout plumbing, and process stamps.

Folder-imported projects already set `metadata.baseDir` to a user-owned
directory. The daemon reads and writes files there directly.

### What to build

Add a new process domain to the daemon: **dev servers**. Not another agent
adapter — a sibling concept for build tool processes.

#### 1.1 Dev server discovery (`apps/daemon/src/dev-server/discovery.ts`)

```typescript
interface DevServerConfig {
  command: string;          // "npm run dev" | "vite" | "pnpm dev" | custom
  args: string[];
  cwd: string;              // project baseDir
  port: number;             // allocated by daemon
  framework: "vite" | "next" | "remix" | "astro" | "unknown";
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
}
```

Detection logic (in priority order per framework):
1. **Vite:** `vite.config.ts` / `vite.config.js` exists → `npx vite --port <port>`
2. **Next.js:** `next.config.ts` / `next.config.mjs` exists → `npx next dev -p <port>`
3. **Remix:** `remix.config.js` / `remix.config.ts` exists → `npx remix dev --port <port>`
4. **Astro:** `astro.config.mjs` exists → `npx astro dev --port <port>`

Package manager detection: read `packageManager` field from `package.json`, or
detect lockfile presence (`pnpm-lock.yaml` > `yarn.lock` > `bun.lockb` >
fallback `npm`).

Port allocation: use a new daemon port range (e.g. `7457-7556`, adjacent to the
daemon's own `7456`). Pick the first free port, record it in a per-project
dev-server tracking store so restarts reuse the same port.

#### 1.2 Dev server process management (`apps/daemon/src/dev-server/runner.ts`)

Same pattern as agent spawning in `runtimes/launch.ts`:

```typescript
interface DevServerHandle {
  projectId: string;
  config: DevServerConfig;
  process: ChildProcess;
  startedAt: number;
  url: string;  // "http://localhost:<port>"
  status: "starting" | "running" | "error" | "stopped";
  lastError?: string;
}
```

Lifecycle:
- `start`: spawn the dev command, parse stdout for "ready" signal (port + URL),
  resolve when the server accepts HTTP connections (poll `GET /` with timeout).
  Report URL back.
- `health`: periodic health check (`GET /` every 15s). If unresponsive for 3
  checks, mark as `error` and emit an event.
- `stop`: SIGTERM with grace period, SIGKILL fallback.
- `restart`: stop + start. Used when the user changes config or installs deps.

#### 1.3 HTTP API and CLI

```
POST   /api/projects/:id/dev-server/start      body: {}  → { url, port, status }
GET    /api/projects/:id/dev-server/status      → { url, port, status, framework, uptime }
POST   /api/projects/:id/dev-server/stop
POST   /api/projects/:id/dev-server/restart
```

CLI surface (`apps/daemon/src/cli.ts`):
```bash
od project dev-server start [--project <id>]
od project dev-server status [--project <id>] [--json]
od project dev-server stop   [--project <id>]
```

#### 1.4 Daemon startup hook

When the daemon starts and has folder-imported projects, optionally auto-start
dev servers for projects with an active session. Controlled by a project-level
config flag (`devServer.autoStart`, default false). Users opt in.

#### 1.5 Contracts (`packages/contracts/src/api/dev-server.ts`)

```typescript
interface DevServerStartRequest {}
interface DevServerStartResponse {
  url: string;
  port: number;
  status: "starting" | "running";
  framework: string;
}

interface DevServerStatusResponse {
  url: string | null;
  port: number | null;
  status: "stopped" | "starting" | "running" | "error";
  framework: string | null;
  uptime: number | null;
  lastError: string | null;
}

interface DevServerStopResponse {
  status: "stopped";
}
```

**Files changed:**
- New: `apps/daemon/src/dev-server/discovery.ts`
- New: `apps/daemon/src/dev-server/runner.ts`
- New: `apps/daemon/src/dev-server/routes.ts`
- New: `apps/daemon/tests/dev-server/` (tests)
- Modify: `apps/daemon/src/server.ts` (register dev-server routes)
- Modify: `apps/daemon/src/cli.ts` (add `dev-server` subcommands)
- New: `packages/contracts/src/api/dev-server.ts`

**Effort:** ~600 lines daemon, ~200 lines CLI, ~100 lines contracts, ~200
lines tests. ~2 days.

---

## Layer 2 — Preview Proxy

### What exists today

The `ReactComponentViewer` in `FileViewer.tsx` uses `buildReactComponentSrcdoc`
to transpile `.tsx`/`.jsx` in a sandboxed iframe. It:
- Strips all non-React imports
- Replaces `import ... from 'react'` with `window.React`
- Runs Babel standalone for JSX/TSX transformation
- Renders via `srcDoc` attribute

This works for standalone files but cannot handle:
- Tailwind CSS (no JIT compiler)
- shadcn/ui primitives (`import { Button } from "@/components/ui/button"`)
- CSS variables from the project
- Any external dependency

`file-viewer-render-mode.ts` decides between URL-load and srcDoc. URL-load
(`<iframe src="/api/projects/:id/raw/:file">`) serves the raw artifact via the
daemon and lets the browser resolve `<script src>` and `<link href>` for
multi-file artifacts. The decision tree currently prefers URL-load unless
bridges (inspect, comment, palette, tweaks, draw) are needed, in which case it
falls back to srcDoc.

### What to build

Add a **third render mode**: dev-server proxy. The iframe loads from the
daemon, which proxies requests to the Vite/Next dev server. The proxy can
inject OD's bridges into the HTML response before it reaches the iframe.

#### 2.1 Dev server proxy route (`apps/daemon/src/dev-server/proxy.ts`)

```
GET /api/projects/:id/dev-server/proxy/*
```

The daemon acts as a reverse proxy:
1. Receives the request from the iframe
2. Forwards it to the dev server at `http://localhost:<devPort>/<path>`
3. For HTML responses (Content-Type: text/html): injects OD's bridge scripts
   before returning to the iframe
4. For all other responses (JS, CSS, images, HMR WebSocket): passes through
   unchanged

Bridge injection for HTML responses uses the same pattern as `buildSrcdoc` in
`runtime/srcdoc.ts` but at the proxy layer:
- Inject `data-od-id` annotation bridge (same `annotateMissingOdIds` logic)
- Inject inspect/selection bridge
- Inject comment mode bridge
- Inject tweaks palette bridge
- Inject manual edit bridge
- Inject focus guard
- Inject sandbox shims (different: the dev server may ship its own sandbox
  trampoline that we need to intercept)

The proxy reuses existing bridge code from `apps/web/src/runtime/srcdoc.ts` by
extracting the injection logic into a shared module in
`packages/shared-preview-bridges/` (or moving it to `apps/daemon/src/` since
the daemon already has a `frames/` concept for iframe-serving).

#### 2.2 HMR awareness

Vite's HMR works over WebSocket (`ws://localhost:<port>` by default) or
server-sent events. The proxy must handle WebSocket upgrade for HMR paths:

```
GET /api/projects/:id/dev-server/proxy/__vite_hmr
Upgrade: websocket
```

The daemon upgrades to a WebSocket connection to the dev server and relays
messages bidirectionally. This is the same pattern as the daemon's existing
SSE streaming for agent output — just WebSocket instead of SSE.

Next.js uses its own HMR mechanism; detect the framework and handle
accordingly.

#### 2.3 iframe sandbox adjustment

The dev server needs to run with `allow-same-origin` so it can access its own
`localStorage`, make fetch requests to its own API routes, and run WebSocket
connections for HMR. This relaxes the existing blanket sandbox, but the dev
server is an isolated process on a dedicated port — the risk is the same as
the user running `npm run dev` in a browser tab.

```html
<iframe
  sandbox="allow-scripts allow-same-origin"
  src="/api/projects/:id/dev-server/proxy/"
  ...
/>
```

#### 2.4 Render mode decision update

`file-viewer-render-mode.ts` gets a new check for dev-server mode:

```typescript
export function shouldUrlLoadHtmlPreview(d: UrlLoadDecision): boolean {
  // ... existing checks ...
  if (d.devServerUrl) return true;  // dev-server proxy path
  // ...
}
```

Dev-server mode takes highest priority — if a dev server is running, always
use it for preview.

When dev-server is active for a project:
- `.tsx`/`.jsx` files render through the dev server (no more Babel standalone)
- `.html` files still use the existing URL-load or srcDoc paths
- `react-component` renderer delegates to dev-server when available

#### 2.5 Contracts

```typescript
interface DevServerProxyInfo {
  projectId: string;
  devServerUrl: string;
  proxyBasePath: string;  // "/api/projects/:id/dev-server/proxy"
}
```

**Files changed:**
- New: `apps/daemon/src/dev-server/proxy.ts`
- Modify: `apps/daemon/src/dev-server/routes.ts` (add proxy route + WebSocket
  upgrade)
- Modify: `apps/web/src/components/file-viewer-render-mode.ts` (dev-server
  decision)
- Modify: `apps/web/src/components/FileViewer.tsx` (ReactComponentViewer →
  dev-server path when available)
- Modify: `apps/web/src/providers/registry.ts` (fetch dev-server status)
- New: `apps/daemon/tests/dev-server/proxy.test.ts`

**Effort:** ~800 lines daemon, ~300 lines web UI, ~200 lines tests. ~3 days.

---

## Layer 3 — Component Registry

### What exists today

The file workspace (`FileWorkspace.tsx`) already lists files in
`src/components/` for folder-imported projects. The artifact manifest system
(`artifacts/manifest.ts`) recognizes `.tsx`/`.jsx` as `react-component` kind.

There is no concept of "components" as semantic units — just files.

### What to build

A component registry that discovers React components, extracts metadata, and
makes them individually previewable in a component picker sidebar.

#### 3.1 Component discovery (`apps/daemon/src/dev-server/components.ts`)

Walk `src/components/` recursively, detect `.tsx`/`.jsx` files, parse each for:

```typescript
interface ComponentInfo {
  file: string;                     // "src/components/metrics/KpiCard.tsx"
  name: string;                     // "KpiCard"
  exportType: "named" | "default";  // how it's exported
  imports: string[];                // other components it imports
  storyFile: string | null;         // "KpiCard.stories.tsx" if exists
  testFile: string | null;          // "KpiCard.test.tsx" if exists
  hasProps: boolean;                // has an interface/type for props
}
```

Initial discovery: regex-based (fast, no parser dependency):
- Detect `export function <Name>` / `export const <Name>` / `export default`
- Detect companion `.stories.tsx` / `.test.tsx` by glob
- Detect props by looking for `interface <Name>Props` / `type <Name>Props`

More robust parsing (optional Layer 3.1): use `ts-morph` to parse TypeScript
AST and extract full prop interfaces. This is non-trivial and can be deferred.

#### 3.2 Component registry API

```
GET /api/projects/:id/dev-server/components
  → { components: ComponentInfo[], framework: "vite" | "next" | ... }
```

Refresh on file change: watch `src/components/` with `chokidar` (already used
by the skill registry). Debounced re-index on changes.

#### 3.3 Component picker UI (`apps/web/src/components/ComponentPicker.tsx`)

A sidebar panel showing the component tree, grouped by domain folder:

```
src/components/
├── ui/
│   ├── Button
│   ├── Card
│   └── ...
├── metrics/
│   ├── KpiCard          [selected ●]
│   ├── MetricsGrid
│   └── Sparkline
├── data-display/
│   └── ...
└── ...
```

Clicking a component:
- Focuses the preview on that component
- If the component has a Storybook story, use the story's default args
- If no story, render the component with default/zero props
- Shows the source code in the Source tab

The picker appears when a project has a running dev server. It replaces or
supplements the file tree in the workspace panel.

#### 3.4 Preview routing

The dev server renders the entire app at the root URL. To preview a single
component, we need a minimal entry point:

**Approach A: Auto-generated preview page.** The daemon generates a temporary
`src/__od-preview/<ComponentName>.tsx` file that imports and renders the
target component with default props. OD's proxy loads
`/__od-preview/<ComponentName>` through the dev server. The file is cleaned up
on preview exit.

**Approach B: Query parameter passthrough.** OD appends
`?od-preview=KpiCard` to the dev-server URL. The project's root component (or
a small wrapper) reads the query param and renders only that component. This
requires project-level cooperation — a one-line addition to `main.tsx` or a
small wrapper component the user imports once.

**Approach C: Module-level request.** The dev server proxy intercepts requests
to a special path (`/__od_preview__/component`) and serves a dynamic HTML page
that imports the target component via the dev server's module resolution. This
requires the dev server to support such a hook (Vite plugin, Next.js
middleware).

Approach A is the least invasive and works without project changes. Approach C
is the cleanest but requires framework-specific plugins. Start with A;
migrate to C as the plugin story matures.

**Files changed:**
- New: `apps/daemon/src/dev-server/components.ts`
- Modify: `apps/daemon/src/dev-server/routes.ts` (component list endpoint)
- New: `apps/web/src/components/ComponentPicker.tsx`
- New: `apps/web/src/components/ComponentPicker.module.css`
- Modify: `apps/web/src/components/FileWorkspace.tsx` (show picker when
  dev-server is active)
- Modify: `apps/web/src/providers/registry.ts` (fetch component list)

**Effort:** ~500 lines daemon, ~600 lines web UI, ~300 lines tests. ~3 days.

---

## Layer 4 — Bridge Injection for Real React Components

### What exists today

OD's bridges (inspect, comment, tweaks, edit, draw, focus guard) are injected
into `srcDoc` HTML via `buildSrcdoc()` in `runtime/srcdoc.ts`. The bridges
work by:
1. Parsing the HTML with DOMParser
2. Injecting `<script>` tags with bridge code
3. Annotating elements with `data-od-id` attributes for selection
4. Host → iframe communication via `postMessage`

The bridges cannot be injected into a URL-loaded iframe because:
- `srcdoc` gives us access to the HTML before it loads
- URL-loaded content arrives from the server as-is
- The existing proxy in Layer 2 gives us an injection point

### What to build

Bridge scripts that work inside a real React app (served by Vite/Next with
HMR, Tailwind, and all dependencies working), plus the injection mechanism.

The current implementation uses daemon-proxy injection. Dedicated framework plugin packages are deferred.

#### 4.1 WebSocket-aware bridge lifecycle

Existing bridges assume a static DOM — they inject once on page load. With
HMR, React can replace subtrees at any time. Bridges need to:

1. **Survive HMR updates.** `data-od-id` annotations must persist across
   component re-renders. Without code changes, React will strip custom
   attributes it doesn't recognize.

2. **Re-annotate after HMR.** After a module hot-replaces, re-run the
   annotation pass on the new DOM.

Solutions:

**For data-od-id persistence (short term):** The proxy-based annotation
(`annotateMissingOdIds`) runs after the dev server returns HTML. It wraps each
component root in a `<div data-od-component="KpiCard">` and injects a
MutationObserver that re-annotates on DOM changes. This is fragile but works
without touching user code.

**For data-od-id persistence (proper):** A future framework plugin could transform
component output to include `data-od-id` attributes natively. This requires user opt-in and is not part of the current source tree.

#### 4.2 Deferred Vite plugin

A future Vite plugin would run in dev mode only:

```typescript
// Hypothetical future vite.config.ts integration.
// No framework plugin package exists in the current source tree.
export default defineConfig({
  plugins: [react(), odPreviewPlugin()],
});
```

The plugin:
1. Adds a virtual module `virtual:od-bridge` that the app can import once in
   `main.tsx` to load the bridge scripts
2. Transforms `.tsx` output to annotate root-level JSX elements with
   `data-od-id` attributes (using a Babel or SWC transform)
3. Generates a component map (`__od_components__.json`) that maps component
   names to their entry points
4. Adds a dev-server middleware that serves the `/__od_preview__/component`
   endpoint for single-component preview

The transform: each exported component gets a wrapping `data-od-id` on its
root element. For example:

```tsx
// Before
export function KpiCard({ value, label }: KpiCardProps) {
  return <Card className="p-4">...</Card>;
}

// After (dev only)
export function KpiCard({ value, label }: KpiCardProps) {
  return <Card className="p-4" data-od-id="KpiCard">...</Card>;
}
```

This is a static Babel/SWC transform, applied only in dev mode (via Vite's
`apply: 'serve'` config). It doesn't affect production builds.

#### 4.3 Deferred Next.js plugin

Same concept for Next.js: a webpack/turbopack plugin that applies the same
transforms. Next.js plugin APIs are different from Vite's, so this would be a
separate package if it is revived.

#### 4.4 Bridge scripts package

A shared bridge package was explored and deferred. The active implementation keeps bridge injection in the daemon proxy. Revisit a shared package if bridge duplication starts to create maintenance problems.

The package exports:
- `buildSelectionBridge()` — inspect/comment element selection
- `buildTweaksBridge()` — tweaks palette
- `buildEditBridge()` — manual edit mode
- `buildFocusGuard()` — prevent focus stealing
- `buildSandboxShims()` — localStorage/sessionStorage polyfills
- `annotateMissingOdIds()` — DOMParser-based element annotation
- `initOdBridges(clientConfig)` — initialize all bridges, listen for HMR

The `initOdBridges` function is what the Vite/Next plugins load. It sets up
MutationObservers for HMR resilience and listens for the dev server's HMR
events to re-initialize after hot module updates.

#### 4.5 Comment mode on real components

Comment mode currently works via `data-od-id` attributes. Once bridges are
injected, comment mode on dev-server-rendered components works exactly the
same as on srcDoc-rendered HTML — click an element, write a comment, agent
receives a surgical edit instruction.

The comment → edit translation stays the same: the daemon composes a prompt
with the selected `data-od-id`, the user's note, and the file path, then the
agent's surgical edit tool targets that region.

#### 4.6 Tweaks on real components

Tweaks work by injecting a palette that overrides CSS properties on selected
elements. With the dev-server path:
1. Tweaks still inject CSS overrides via the palette bridge
2. "Commit tweaks" translates the CSS overrides into source changes
3. The agent writes the changes back to the `.tsx` file
4. Vite HMR hot-reloads the component
5. The preview updates

The tweaks-to-source mapping needs a new step: CSS override → Tailwind class.
For example, `color: #1e293b` → `text-slate-800`. This is a known mapping
problem but solveable: Tailwind's class-to-CSS map is deterministic and can be
precomputed.

**Planned future files:**
- Framework-specific plugin packages, if proxy injection is not enough
- A shared bridge package, if duplicated bridge logic becomes expensive
- Proxy updates to consume shared bridge code
- Modify: `apps/web/src/components/FileViewer.tsx` (bridge initialization
  for dev-server mode)

**Effort:** ~1,500 lines shared package, ~800 lines Vite plugin, ~600 lines
Next.js plugin, ~400 lines proxy/UI integration, ~500 lines tests. ~5 days.

---

## Layer 5 — Live Prop Controls

### What exists today

OD has slider parameters for skills (defined in `SKILL.md` frontmatter as
`od.parameters`). These are per-skill, not per-component, and they re-prompt
the agent rather than controlling live rendering.

Tweaks palette modifies CSS properties on rendered elements. It doesn't
understand component props.

### What to build

Live prop controls that:
1. Discover component props from TypeScript types
2. Render them as sliders/selects/toggles in the OD sidebar
3. Change props → re-render component via the dev server (no agent)
4. Persist prop values as Storybook-like "presets"

#### 5.1 Prop extraction

Extend `ComponentInfo` with prop metadata:

```typescript
interface PropInfo {
  name: string;
  type: "string" | "number" | "boolean" | "enum" | "ReactNode" | "function" | "unknown";
  required: boolean;
  defaultValue?: unknown;
  enumValues?: string[];           // for union string literals
  min?: number;                    // for number props with constraints
  max?: number;
  description?: string;            // from JSDoc comment
}
```

Extraction approach (in order of preference):
1. **Parse Storybook stories.** If `<Component>.stories.tsx` exists, extract
   `args` from the default export. Storybook args already have typed defaults.
   This is the easiest and most reliable source.
2. **Parse TypeScript AST.** Use `ts-morph` to extract the props interface.
   Handles `interface FooProps`, `type FooProps`, and inline props.
3. **Regex fallback.** For when no Storybook story exists and ts-morph isn't
   available (e.g., `node_modules` not installed in the project). Extract prop
   names and basic types from regex patterns.

#### 5.2 Prop control UI (`apps/web/src/components/PropControls.tsx`)

A sidebar panel showing the selected component's props as interactive controls:

```
┌─ KpiCard Props ──────────────────┐
│                                   │
│  value         [    42        ]   │  number slider
│  label         [ Active       ]   │  text input
│  variant       [ default ▾   ]   │  enum dropdown
│  showTrend     [ ✓ ]             │  boolean toggle
│  density       [ comfortable ▾ ]  │  enum dropdown
│                                   │
│  [ Reset to defaults]             │
└───────────────────────────────────┘
```

Control types mapped from PropInfo:
- `string` → text input (or select if `enumValues` is populated)
- `number` → number slider (with min/max from constraints or sensible defaults)
- `boolean` → toggle switch
- `"enum"` → dropdown select
- `"ReactNode"` → skip (can't be meaningfully controlled)
- `"function"` → skip
- `"unknown"` → skip with note

#### 5.3 Prop-to-component communication

When a prop control changes, the new values need to reach the component
rendering inside the iframe. Two approaches:

**Approach A: URL params.** OD reloads the iframe with
`/__od_preview__/KpiCard?value=42&label=Active&variant=compact`. The preview
page reads URL params and passes them as component props. Simple, works with
any framework.

**Approach B: postMessage.** OD sends `{ type: 'od:update-props', props: {
value: 42 } }` via postMessage to the iframe. The bridge script receives it
and updates the rendered component. More responsive (no reload flash), but
requires the component to be wrapped in a stateful container that can receive
prop updates.

Start with Approach A (URL params). It's simpler and already fits the
`/__od_preview__/component` endpoint from Layer 3.

#### 5.4 Prop presets

Save and restore prop combinations:

```typescript
interface PropPreset {
  id: string;
  componentName: string;
  props: Record<string, unknown>;
  label: string;  // "Compact mode", "With sparkline", "Empty state"
}
```

Presets appear as buttons below the prop controls. Clicking one applies all
props at once. Presets can be derived from Storybook stories or saved manually.

Store presets per project in the daemon's data layer (same SQLite,
`prop_presets` table).

#### 5.5 Agent-aware prop exploration

When the user adjusts props and is satisfied:
1. "Save as preset" to persist
2. "Apply to source" sends the prop combination as a prompt to the agent:
   "Update KpiCard to default to `variant='compact'` and `showTrend=true`."

The agent surgically edits the component's default prop values. Vite HMR
hot-reloads. The new defaults are reflected in the prop controls on next load.

**Files changed:**
- Modify: `apps/daemon/src/dev-server/components.ts` (prop extraction)
- New: `apps/daemon/src/dev-server/props.ts` (prop storage, presets)
- New: `apps/web/src/components/PropControls.tsx`
- New: `apps/web/src/components/PropControls.module.css`
- Modify: `apps/web/src/components/ComponentPicker.tsx` (integrate prop
  controls in sidebar)
- Modify: `apps/daemon/src/dev-server/routes.ts` (prop endpoints, preset CRUD)
- New: `packages/contracts/src/api/props.ts`

**Effort:** ~600 lines prop extraction (daemon), ~400 lines prop storage
(daemon), ~700 lines UI, ~300 lines contracts, ~400 lines tests. ~4 days.

---

## Layer 6 — Full Pipeline Integration

### What exists today

- `react-component-dev` plugin (community): 4-stage pipeline (audit → plan →
  generate → critique) that guides the agent through React component
  development
- Folder import: daemon reads/writes directly in the user's project
- Agent adapters: Claude Code, Codex, Copilot, Qoder, etc. all can write files
- Artifact store: plain files with `artifact.json` metadata
- DESIGN.md injection: design systems flow into agent prompts

### What to build

The full loop: design exploration in OD → translation to real component →
visual verification in dev server → comment/tweak refinement → source
writeback.

#### 6.1 Optimized pipeline for the plugin

The existing `react-component-dev` plugin already has the right stages. As the
core layers land, the plugin's prompts become more powerful because the agent
can see the component rendered live:

```
Stage 1 (audit):
  Old: "Read package.json, components.json, Tailwind config, 3 existing
        components to extract conventions."
  New: "+ dev server is running at http://localhost:7457. Load it to see
        the component in context. Check for visual regressions in adjacent
        components after your changes."

Stage 2 (plan):
  Old: "Produce a plan of files to create/modify."
  New: "+ The component picker shows these existing components: [list].
        Plan where the new component fits in the tree."

Stage 3 (generate):
  Old: "Write .tsx, .test.tsx, .stories.tsx."
  New: "+ After writing, wait for HMR to reload. The preview should show
        the component rendered live. If it doesn't appear, the file may
        have a build error."

Stage 4 (critique):
  Old: "Self-review checklist: imports, Tailwind, cn(), a11y, props,
        anti-slop."
  New: "+ Inspect the rendered component in the dev server. Check: does it
        match the DESIGN.md? Are spacing/colors correct? Do hover/focus
        states work? Are there layout breaks at narrow widths?"
```

The critique loop now has visual feedback. The agent can see the rendered
result and catch issues that text-only review misses.

#### 6.2 Tweaks-to-source round-trip

When the user commits a tweak in the palette:

1. Palette computes the CSS changes (e.g., `padding-top: 96px → 128px`)
2. Tweaks bridge sends `{ type: 'od:tweaks-committed', changes: [...] }` via
   postMessage
3. OD's host receives the changes, translates them to Tailwind class changes
   (e.g., `pt-24 → pt-32`)
4. If the element has a `data-od-id` that maps to a source file and component
   (from the Vite plugin), OD constructs a surgical edit prompt:
   "In `src/components/metrics/KpiCard.tsx`, the element identified by
   `data-od-id='KpiCard-value-label'` needs `pt-24` changed to `pt-32`."
5. Agent applies the edit, saves the file, Vite HMR reloads
6. Round-trip time: ~5-10 seconds (agent round-trip) vs ~0 seconds for prop
   changes (instant via URL params)
7. Visual feedback: the tweak is already visible in the preview because the
   palette injects CSS overrides before the source change

This is the killer feature: tweak visually → agent writes code → HMR verifies.

#### 6.3 Component status tracking

Extend `artifact.json` (or a new `component-status.json`) to track the
relationship between OD artifacts and production components:

```jsonc
// .od/component-status.json
{
  "mappings": [
    {
      "component": "src/components/metrics/KpiCard.tsx",
      "artifact": ".od/artifacts/dashboard-v1/index.html",
      "status": "linked",      // "prototype-only" | "linked" | "translated"
      "hash": "abc123def",     // SHA of prototype at translation time
      "translatedAt": "2026-06-04T...",
      "lastSyncHash": "abc123def" // SHA of source at last sync
    }
  ]
}
```

OD can then show status in the artifact tree:
- 🟡 **Prototype only** — no linked component yet
- 🟢 **In sync** — component matches prototype
- 🔴 **Out of sync** — prototype changed since last translation

And commands:
```bash
od component status      # list all linked pairs and sync state
od component sync KpiCard # re-translate this component from prototype
```

#### 6.4 Discovery from the dev server

A quality-of-life addition: when the dev server is running, OD can optionally
discover components by reading the dev server's module graph rather than
walking the filesystem. Vite exposes `__vite__module_graph__` in dev mode.
This is more accurate than file walking because it knows which files are
actually modules (not type-only imports, not dead code) and can resolve
aliases.

This replaces the regex-based file walker from Layer 3 with proper module
graph resolution. Defer to Layer 6 because it depends on the Vite plugin being
loaded.

**Files changed:**
- Modify: `plugins/community/react-component-dev/SKILL.md` (update workflow to
  reference dev server)
- New: `apps/daemon/src/dev-server/tweak-writeback.ts` (tweak-to-source
  translation)
- New: `apps/daemon/src/component-status.ts` (prototype ↔ component tracking)
- Modify: `apps/daemon/src/cli.ts` (add `component status` and `component
  sync` commands)
- Modify: `apps/web/src/components/FileViewer.tsx` (tweak-commit → writeback
  flow)
- Modify: `apps/web/src/runtime/srcdoc.ts` (tweak-commit postMessage contract)

**Effort:** ~400 lines plugin update, ~500 lines daemon (writeback + status),
~400 lines web UI, ~300 lines CLI, ~300 lines tests. ~3 days.

---

## Dependency Graph

```
Layer 1 (Dev server)
  └─► Layer 2 (Proxy) — needs dev server URL to proxy to
       └─► Layer 3 (Components) — needs proxy to serve preview pages
            └─► Layer 4 (Bridges) — needs proxy injection point
                 └─► Layer 5 (Props) — needs bridges for controls to
                      communicate with the iframe
                      └─► Layer 6 (Pipeline) — needs everything above
```

Layers 1–2 are independent of 2–3 in terms of implementation (you can build
the component registry without the proxy), but the proxy is required for the
component preview to work in the iframe.

Layers 4–6 should not start until Layer 3 ships and proves the preview
pipeline works for a real project.

---

## What this plan DOES NOT do

- **No Figma-like canvas.** OD's preview is read-only; you can't drag elements
  or resize with the mouse. Prop sliders and tweaks palette are the interaction
  surface.
- **No replacement for Storybook or Vitest.** OD consumes Storybook stories
  and test files but doesn't run them. Your existing toolchain stays the source
  of truth for component catalog and testing.
- **No automatic generation of full pages.** The agent won't wire components
  into your router or modify page files without explicit instruction. The
  plugin's guardrails prevent this.
- **No build-time code generation.** Everything is dev-mode only. OD doesn't
  modify your production build config or add dependencies you don't ask for.
- **No Docker or CI integration.** Dev servers run locally. CI runners don't
  have browsers for visual verification.
- **No support for non-Tailwind projects in Layer 4+.** Tailwind class mapping
  is essential for tweaks-to-source. CSS Modules, styled-components, and
  vanilla CSS can still use Layers 1–3 (dev server + component picker) but
  won't get tweak writeback or prop-to-class mapping without additional work.

---

## Total effort estimate

| Layer | Daemon | Web UI | Plugins/Packages | Contracts | Tests | Total |
|-------|--------|--------|-----------------|-----------|-------|-------|
| 1. Dev server | 600 | 0 | 0 | 100 | 200 | ~2 days |
| 2. Proxy | 800 | 300 | 0 | 0 | 200 | ~3 days |
| 3. Components | 500 | 600 | 0 | 0 | 300 | ~3 days |
| 4. Bridges | 400 | 200 | 2,900 | 0 | 500 | ~5 days |
| 5. Props | 1,000 | 700 | 0 | 300 | 400 | ~4 days |
| 6. Pipeline | 900 | 400 | 0 | 0 | 300 | ~3 days |
| **Total** | **4,200** | **2,200** | **2,900** | **400** | **1,900** | **~20 days** |

Plus integration testing, cross-layer bug fixes, and the Vite/Next plugin
polish: add ~5 days. **~25 working days for a single developer.**

---

## Milestone plan (implementation order)

### Milestone 1: Dev server hello world (Layers 1–2, partial)
**Goal:** dev server starts, proxy works, iframe shows a real React app.
- Dev server discovery + process management (full Layer 1)
- Proxy with passthrough, no bridge injection yet (partial Layer 2)
- iframe loads from proxy, shows the real app

### Milestone 2: Component picker (Layers 2–3)
**Goal:** pick a component, see it in isolation.
- Bridge injection for data-od-id (partial Layer 4, just selection bridge)
- Auto-generated preview page for single-component rendering
- Component picker shows component tree
- Click component → iframe loads the preview page

### Milestone 3: Bridges (Layer 4, full)
**Goal:** comment mode, inspect, and tweaks work on real components.
- Vite plugin for data-od-id persistence
- Full bridge injection in the proxy
- Comment mode on dev-server components
- Inspect mode on dev-server components
- Tweaks palette shows but doesn't write back yet

### Milestone 4: Prop controls (Layer 5)
**Goal:** live prop sliders, instant feedback.
- Prop extraction from Storybook stories (fast path) + TypeScript AST (robust
  path)
- Prop controls UI (sliders, toggles, selects)
- URL-param-based prop communication to preview iframe
- Prop presets

### Milestone 5: Writeback (Layer 6)
**Goal:** close the loop. Tweak → source edit → HMR → verified.
- Tweaks-to-Tailwind class translation
- Tweaks-to-source agent prompt construction
- Component status tracking (prototype ↔ source linkage)
- Plugin pipeline update for visual verification
- CLI commands: `od component status`, `od component sync`