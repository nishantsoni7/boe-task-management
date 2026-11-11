# 29. Quotations (phase 1: build, price, print, share)

Written 2026-11-12 from the build, branch `feat/quotations-module`. Migration `20270614000000_quotations_module.sql`. Planned with the owner the same night: the full plan and 15 page mockups are the private artifact https://claude.ai/artifact/5QhasugGXW2ZaJsCnmLBjG (local copy `~/BOE-Development/temporary/quotation-module/`). The owner delegated every open decision ("consider everything pre approved"); the defaults taken are in section 6.

## 1. Purpose & users

- Replaces the separate Base44 quotation maker (boequotation.base44.app) for building and sending quotations, inside BOE One. It is the first phase of a larger plan: import of client files, an image studio, a pricing desk, confirm → PI draft, reports, and the Pricing module that learns from every quotation.
- Users: salespeople (mostly phones), managers and the pricing desk (see everyone's), the owner. Clients see only the link.
- BOE sells hospitality furniture in bulk: a quotation is built by **room type × rooms** ("Boho room × 56 rooms"), not as a flat list.

## 2. Status

- Built 2026-11-12 (phase 1). Checked by: the in-memory Postgres suite `supabase/tests/quotations_pglite.mjs` (20 checks), `src/lib/quotations/math.test.ts` (11, including the real Resort Shamshabad quote to the rupee), `quotations.test.tsx` (12), `tsc`, eslint, the full `npm test`, `next build`. **Not seen signed in**: no browser session can sign in from here.
- Before 20270614000000 is applied, the tile shows for Admin only (as every new module) and every page says "Quotations is being set up". Merging before applying is safe.

## 3. The model

- **Quotation** (`quotations`): number `QT-<initials>-<5 digits>` from 01001 (Base44 numbers reached QT-NS-00005, QT-AK-00019, QT-SS-00047, so they never repeat); client, project, contact (name, phone, role), client type, delivery state, GST mode, discount %, fabric and packing amounts (₹), transport note, validity days (7), client notes, internal notes; owner; status.
- **Room types** (`quotation_areas`): name, style, multiplier (rooms), unit label.
- **Lines** (`quotation_lines`): name, size as the client writes it (feet and inches or inches; shown in inches too), specification, material, finish, quantity **per room** (× the room type's multiplier) **or fixed**, unit price (₹, before GST), GST rate (0/5/12/18/28), picture, optional (shown, not counted), note for the client, internal note.
- **History** (`quotation_events`): created, saved (lines, value), status (from, to, note), shared, unshared, opened by the client. Append-only by trigger.
- **Totals are never stored.** `src/lib/quotations/math.ts` computes them for every screen; the list's "before GST" value is `quotation_value_before_gst` in SQL with the same rounding (line = round(qty × price); discount = round(subtotal × % / 100)). GST by rate group; fabric and packing are taxed at 18%; IGST or CGST + SGST (half each, rounded).
- **Statuses**: Draft → Sent → Negotiating → Confirmed / Lost / Archived. Creating the client link turns a Draft into Sent. Confirmed, Lost and Archived are locked; Reopen sets Negotiating; reopening a Confirmed one is Admin only. Lost needs a reason.

## 4. Pages and routes

| Route | Screen | Who |
|---|---|---|
| `/quotations` | `ListScreen`: my / everyone's (view_all), status filter (Open = draft, sent, negotiating), search, New quotation dialog (`?new=1`) | view |
| `/quotations/[id]` | `BuilderScreen`: client and project, room types × rooms, products (picture, size → inches, material, finish, specification, quantity per room or in total, price, GST rate, optional, notes, move, duplicate, remove with Undo), adjustments and notes; summary, client link + WhatsApp, status, history. Save is explicit (button or Ctrl+S) and refuses a stale copy | view (edit per section 5) |
| `/quotations/[id]/print` | `PrintScreen`: the quotation as the client gets it, Print or save as PDF | view |
| `/q/[token]` | `PublicScreen`: the client link. No login, `noindex` | anyone with the link |

Shell `src/components/layout/QuotationsLayout.tsx` (InventoryLayout's build). Layout `src/app/quotations/layout.tsx`: session gate, then `ModuleGuard` (`deniedRoute="/modules"`). Launcher tile in `src/app/modules/page.tsx`; icon `FileText`.

## 5. Database (`20270614000000_quotations_module.sql`)

- Registration: `app_modules` (sort 115), `permission_modules`, actions **view, create, edit, view_all** (default off), Admin role rows. Mirrored in `modules.ts`, `ENGINE_GATED_MODULE_KEYS` (18), `MODULE_ENFORCEMENT`, `MODULE_WORDS` (levels viewer and contributor; view_all is an authority).
- The four tables have RLS on, **no policy and no grant** for anon or authenticated: nothing reads or writes them directly. Everything is a SECURITY DEFINER function with `search_path = public, pg_temp`:
  - `quotation_actor()` internal: signed in, active, `module_entry_open('quotations')`, then view; returns create / edit / view_all / admin.
  - `quotation_my_access()`, `quotation_list(scope)` ('mine' or 'all'; all needs view_all or Admin; at most 500), `quotation_get(id)` (with owner name, `may_edit`, last 30 events), `quotation_create(data)`, `quotation_save(id, doc)` (whole document; replaces room types and lines; refuses `QUOTATION_STALE` when `expected_updated_at` differs), `quotation_set_status(id, status, note)`, `quotation_share(id, on)`.
  - `quotation_public(token)`: the only function open to **anon**. A 32-hex token; returns client-safe fields only (no internal notes, owner id, phone, token); null for an unknown, turned-off or archived link; records "opened" at most once per 30 minutes.
- Who may change a quotation: Admin; or its owner/creator with create or edit; or anybody with edit **and** view_all (the pricing desk). Who may see it: Admin, view_all, owner, creator.
- Pictures: public bucket `quotation-images` (JPEG, 3 MB), paths `{uploader}/{uuid}.jpg`; insert only through `quotation_can_upload(name)` (own folder, create or edit); delete only an own upload no line uses. The browser shrinks every picture to 1600 px JPEG first (`toJpeg` from Inventory).

## 6. Business rules (defaults taken on the owner's behalf, 2026-11-12)

1. A module of its own, "Quotations", next to Sales; Admin only until granted per person.
2. Numbers keep the Base44 shape, QT-initials-5 digits, from 01001.
3. GST: BOE is registered in Rajasthan, so a Rajasthan delivery starts on CGST + SGST and any other state on IGST; the builder warns when the chosen mode does not match the state. (The real Resort Shamshabad quote printed CGST + SGST for a site outside Rajasthan.)
4. The printed terms are the PI sheet's, word for word (7 expectations, 23 terms, the closing line), including payment 70% / 30%. The contradictions found in the sheet (a 50% note, the system's 40% PI gate) are not resolved here: a later terms library takes one payment setting.
5. Validity counts from the day the quotation is sent (or made, before that); default 7 days, as the terms say.
6. A client link always shows the latest **saved** version. Sending is WhatsApp with the text filled in (wa.me); the person presses send. Opening the link is recorded and the page says so.
7. Archive, never delete.

## 7. Traps

- The working tree is CRLF under `core.autocrlf`; scripted edits must normalise line endings or anchors miss.
- `quotation_public` is volatile (it writes the "opened" event); do not make it stable to "optimise" it.
- `quotation_save` deletes and re-inserts room types and lines, so their ids change on every save: nothing may hold a line id across saves (a later PI conversion must read lines at the moment it converts).
- Fabric and packing go into the 18% GST group even when no furniture line is 18%.
- `Pic` (`src/components/quotations/Pic.tsx`) is the one place `<img>` is allowed for this module's pictures.

## 8. Recheck before changing

- Totals: `math.ts` and `quotation_value_before_gst` must keep the same rounding. Change both or neither; `math.test.ts` pins the real quote.
- A new client-visible field must be added to `quotation_public` deliberately; the PGlite suite asserts the fields that must never appear.
- New statuses need the CHECK, `quotation_set_status`, `STATUS_LABEL`, the CSS `st_*` class and the list filters.

## 9. Tests

`supabase/tests/quotations_pglite.mjs` (run: `node supabase/tests/quotations_pglite.mjs ~/BOE-Development/temporary/pglite-env`), `src/lib/quotations/math.test.ts`, `src/components/quotations/quotations.test.tsx` (the printed quotation from the real quote, registration, privacy), the testing report `docs/testing/quotations-phase1-test-report.md`, the registration tests (`accessCatalog.test.ts`, `imageEditor.test.ts`, `moduleParentGate.test.ts`) and the two migration ledgers in `participantAndOrderTotalSecurity.test.ts`.

## 10. Open items (next phases, from the plan)

Import of client files (Excel first, then PDF, Word, photos), Image studio on the existing Customize image pipeline, pricing desk and assist, versions and compare, confirm → PI draft, reports, terms library, link to the lead, and the Pricing module. None is built.
