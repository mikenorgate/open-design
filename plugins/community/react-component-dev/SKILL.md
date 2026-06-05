---
name: react-component-dev
description: |
  Develop production-ready React functional components with TypeScript,
  Tailwind CSS, and shadcn/ui. Audits the target project's existing
  conventions before writing any code.
triggers:
  - "build react component"
  - "create component"
  - "react component"
  - "make a component"
  - "implement this as react"
od:
  mode: prototype
  craft:
    requires: [typography, color, anti-ai-slop]
---

# React Component Development

## What this skill does

Produces a React functional component that fits the target project's
existing patterns — same import style, same component library, same
Tailwind conventions, same test framework. It does NOT impose a
particular style; it discovers what's already there and follows it.

Produces up to three files per component:
- `<ComponentName>.tsx` — the component
- `<ComponentName>.test.tsx` — unit test (when `createTest` is true)
- `<ComponentName>.stories.tsx` — Storybook story (when `createStory` is true)

---

## Phase 0 — Understand the task variant

The plugin supports three task variants. Pick the right one from the
`variant` input.

### variant: new-component
Create a brand-new component from scratch. No existing file to
reference. This is the default.

### variant: modify-existing
The user points at an existing file via `existingPath`. You are
updating it — read it first, understand its current shape, and make
targeted changes. Do NOT rewrite unrelated sections. Do NOT change the
file's export style or prop naming convention to match your preference;
keep whatever is there.

### variant: replicate-prototype
The user has an OD prototype at `prototypePath` (an HTML file).
Read it and translate its visual design into a production React
component. Do NOT copy HTML markup directly — translate layout to
Tailwind classes, interactive elements to React state, and static
content to props.

---

## Phase 1 — Audit the project

Before writing a single line, understand the target. Report findings
in the chat so the user can see what you detected.

### 1.1 Read project-level config

If `components.json` exists at the project root:
- Note `style` (new-york or default) and `baseColor`
- Note whether `cssVariables` is true or false
- Note path aliases (e.g. `@/` maps to `src/`)

### 1.2 Detect the build tooling

Look for EXACTLY ONE of these at the project root. Check in this order:
1. `vite.config.ts` or `vite.config.js` → **Vite**
2. `next.config.ts` or `next.config.mjs` → **Next.js App Router**
3. `remix.config.js` or `remix.config.ts` → **Remix**
4. `astro.config.mjs` → **Astro**

Report which you found. If none match, assume Vite and note the
assumption so the user can correct it.

### 1.3 Detect the component library

Check `package.json` dependencies for EXACTLY ONE of:
- `@radix-ui/*` packages present AND `components.json` exists → **shadcn/ui**
- `@chakra-ui/react` → **Chakra UI**
- `@mantine/core` → **Mantine**
- `@mui/material` → **MUI**
- `@nextui-org/react` → **NextUI**
- `daisyui` → **DaisyUI**

Default: shadcn/ui (most common pairing with Tailwind).

### 1.4 Detect the styling approach

Check in priority order and use the FIRST match:
1. `components.json` with `"cssVariables": true` → **Tailwind v4 with CSS variables**
2. `tailwind.config.ts` or `tailwind.config.js` → **Tailwind v3 with config**
3. `postcss.config.*` with `tailwindcss` plugin → **Tailwind via PostCSS**
4. CSS Modules (`*.module.css` files anywhere in `src/`) → **CSS Modules**
5. A CSS-in-JS dependency (`styled-components`, `@emotion/react`) → **CSS-in-JS**

### 1.5 Read existing components for conventions

Read at least 3 existing component files in the target project (or as
many as exist, if fewer than 3). Start with `src/components/ui/` for
primitive patterns, then sample from domain folders. Extract:

