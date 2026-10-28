# 23. Vendors (outsourcing vendor base, visit log, vendor pipeline)

Written 2026-10-28 from the build, on branch `feat/vendor-management` (PR #472). Migration `20270426000000` was **APPLIED to production on 2026-10-28** (together with the earlier-unapplied `20270422000000` Orders and `20270425000000` phone-alerts migrations, with `db push --include-all`); the module stays invisible to everyone until a person is granted `view` in Control Center. The catch-up window for past entries was set to 2026-11-11.

## 1. Purpose & users

- The company is moving more manufacturing to outside vendors. Dhruv is the person who finds, meets and visits them. The owner wants a structured, searchable vendor base and **proof of every visit to a vendor's factory** (who, when, where, whom met, what was seen, photographs).
- Users and access levels (Control Center, per employee, no department rule; **since migration 20270429000000**): `view` = Viewer, read-only (every vendor, visit, photograph, note). `create` + `edit` = Contributor: add vendors, log visits, edit profiles, move a vendor between Potential and Contacted. `approve` = Manager: also set the later stages, archive / restore, change the catch-up date, and see **Visit Activity**. `export` = Manager: download the list. `view_all` (protected, Custom only) = see **Visit Activity** without any power to decide, for a colleague who oversees the team. The Admin role holds all. Before that migration `view` alone did everything a non-admin could; the migration gave create + edit to everyone who then held `view` (Dhruv), so nobody lost anything.

## 2. Status

- Built and verified: in-memory Postgres (31 checks, `supabase/tests/vendor_management_pglite.mjs`), the whole migration rehearsed against the linked database inside a rolled-back transaction (2026-10-28, zero residue), `tsc`, `eslint`, unit tests, full suite (CI). **Not seen on screen**; storage policies were exercised only in that rehearsal.
- Defaults taken (owner to confirm): GPS automatic; camera capture preferred on live visits; no price / payment terms / ratings / visit targets; fixed product-type list; no notification when a meeting is logged; no link from a vendor to an order or production job (phase 2); catch-up window for past entries defaults to 14 days after the migration is applied, Admin adjusts it.

## 3. The model

**Stages** of a vendor: `potential` (heard of, nobody in touch) → `contacted` (spoken to, or they came to our factory) → `prospect` (a member of our team has been to THEIR factory: registered) → the owner's decisions `under_evaluation` / `approved` / `on_hold` / `rejected`.
- Only `potential` / `contacted` may have an incomplete profile (just a name is required, plus optional `referred_by` = who recommended them). Table CHECK `vendors_complete_once_registered` requires contact person, mobile, address, city and at least one capability from `prospect` on.
- Anyone with `edit` moves a vendor between `potential` and `contacted`; everything else needs `approve` (or the Admin role). A site visit moves `potential`/`contacted` → `prospect`; a meeting at our factory moves `potential` → `contacted`.

**Two kinds of meeting** (`vendor_visits.kind`):
- `site_visit` — we went to their factory: the proof event. **Live** (not entered later) it needs ≥1 photograph (a factory photograph if it is the vendor's first live site visit) and captures GPS; the server computes `distance_m` from the vendor's address point.
- `vendor_at_our_factory` — they came to us: no photographs or location needed (`location_source = 'not_applicable'`); never registers the vendor. Vendors that have such a meeting but no site visit are "awaiting a site visit" (list tab, vendor banner, Activity chase list with days waiting).

**Entered later** (`entered_later = true`): something that already happened before the system existed, typed in afterwards with the day it happened (not future, ≤120 days back). No photographs or location are kept, it is labelled "Added later · no proof", never counts as "at the vendor", and never replaces the live proof (the first live site visit still needs a factory photograph). Allowed only while `vendor_settings.past_entries_until` is not past; Admin sets it (`set_vendor_past_entries_until`), default applied-date + 14.

**Deliberately small, and Jodhpur only.** The owner trimmed the model twice (2026-10-28). Vendor: company name, contact person, mobile, address, area (the locality in Jodhpur, e.g. Basni; typed once, then suggested, one spelling per area), products (chairs and other products / other products only), capability (raw manufacturing / full finished piece / only finishing; more than one allowed), team size (3-5, 6-10, 11-15, 16-20, 21+), notes, and the factory's location (found from the phone, never typed). Meeting: kind, person met, notes, outcome, follow-up date, photographs, location. Removed on purpose: city (every vendor is in Jodhpur), who recommended them, vendor designation, second phone, email, state, pincode, materials, monthly capacity, people as a number, the long product-type list, visit purpose, designation of the person met. Do not re-add a field without asking what it is for.

**Design language** (`vendors.module.css`): Notion-like. 14px body, 12.5px secondary, weights 400 / 500 only (600 for the vendor's name), flat sections with small uppercase titles instead of boxed cards, hairline borders, the accent colour only for the primary action, a label-and-control "property row" on desktop that stacks on a phone. The list has four stage tabs that always fit (All / Potential / Contacted / Registered) and everything else behind one Filter button; no horizontal scroll at 375 px.

**Interaction details worth keeping** (second design pass): the list is a keyboard-driven table (sortable column headers, the stage editable in the row, ↑ ↓ between rows, Enter opens, "/" focuses the search, hover quick-call); the visit form is one flat page with a compact outcome picker, photo tiles with a clear "factory photo required" state (drag files in on a computer), Ctrl/Cmd+Enter to save, and a "draft saved on this device" note; the vendor and visit forms use one label-and-value row layout (a Notion property list) so nothing is out of line.

## 4. Pages (`src/app/vendors/`)

| Route | Screen | Who |
|---|---|---|
| `/vendors` | `VendorListScreen` — three tabs (All / Registered / Not registered); always-visible filters Expertise, Products, Team size, Area, Status and "Met us, not visited"; each row shows expertise tags (Raw / Full finish / Finishing only), what they make, team size, area, an editable stage and the last meeting; sortable header; all state in the URL | module users |
| `/vendors/new` | `AddPotentialVendorScreen` — the full property list, only the company name required; the phone's location is found automatically and one tick saves it as the factory's location | module users |
| `/vendors/visit` (`?vendor=<id>&kind=`) | `LogVisitScreen` — what happened, which vendor, completes the profile if a site visit registers a name-only vendor, details, photos, GPS, "already happened" switch | module users |
| `/vendors/[id]` | `VendorDetailScreen` — hero (call / WhatsApp / map / log), stage track, tabs Visits · Profile · Photos | module users (archived: Admin) |
| `/vendors/[id]/edit` | `VendorEditScreen` (relaxed while potential/contacted) | module users |
| `/vendors/activity` | `ActivityScreen` — pipeline, site visits vs at-our-factory vs added-later, per person, chase list, quiet vendors, follow-ups, window control | `approve`, `view_all` or Admin |

Layout guard `src/app/vendors/layout.tsx` (sign-in, then `ModuleGuard('vendors')`); shell `src/components/layout/VendorsLayout.tsx` (on the hover rail since 2026-10-29, like every other module); library `src/lib/vendors/` (constants, api, validation, photos, csv); hook `src/hooks/useVendors.ts`; launcher card in `src/app/modules/page.tsx`.

## 5. Database (`20270426000000_vendor_management.sql`)

- `vendors`, `vendor_visits` (append-only by trigger; `visited_at` server time for live records, noon of the chosen day for entered-later ones), `vendor_visit_photos` (path unique), `vendor_settings` (one row, no browser access). Tables read-only to the browser: write privileges revoked **and** no write policy; `vendors_can_read()` select policies + RESTRICTIVE `module_entry_open('vendors')`.
- Writes (SECURITY DEFINER, `auth.uid()`): `save_vendor` (create / update; stage-aware validation; duplicate by mobile, or by name+city when there is no mobile), `log_vendor_visit`, `set_vendor_status`, `set_vendor_past_entries_until` (Admin), `archive_vendor`, `restore_vendor`. Reads: `vendor_list` (every typed word must match company / person / phone / address / notes; `status_counts` for the tabs and `awaiting_count` for the notice; `awaiting_visit` filter), `get_vendor`, `vendor_activity` (`approve`, `view_all` or Admin), `vendors_my_access` (is_admin = may decide, can_create, can_edit, can_export, can_see_activity, window), `vendor_profile_complete` (internal).
- Private bucket `vendor-visit-photos` (5 MB, JPEG), path `{uploader uuid}/{uuid}.jpg`. Registration inside the migration (`app_modules`, `permission_modules`, `view` action, Admin role row); default allowed: nobody. Mirrors `registerModule('vendors')` in `src/lib/permissions/modules.ts`; `ENGINE_GATED_MODULE_KEYS` (13 now) and `enforcement.ts` carry the key.

**Migration 20270427000000** (Area and filters) re-issues `save_vendor`, `vendor_list` and `get_vendor` (the LATEST definitions) and adds `vendors.area`; `vendor_list` also filters on `team_sizes[]` and `areas[]` and returns `areas` (the areas in use, active vendors only) for the Area filter and the form's suggestions.

**Migration 20270429000000** (access levels) registers create / edit / approve / export / view_all against Vendors (deny-by-default, Admin role row), backfills create + edit for explicit `view` holders, adds the internal helpers `vendors_can(action)` and `vendors_require(action)` (not callable from the browser), re-issues `save_vendor`, `log_vendor_visit`, `set_vendor_status`, `vendor_activity`, `vendors_actor` (its `p_is_admin` now means "may decide": Admin or `approve`, so archive / restore / the catch-up date / archived list follow `approve` unchanged) and `vendors_my_access`. The screens hide what the level does not allow (`useVendorAccess`); the database refuses it anyway. Export is a screen-level gate only: the list is already readable by every viewer.

**Scan a card or name plate** (no migration). A Scan button under Address on the vendor form (Add vendor, Log visit for a new vendor, Edit) photographs a visiting card or the board outside the workshop; `POST /api/vendors/scan` reads it once with the same Anthropic key and model list as Exhibition Leads (`ANTHROPIC_API_KEY`; not set = "type the details"), returns company, contact person, numbers, address and area, and drops the photo (never stored, never logged). Access is the caller's own `vendors_my_access().can_create`. `applyVendorScan` fills only EMPTY fields and skips a number the form cannot save; the person checks before saving. Products and Team size are drawn as separate pills (`Chips`, single choice, tap again to clear) instead of a joined segmented bar.

## 6. Business rules to remember

- "At the vendor" = a LIVE site visit within 500 m (`AT_SITE_METRES`) of the vendor's address point; the point is pinned from the first good fix (accuracy ≤ 200 m). Meetings at our factory and entered-later visits are counted separately in Activity and are never proof.
- Same active mobile cannot create a second vendor; archiving frees the number, restoring re-checks it.
- Day boundaries are Asia/Kolkata.

## 7. Traps

- New migrations must be added to both ledgers in `src/lib/finance/participantAndOrderTotalSecurity.test.ts`, and a new gated module changes the pinned counts / card lists in `src/lib/permissions/imageEditor.test.ts` and `moduleParentGate.test.ts` (CI caught this once: run the **whole** suite before pushing).
- `permissions:check` reads the live database and reports `vendors` as missing until the migration is applied.
- The PGlite harness stubs platform objects; the real-database proof is the rolled-back rehearsal (recipe: `reference_rollback_rehearsal_via_db_query_file`).
- JavaScript `String.replace` with a string replacement mangles `$$` in SQL; use split/join or a function replacer when assembling SQL.

## 8. Recheck before changing

`supabase migration list --linked` shows `20270426000000` with a non-empty remote before calling it applied; re-run `node supabase/tests/vendor_management_pglite.mjs <pglite dir>`; grep `vendor_list` / `log_vendor_visit` for a newer migration that re-issues them (the latest definition wins).
