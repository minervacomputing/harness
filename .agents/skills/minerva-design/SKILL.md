---
name: minerva-design
description: The Minerva design system ("Ledger") and logo. Use when building or changing any frontend UI in this repository, adding a component, choosing colours, type or spacing, using the logo or favicon, or updating the dev components page.
---

# Minerva design system: Ledger

Minerva is a B2B tool that governs what AI agents may do in a person's apps. The interface should feel like a well-kept ledger: simple, exact and slightly technical. It follows the values of usgraphics.com: structure shown with rules rather than decoration, high contrast, and nothing that does not carry information.

The system is built on shadcn-style components in `frontend/src/components/ui/`, Tailwind v4 tokens in `frontend/src/index.css`, and radix-ui primitives. Every component appears on the development page at `/dev/components` (see [The components page](#the-components-page)).

## Principles

1. **Ruled, not boxed in ornament.** Structure comes from 1px rules and borders. Only controls get depth, and only from the depth tokens (see [Depth](#depth)). There are no other shadows, gradients or glows.
2. **Square corners.** Every radius token is 0. Only round things are round: status dots and radio buttons (`rounded-full`).
3. **High contrast.** Every text colour keeps at least 4.5:1 against its surface in both themes. Do not lower opacity on text to make it quieter. Use `text-muted-foreground` or `text-faint` instead.
4. **State is a dot and a word.** Show status with `<Status tone="…">Word</Status>`. Never colour a whole row or card, and **never use a coloured left border (side stripe) as a highlight**, anywhere.
5. **Centred buttons.** Button content is always centred. Do not add pseudo-elements to buttons, and do not left-align button labels (no `justify-start`).
6. **One primary action per view.** Use the default (navy) button once. Everything else is `outline`, `ghost` or `link`.
7. **Mono for machine things.** Use IBM Plex Mono for labels, identifiers, tool names, dates in lists, keyboard keys and numbers in tables.

## Tokens

The light and dark values live in `frontend/src/index.css`. Use colours only by token name (for example `bg-card`, `text-muted-foreground`, `border-border-strong`). Never hard-code a hex value or a Tailwind palette colour such as `amber-500` or `red-600` in a component. Tokens switch with the theme.

| Token | Use |
|---|---|
| `background` | Page |
| `card` / `popover` | Raised surfaces, inputs, cards |
| `secondary` / `muted` / `accent` | Hover fills, user messages, code blocks, tags |
| `sidebar` | App sidebar |
| `foreground` | Body text and headings |
| `muted-foreground` | Secondary text, descriptions |
| `faint` | Placeholders, neutral status dot |
| `border` | Hairline rules between rows and sections |
| `border-strong` / `input` | Card and field outlines, table head rule |
| `primary` | Primary button |
| `info` / `ring` | Links, focus rings, checked controls, running state |
| `success` | Done, active |
| `warning` | Needs attention, not allowed |
| `destructive` | Errors, deleting |
| `logo` | The logo (`text-logo`) |

Each colour that fills a surface has a matching `-foreground` token for text on it.

**Tints:** a toned surface uses the tone colour at low opacity over the surface, with a tinted border. For example, the warning alert uses `border-warning/40 bg-warning/8`. The text on it stays `foreground`, and only the icon takes the tone colour.

**Focus:** `focus-visible:ring-[3px] focus-visible:ring-ring/25`, and for fields also `focus-visible:border-ring`.

## Depth

Depth tells the user what they can act on. Raise what you press or slide, set in what holds a value, and float what sits above the page. Everything else (cards, tables, alerts, badges, status, tabs, ghost buttons, links, nav) stays flat.

The values are CSS variables in `index.css`, with separate dark values. Apply them with `shadow-(--name)`, which composes with focus rings. Never write a raw `shadow-*` utility or a shadow value in a component.

| Variable | Use |
|---|---|
| `--raise-solid` and `--sheen` | Filled buttons (primary, destructive): lit top edge, shaded bottom edge, small soft shadow, and a faint sheen via `bg-(image:--sheen)` |
| `--raise-surface` | Outline and secondary buttons, the selected segmented item, `Kbd` |
| `--press-solid`, `--press-surface` | The `active:` state of raised buttons (drop the sheen with `active:bg-none`) |
| `--raise-knob` | The switch knob |
| `--inset-well` | Inputs, text areas, selects, the composer, unchecked checkboxes and radios |
| `--inset-track` | Switch and segmented tracks |
| `--raise-float` | Menus, popovers and dialogs |

Disabled buttons drop their shadow, and a checked checkbox is flat.

## Theme

- Light and dark are both first-class. The `.dark` class on `<html>` switches the tokens, and a `.light` class resets them inside a dark page (the components page uses this to show both themes side by side).
- The `dark:` variant exists but should rarely be needed, because tokens already switch.
- The choice is stored in `localStorage` under `minerva-theme` (`light`, `dark`, or absent for system). `index.html` applies it before first paint, and `src/lib/theme.ts` (`useTheme`, `setTheme`) keeps it in step. Change both together.
- `ThemeToggle` (`src/components/theme-toggle.tsx`) sits on the Account page under Appearance (`labelled` adds the words to the icons).

## Typography

- **Interface:** IBM Plex Sans (`font-sans`), from `@fontsource/ibm-plex-sans` at weights 400, 500, 600 and 700.
- **Mono:** IBM Plex Mono (`font-mono`), at weights 400 and 500.
- The body is 14px with tabular numbers.

| Role | Classes |
|---|---|
| Page heading | `text-2xl font-medium tracking-[-0.015em]` (in `PageHeader`) |
| Section heading | `text-xl font-medium tracking-[-0.015em]` |
| Card title | `font-semibold leading-tight` (in `CardTitle`) |
| Body | default (14px) |
| Small and secondary | `text-[13px] text-muted-foreground` |
| Label | `label` utility: mono, 11px, weight 500, 0.1em tracking, uppercase, muted |
| Identifier, tool name, date in a list | `font-mono text-[11px]` to `text-[13px]` |

Headings use weight 500 with slight negative tracking, not bold. Agent replies use `prose prose-sm prose-minerva`, which colours the typography plugin from the tokens.

## Components

All components are in `frontend/src/components/ui/` unless noted otherwise.

| Component | File | Notes |
|---|---|---|
| `Button` | `button.tsx` | Variants `default`, `outline`, `secondary`, `ghost`, `destructive`, `ghost-destructive`, `link`. Sizes `default` (34px), `sm` (28px), `lg` (40px), `icon`, `icon-sm`. Content is centred, and the gap is 7px. Filled, outline and secondary variants are raised and press in when clicked. |
| `Card` and parts | `card.tsx` | `border-border-strong bg-card`, square corners |
| `Input`, `Textarea`, `Select`, `Label` | `input.tsx` | `Select` is a native `<select>` styled as an input with a chevron. Use it instead of a bare `<select>`. |
| `Checkbox` | `misc.tsx` | 16px square; checked fills with `info` |
| `Switch` | `misc.tsx` | 36×20, square, raised white knob in an inset track; on fills with `info` |
| `RadioGroup`, `RadioItem` | `misc.tsx` | Round, by convention |
| `Status` | `misc.tsx` | Dot and word; tones `neutral`, `success`, `warning`, `danger`, `info`; `live` pulses the dot |
| `Badge` | `misc.tsx` | A square mono tag for names and counts. Do not use it for state; use `Status`. |
| `Alert`, `Notice`, `ErrorNote` | `misc.tsx` | Tinted box with a tone-coloured icon. `Notice` is info, and `ErrorNote` is danger and renders nothing when empty. |
| `PageHeader` | `misc.tsx` | Title, description and actions, ruled underneath |
| `Kbd`, `Progress`, `Spinner` | `misc.tsx` | `Progress` is 6px and fills with `info` |
| `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | `tabs.tsx` | Mono uppercase 12px; the active tab has a 2px foreground underline |
| `Segmented`, `SegmentedItem` | `tabs.tsx` | Compact switch between two to four views; the selected item is raised in an inset track |
| `Table` and parts | `table.tsx` | Head cells are weight 600 on a `border-strong` rule; rows have hairlines and no zebra stripes. Right-align numbers and set them in mono. |
| `TextField`, `TextAreaField`, `SubmitButton` | `components/form.tsx` | Fields for a TanStack form: label, input and the field or server error under it. `SubmitButton` is disabled while the form submits; pair it with `<form onSubmit={submitForm(form)}>`. |
| `Logo`, `LogoMark` | `components/brand/logo.tsx` | See [Logo](#logo) |
| `ToolCall` | `components/chat/thread.tsx` | Tool card: wrench icon in the tone colour, name in mono, `Status` on the right. No side stripe. |

**Layout patterns:**

- The sidebar uses `bg-sidebar`, 256px wide: logo and workspace, the nav (New chat, Agents, Connections), the conversations grouped by recency, and a footer with the account link and sign out. Nav links are `px-2 py-[7px] text-[13px]`, muted, and turn `bg-secondary text-foreground` on hover and when active. A count of connections that need the user sits on Connections as a `Status`.
- Below `md` (768px) the sidebar is a drawer (radix `Dialog`) opened from a top bar with the menu, the logo and New chat.
- The user message in chat is `border bg-secondary`. The composer is `border-border-strong bg-card`.
- Pages use `PageHeader` (which also names the browser tab, through `useDocumentTitle` in `src/lib/title.ts`), then content padded with `px-4 md:px-8`.
- Lists of things (connections, agents, settings) are ruled rows in one `border-border-strong bg-card` box with hairlines between rows: name and a muted line of detail on the left, status and actions on the right. Editing opens below the row, inside the box.
- `AppIcon` (`components/connections/app-icon.tsx`) marks an app wherever one is named. Sizes `xs` (20px, inline in headers and rows), `sm` (28px) and `md` (36px).

When you need a new primitive, add it to `components/ui/` following these rules, then add it to the components page.

## Logo

The logo is a barn owl sitting on a branch, its back half turned to us and its head looking back over its shoulder. It is one navy shape with no background: the face, the eyes and the gaps between the wing feathers are cut out. The same owl is used at every size. The wordmark is MINERVA in Archivo Expanded ExtraBold (Archivo at width 125, weight 800, tracked +0.03em), converted to outlines, to the right of the owl.

There is no reversed tile or coloured icon background. On dark surfaces, the logo simply takes the light `logo` token.

**In the app:** `<Logo height={24} />` renders the lockup (`height` is the owl's height), and `<LogoMark size={32} />` renders the owl centred in a square. Both use `currentColor` with `text-logo` by default. Never inline other copies of the paths.

**Files:**

- `frontend/src/components/brand/logo-paths.ts` holds the paths. It is generated; do not edit it.
- `frontend/public/favicon.svg`, `favicon.ico` and `apple-touch-icon.png` are the favicons.
- `../branding/` (outside the repo, in the parent `minerva` folder) holds every exported file: SVG logos in navy, black and white, icons, PNGs, the Archivo font and a README with usage rules.

**Regenerating.** The owl was drawn by an image model; the drawing is `../branding/source/owl.png`. Run from the repo root:

```sh
uv run --with potracer --with numpy python design/logo/trace.py ../branding/source/owl.png
uv run --with fonttools --with skia-pathops --with uharfbuzz python design/logo/build.py "../branding/fonts/Archivo[wdth,wght].ttf"
python3 design/logo/export.py ../branding
```

`trace.py` traces the drawing into `design/logo/owl.svg`; only rerun it when the drawing changes. `build.py` scales the owl, sets the name beside it and flattens both into `design/logo/geometry.json`. `export.py` writes `../branding/`, `logo-paths.ts`, the favicons in `frontend/public/`, and the landing page's logo and favicons in `../landing-page/`.

## The components page

`frontend/src/routes/dev.components.tsx` serves `/dev/components` while running `pnpm dev` or `make dev`. Production builds return "not found" for it (`import.meta.env.DEV`). It shows every primitive in the current theme, or light and dark side by side.

**Keep it up to date:** when you add or change a component, variant or token, add or update its example on this page in the same change. Then open the page in both themes and check it.

## Don'ts

- No coloured left borders or side stripes for emphasis.
- No `rounded-*` classes other than `rounded-full` for dots and radios.
- No shadows, gradients or glows outside the [depth](#depth) tokens, and no depth on things that cannot be clicked.
- No hard-coded colours (`#hex`, `amber-*`, `red-*`, `slate-*`) in components.
- No dither or texture behind text.
- No `justify-start` or pseudo-elements on buttons.
- No `Badge` for state.
- Do not lower the contrast of text below 4.5:1.

## Checks

```sh
cd frontend && pnpm typecheck
```

Then view `/dev/components` and the changed screens in both light and dark mode.