| Convention | How to detect |
|---|---|
| Import style | Scan for `cn`, `clsx`, `classnames`. Copy the exact import path used. |
| Component export style | `export function Foo()` vs `export const Foo = () =>` vs `export default`. Match existing. |
| Props declaration | `interface FooProps` vs `type FooProps` vs inline destructuring. Match existing. |
| "use client" usage | Do existing components with hooks/state start with `"use client"`? Match the boundary. |
| Event handler naming | `onClick` props vs `handleClick` internal handlers. Match existing. |
| Subcomponent pattern | `Foo.Header` / `Foo.Content` vs separate files vs flat composition. Match existing. |
| File naming | `PascalCase.tsx` vs `kebab-case.tsx` vs `camelCase.tsx`. Match existing. |
| Re-export pattern | Do components re-export from an `index.ts` barrel? Match existing. |

### 1.6 Read the Tailwind configuration

For Tailwind v3: read `tailwind.config.*`. For Tailwind v4: read
`src/index.css` (or the CSS file referenced in `components.json`).
Extract:
- Custom colors beyond the default palette (look for theme extensions
  or `@theme` blocks)
- Custom spacing/sizing scale
- Custom border-radius tokens
- Custom font families
- Any plugin-added utilities (`@tailwindcss/typography`,
  `@tailwindcss/forms`, `tailwindcss-animate`, etc.)

### 1.7 Detect the test framework

Check `package.json` devDependencies:
- `vitest` → **Vitest**
- `jest` or `ts-jest` → **Jest**
- `@testing-library/react` is always expected alongside either

Report which you found. If neither, mention that test generation will
use Vitest conventions and the user should verify compatibility.

### 1.8 Detect Storybook

Look for:
- `.storybook/` directory at the project root
- `@storybook/*` in devDependencies

If absent, skip story generation even when `createStory` is true —
mention why in your report.

---

## Phase 2 — Plan (present to user)

Before writing code, output a plan block in the chat:

```
== Plan for <ComponentName> ==

Build tooling:    <detected>
Component lib:    <detected>
Styling:          <detected>
Test framework:   <detected>
Storybook:        <detected or not found>

Conventions (from existing components):
  Export style:    <detected>
  Props pattern:   <detected>
  Import style:    <detected>
  File naming:     <detected>
  Event handlers:  <detected>

Files I will create:
  <targetPath>/<ComponentName>.tsx        (~<estimate> lines)
  <targetPath>/<ComponentName>.test.tsx    (~<estimate> lines)
  <targetPath>/<ComponentName>.stories.tsx (~<estimate> lines)

Files I will not touch: everything else.

Proceed?
```

Wait for the user to confirm before writing files. If the run context
already implies approval (e.g. the user said "just do it" or the
inputs form was pre-filled with all required fields), skip the
confirmation and proceed.

---

## Phase 3 — Generate

### 3.1 Component file (`<ComponentName>.tsx`)

Rules:

- **Client directive.** Add `"use client"` at the top of the file if
  the component uses hooks, state, effects, event handlers, or browser
  APIs. If it's a pure presentational component (only props → JSX),
  omit the directive.

- **Props interface.** Declared at the top of the file, named
  `<ComponentName>Props`. Every prop must have a JSDoc comment
  (`/** Description. */`). Use the project's detected pattern
  (interface vs type).

- **Controlled by default.** Accept `value` + `onChange` rather than
  managing internal state, unless the component is inherently
  uncontrolled (e.g. a toggle that owns its pressed state).

- **cn() for class merging.** Use `cn()` from the project's detected
  utility for all conditional className values. Do NOT concatenate
  strings or use template literals for className. Example:
  ```tsx
  className={cn("base-class", variant === "outline" && "border", className)}
  ```

- **Semantic tokens, not hex values.** If the project uses CSS
  variables for colors (shadcn/ui CSS variables mode), use Tailwind
  classes that map to those variables: `bg-primary`, `text-foreground`,
  `border-border`, `bg-muted`, etc. Do NOT use `bg-blue-500` unless
  the project's design system explicitly uses blue-500 as a token.

- **Accent restraint.** Accent colors (primary, brand) appear at most 2
  times per component surface. The rest is neutral tokens (background,
  foreground, muted, border).

- **Interactive elements.** Every clickable/interactive element must
  have: `hover:` state, `focus-visible:` ring/outline, `aria-label` or
  visible text, and either be a `<button>` or have explicit
  `role` + `tabIndex` + `onKeyDown`.

