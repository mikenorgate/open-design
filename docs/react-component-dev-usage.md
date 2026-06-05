# React component development in Open Design

Use this workflow when an Open Design project is linked to a real React app and you want the agent to edit production components with visual context from the running app.

The current workflow is built around folder-linked projects, the workspace dev-server control, a pinned App Preview tab, and React-aware comment context. Storybook is used when it is configured; the full app server is also started so app routes and components without stories can be previewed.

## Who this is for

This guide is for engineers and contributors working on Open Design or using a local source checkout. After reading it, you should be able to link a React app, start its preview server, comment or draw on the running UI, and understand what context the agent receives.

## Link a React project folder

Start Open Design with the normal source workflow:

```bash
corepack pnpm tools-dev
```

Open the web URL printed by the tools-dev status command. The ports are assigned by the dev lifecycle tool, so do not assume a fixed web or daemon port.

In the workspace header, use the working-directory pill to link or replace the project folder. Pick the React project root: the directory with the app's package manifest and framework config.

The dev-server workflow currently detects these preview hosts:

- Storybook
- Vite
- Next.js
- Remix
- Astro

Storybook is preferred when configured because it gives isolated component states. When Storybook is selected, Open Design also tries to start the app dev server as an auxiliary preview host.

## Start the dev server

Use the **Dev server** control in the workspace header.

- **Start** discovers the preview host, allocates a free port, and launches the command.
- **Open preview** opens the proxied preview in a new tab.
- **Stop** terminates the preview server and its child process group.

You can also use the CLI:

```bash
od project dev-server <project-id> start
od project dev-server <project-id> status --json
od project dev-server <project-id> restart --port 5173
od project dev-server <project-id> stop
```

The `--port` flag is optional. If omitted, Open Design picks a free port in its local dev-server range.

## Use the App Preview tab

When the dev server is running, the workspace automatically opens an **App Preview** tab. The tab stays open and is not closable while the dev server is running. Stop the dev server if you want to remove the tab.

The App Preview tab loads the running app through the daemon proxy. This matters because the proxy can:

- inject the preview bridge used by Inspect, Comment, and Draw;
- keep root-relative app requests under the app dev server so Vite or Next proxy rules still apply;
- proxy WebSocket upgrades for HMR;
- capture React page context for the agent.

If the project has Storybook, production React source files prefer the matching Storybook story when one can be found. The App Preview tab remains available for full-app routes and components without stories.

## Visual editing controls

The App Preview tab and production React source preview expose the same visual controls:

- **Inspect** selects an element in the running app and shows live style controls.
- **Comment** selects an element and sends a React-aware comment to chat.
- **Draw** marks the visible app preview and sends the marked region as a visual annotation.
- **Reload** refreshes the proxied iframe.

Inspect style changes are live preview changes only. They are not yet persisted back into TSX, CSS, or Tailwind classes. Use a comment or chat prompt to ask the agent to make the corresponding source change.

## What context the agent receives

When App Preview is active, normal chat sends include hidden page context:

- current app route;
- document title;
- detected React component names;
- likely source file candidates when a component name matches project files.

When you use Comment or Draw, the agent also receives target-specific context:

- selected element id and selector;
- text and DOM hint;
- element bounds;
- computed style snapshot;
- React page context for the active route.

Queued chat sends snapshot the App Preview context at the time the user sends the message. If the user changes routes before the queued message runs, the agent still receives the context for the page where the request was made.

Component owner stacks are best-effort. Some React builds expose fiber owner data; others only expose page-level component summaries. The agent should treat the route, selected DOM target, and candidate source files as the reliable context.

## Component discovery and props

The daemon exposes filesystem-based component and prop metadata endpoints:

```bash
GET /api/projects/<project-id>/dev-server/components
GET /api/projects/<project-id>/dev-server/components/<component-name>/props
```

Prop extraction is heuristic. It checks Storybook args first, then common TypeScript prop declarations, then simple destructured function parameters.

There is no mounted Component Picker or Prop Controls panel yet. Those remain future UI work.

## Component sync tracking

When an Open Design prototype is translated into a React component, link the two so divergence can be detected later.

```bash
od component-sync link <project-id> \
  --component src/components/metrics/KpiCard.tsx \
  --artifact .od/artifacts/dashboard-v1

od component-sync status <project-id>
```

Mark a component as synced after applying updates:

```bash
od component-sync mark-synced <project-id> \
  --component src/components/metrics/KpiCard.tsx
```

Remove a mapping:

```bash
od component-sync unlink <project-id> \
  --component src/components/ui/StatusChip.tsx
```

Component sync paths must stay project-relative. Open Design rejects paths that escape the linked folder.

## React component development plugin

The `react-component-dev` plugin guides the agent through production React work. It is generic and discovers project conventions instead of targeting a specific app.

Use it for these variants:

- `new-component` — create a new React component.
- `modify-existing` — edit one named file.
- `replicate-prototype` — translate an Open Design prototype into production React.

The plugin asks the agent to audit the project first, plan the changed files, generate code using project conventions, and critique the result before finishing.

## Current limitations

- Live Inspect style controls do not persist source edits yet.
- The Component Picker and Prop Controls panels are not mounted.
- Story mapping uses sibling story files and simple Storybook title parsing; it does not yet read the full Storybook index.
- React owner-stack detection depends on what the running React build exposes.
- App Preview runs trusted local project JavaScript through the Open Design proxy. Treat linked project folders as trusted local code.

## Troubleshooting

### The Dev server control says the project is not folder-linked

Link the project to a local React folder with the working-directory pill. The dev-server workflow needs a project root on disk.

### No dev server was detected

Check that the linked folder is the project root, not a nested source directory. The root should contain the framework config or Storybook config.

### The app returns 502 for `/api` requests

Open Design routes root-relative app requests through the app dev-server proxy. If Vite or Next proxies `/api` to another backend, a 502 usually means that backend is not running or the proxy target is wrong.

### App Preview shows a route-level 404

The App Preview iframe normalizes the initial browser path to `/`, then the app router can redirect or navigate normally. If the app still shows 404, check the app's router defaults and required backend state.

### Comments do not send

Comment mode uses the board-comment path, not screenshot upload. If a send fails, check whether the current conversation is busy or whether chat sending is disabled by an active run.
