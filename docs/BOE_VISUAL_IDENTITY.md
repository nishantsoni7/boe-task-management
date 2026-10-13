# BOE visual identity (2026-10 rebrand)

One identity for every module. This file is the reference for anyone adding or
changing a screen. The values live in **one place** — the `:root` block at the top
of `src/app/globals.css` — and are mirrored for inline styles in
`src/lib/tokens.ts`.

Appearance is defined here; behaviour, permissions, routes and calculations are
defined by the code and the module docs. Nothing in the rebrand changed the latter.

## What colour means

| Colour | Token | Used for |
| --- | --- | --- |
| Terracotta `#B9472E` (hover `#9E3B25`) | `--boe-brand` | Actions and selection: primary buttons, the selected nav item, focus rings, unread markers, links (ink `#963B27`). |
| Charcoal `#303536` | `--boe-text` | Body and heading text. Secondary text `#4C5352` / `#686D6C`. |
| Warm canvas `#F7F5F1` / white `#FFFFFF` | `--boe-canvas` / `--boe-surface` | The page, and every content surface on it. |
| Borders `#E4DED7` · `#CFC8BF` · `#B9B2A9` | `--boe-border*` | Panels / secondary buttons / form controls (the last clears 3:1). |
| Status pairs | `--boe-<status>-fg/-bg` | Pending `#595D5B/#EEECE8`, Working `#335A86/#EAF0F8`, Waiting `#805B0D/#FAF0DA`, Blocked `#A12438/#FBE9EC`, Completed `#276247/#E8F2EC`. |
| Error / destructive `#B42332` | `--boe-error` | Validation and delete. Never the brand colour. |

Brand colour marks *what you can act on*; status colours keep their meaning. Do
not use one for the other, and do not recolour a status to match the brand.

## Type

* **Manrope** (600–700) for headings: `var(--boe-font-heading)` / `var(--font-display)`.
* **Inter** (400–600) for everything else: `var(--boe-font-body)` / `var(--font-body)`.
* Both are self-hosted variable fonts in `src/app/fonts`, loaded with `next/font/local`
  (`src/app/layout.tsx`) — nothing is fetched at build time. The latin-ext files carry
  the rupee sign and are declared in `globals.css` with a `unicode-range`, so they only
  download when a page needs the glyph.
* Page headings 24px (22px on a phone); section headings 16–18px; body and table text
  14px; labels and metadata 12–13px. Nothing is smaller than 12px. Editable controls are
  16px on a phone. Tables, amounts and numeric inputs use tabular numerals.

## Geometry

Controls 8px, panels and dialogs 12px, status badges 6px. Spacing 4/8/12/16/24/32.
Desktop controls are 36–40px tall; touch targets 44px. Thin borders and a hairline
shadow; stronger elevation only for floating menus, popovers and dialogs
(`--boe-shadow-float`, `--boe-shadow-dialog`).

## Shared classes (prefer these over inline styles)

`.boe-btn` + `-primary` / `-secondary` (`-ghost`) / `-text` / `-danger` / `-danger-solid`,
`.boe-input`, `.boe-input-label`, `.boe-req` (red asterisk), `.boe-field-error`,
`.boe-badge-<status>`, `.boe-panel`, `.boe-table`, `.boe-callout-<tone>`, `.boe-empty`,
`.boe-modal-*`, `.boe-nav-item`.

Focus is global: every interactive element gets a 2px terracotta outline
(`:focus-visible`, `!important` so it also wins against inline `outline: none`). Table
headings are sentence case for the same reason (width, and legibility).

## What the rebrand deliberately did not touch

Generated documents and print layouts keep their own colours: the PI / confirmed-order
PDFs (`src/lib/orders/*`), the quotation PDF, QR export and the printable approval slip
and asset hand-over sheet. Excel exports are unchanged. There is no dark mode and none
was added.

## Logo

`public/branding/boe-logo-full.png` is the supplied lockup, trimmed and with its white
field made transparent; `boe-icon.png` is the symbol alone (sidebar, favicon, PWA icons).
Neither recolours the logo.