- **No inline styles.** No `style={{}}`. Everything is Tailwind
  classes. If you absolutely need a dynamic value (e.g. progress bar
  width), use a CSS custom property via `style={{"--progress":
  `${value}%`}}` and reference it in Tailwind with the project's
  arbitrary value or CSS variable pattern.

- **Named export.** Export is a named function, never a default export
  unless the project conventions explicitly use default exports
  everywhere (detected in Phase 1.5).

- **Zero-props rendering.** The component renders something visible
  even with zero props. Every optional prop has a sensible default.

- **TypeScript satisfaction.** Props types are strict. No `any`. Use
  `React.ComponentProps<"div">` or similar for HTML element props
  spread onto a native element.

### 3.2 Test file (`<ComponentName>.test.tsx`)

Rules:

- Import from `@testing-library/react` (`render`, `screen`) plus the
  detected test framework (`describe`/`it`/`expect` from vitest or
  jest).

- Minimum test cases:
  1. **Smoke test:** Renders without crashing with default props.
     Assert at least one visible element exists.
  2. **Props test:** Renders with explicit props. Assert those props
     are reflected in the output (text content, attribute values,
     etc.).
  3. **Interaction test** (for interactive components): Simulate a
     click/change and assert the event handler fired.
  4. **Variant test** (for components with variants): Render each
     variant and assert the correct style class or visual
     differentiator is applied.

- **Query preference.** Use `screen.getByRole` > `getByText` >
  `getByLabelText` > `getByTestId`. Never use `querySelector` or
  `container.querySelector`.

- **User event preference.** If the project's existing tests use
  `@testing-library/user-event`, use that (`await
  user.click(...)`). Otherwise fall back to `fireEvent` from
  `@testing-library/react`.

- **Match project patterns.** If existing tests use a custom `render`
  wrapper (e.g. wrapping in providers), use that same wrapper. Read
  at least one existing test file to confirm the pattern.

### 3.3 Storybook story (`<ComponentName>.stories.tsx`)

Rules:

- Default export:
  ```tsx
  import type { Meta, StoryObj } from "@storybook/react";

  const meta = {
    component: ComponentName,
    title: "<domain>/<ComponentName>",
    // argTypes for any prop that benefits from controls
  } satisfies Meta<typeof ComponentName>;

  export default meta;
  type Story = StoryObj<typeof meta>;
  ```

- Minimum stories:
  1. **Default:** No args. The component at rest.
  2. **One story per meaningful variant/prop combination.** If the
     component has a `variant` prop, one story per variant.

- Use `args` to pass props. Never hardcode content inside the story
  render function.

- If the component accepts `children`, include a story demonstrating
  composition with nested content.

- Each story is a named export with `satisfies Story`.

- Skip story generation entirely if Storybook was not detected in
  Phase 1.8. Mention the skip in your report.

---

## Phase 4 — Critique (self-review loop)

The pipeline runs this stage repeatedly until the score passes or the
iteration cap is reached.

After writing all files, read them back and score each category 0
(not met) or 1 (fully met):

1. **Import audit.** Every import resolves to a package in
   `package.json` or a project path alias. No phantom imports.
   No unused imports.

2. **Tailwind audit.** Every class exists in the installed Tailwind
   version. No misspelled utilities, no classes from a plugin that
   isn't installed, no classes that require a Tailwind version newer
   than what's detected.

3. **cn() audit.** Every conditional class uses `cn()`. No string
   concatenation, no template literals in className. Static
   single-class strings are acceptable.

4. **Accessibility audit.** Every interactive element is a `<button>`
   or has `role` + `tabIndex` + keyboard handler. Every image/icon
   has `alt` or `aria-hidden`. Form elements have associated labels.

5. **Props audit.** Every prop has a TypeScript type. Optional props
   have defaults. No `any` types. No unused props declared.

6. **Anti-AI-slop audit.**
   - No `#6366f1` / `indigo-500` (the AI default accent).
   - No `bg-gradient-to-r from-purple-500 to-pink-500` (the AI
     default gradient).
   - No `rounded-lg` or `rounded-xl` on every single container
     (default 8–12px radius everywhere is a slop tell).
   - No `shadow-lg` / `shadow-xl` on every card.
   - No `transform hover:scale-105 transition-all` on every
     interactive element.
   - Font weights are deliberate, not `font-bold` on everything.
   - Letter-spacing uses tracking tokens, not raw `letter-spacing`.

Sum the scores (0–6).

- **Score ≥ 4:** Pass. Proceed to Phase 5.
- **Score < 4:** Fix the failing categories. Increment the iteration
  counter. If this is iteration 3, stop and report remaining issues
  to the user — do not loop indefinitely.

---

## Phase 5 — Report

After generation and critique pass, output a final report:

```
== Generated <ComponentName> ==

Files created:
  <targetPath>/<ComponentName>.tsx
  <targetPath>/<ComponentName>.test.tsx
  <targetPath>/<ComponentName>.stories.tsx    (if applicable)

Critique score: <score>/6
  ✓ Imports     ✓ Tailwind    ✓ cn() usage
  ✓ A11y        ✓ Props       ✓ Anti-slop     (or point out failures)

Detected conventions:
  Build tooling:    <detected>
  Component lib:    <detected>
  Styling:          <detected>
  Export style:     <detected>
  Props pattern:    <detected>

To verify:
  <dev command>              # see it live
  <test command>             # run the tests
  <storybook command>        # inspect in isolation

Import it with:
  import { <ComponentName> } from "<resolved import path>"
```

---

## Guardrails (things this skill WILL NOT DO)

1. **Never modify existing files** unless `variant` is `modify-existing`
   and the user explicitly named a single file via `existingPath`. Even
   then, only edit the named file — never edit package.json, config
   files, router files, barrel exports, or anything outside the named
   file.

2. **Never run `npm install`, `pnpm install`, `yarn add`, or `bun
   add`.** Do not modify dependencies. If the component requires a
   package that isn't installed, mention it in the report and let the
   user decide.

3. **Never delete files.** Only create new files or surgically edit the
   one file named in `existingPath`.

4. **Never regenerate a component that already passes critique** unless
   the user asked for a specific change.

5. **Never guess a convention.** If the audit in Phase 1 can't
   determine something (e.g., no existing components to read, no
   package.json, no Tailwind config), ask the user instead of assuming.

6. **Never use a component library that isn't installed.** If the
   project has no component library, write plain HTML elements styled
   with Tailwind or the detected styling approach.

7. **Never import from `@/components/ui/...` without verifying the ui
   primitives exist.** Read the file first. If a primitive doesn't
   exist, don't import it — build the element from scratch.

8. **Never add `"use client"` to a pure presentational component** that
   only renders JSX from props with no hooks, state, effects, or event
   handlers.

---

## Edge cases

- **Empty project (no existing components).** Skip Phase 1.5
  convention detection. Use sensible defaults: named function exports,
  `interface Props`, `cn` from a standard path. State in the report
  that conventions were assumed.

- **No component library detected.** Build from raw HTML elements
  styled with Tailwind. Do not import from a library you assume exists.

- **No Tailwind detected.** If the project uses CSS Modules or
  CSS-in-JS, adapt the component to use that approach instead of
  Tailwind classes.

- **No test framework detected.** Skip test generation. Report that
  tests were skipped.

- **Component name conflicts with existing file.** If the target path
  already has a file with the same name AND `variant` is
  `new-component`, warn the user before overwriting. If
  `modify-existing` was selected, overwrite is expected; proceed.

- **prototypePath points to a missing file.** If the prototype HTML
  file doesn't exist, error clearly and ask for the correct path.

- **Tailwind class doesn't map cleanly to a component library prop.**
  Favor the component library's prop API over raw Tailwind classes.
  For example, `<Button variant="outline">` is better than `<button
  className="border border-input">` when shadcn/ui is available.

- **Very large existing file in modify-existing.** If the existing
  file is over 500 lines, ask the user which sections to modify rather
  than reading the whole file and making assumptions.
