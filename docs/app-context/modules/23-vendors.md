# 23. Vendors (outsourcing vendor base, visit log, vendor pipeline)

Written 2026-10-28 from the build, on branch `feat/vendor-management` (PR #472). Migration `20270426000000` is **NOT APPLIED** to production at the time of writing; the module is invisible to everyone until it is applied and a person is granted `view`.

## 1. Purpose & users

- The company is moving more manufacturing to outside vendors. Dhruv is the person who finds, meets and visits them. The owner wants a structured, searchable vendor base and **proof of every visit to a vendor's factory** (who, when, where, whom met, what was seen, photographs).
- Users: anyone granted `vendors` → `view` (Dhruv, per employee; no department rule) can add vendors, edit profiles, log meetings and read everything. Admin (role) also sees **Visit Activity**, sets any vendor status, archives / restores, and controls the catch-up window.

## 2. Status

- Built and verified: in-memory Postgres (31 checks, `supabase/tests/vendor_management_pglite.mjs`), the whole migration rehearsed against the linked database inside a rolled-back transaction (2026-10-28, zero residue), `tsc`, `eslint`, unit tests, full suite (CI). **Not seen on screen**; storage policies were exercised only in that rehearsal.
- Defaults taken (owner to confirm): GPS automatic; camera capture preferred on live visits; no price / payment terms / ratings / visit targets; fixed product-type list; no notification when a meeting is logged; no link from a vendor to an order or production job (phase 2); catch-up window for past entries defaults to 14 days after the migration is applied, Admin adjusts it.

## 3. The model

**Stages** of a vendor: `potential` (heard of, nobody in touch) → `contacted` (spoken to, or they came to our factory) → `prospect` (a member of our team has been to THEIR factory: registered) → the owner's decisions `under_evaluation` / `approved` / `on_hold` / `rejected`.
- Only `potential` / `contacted` may have an incomplete profile (just a name is required, plus optional `referred_by` = who recommended them). Table CHECK `vendors_complete_once_registered` requires contact person, mobile, address, city and at least one capability from `prospect` on.
- Anyone with access moves a vendor between `potential` and `contacted`; everything else is Admin only. A site visit moves `potential`/`contacted` → `prospect`; a meeting at our factory moves `potential` → `contacted`.

**Two kinds of meeting** (`vendor_visits.kind`):
- `site_visit` — we went to their factory: the proof event. **Live** (not entered later) it needs ≥1 photograph (a factory photograph if it is the vendor's first live site visit) and captures GPS; the server computes `distance_m` from the vendor's address point.
- `vendor_at_our_factory` — they came to us: no photographs or location needed (`location_source = 'not_applicable'`); never registers the vendor. Vendors that have such a meeting but no site visit are "awaiting a site visit" (list tab, vendor banner, Activity chase list with days waiting).

**Entered later** (`entered_later = true`): something that already happened before the system existed, typed in afterwards with the day it happened (not future, ≤120 days back). No photographs or location are kept, it is labelled "Added later · no proof", never counts as "at the vendor", and never replaces the live proof (the first live site visit still needs a factory photograph). Allowed only while `vendor_settings.past_entries_until` is not past; Admin sets it (`set_vendor_past_entries_until`), default applied-date + 14.

## 4. Pages (`src/app/vendors/`)

| Route | Screen | Who |
|---|---|---|
| `/vendors` | `VendorListScreen` — status tabs with counts (+ "Met us · awaiting site visit"), multi-word search, filters, sort, paging; all state in the URL | module users |
| `/vendors/new` | `AddPotentialVendorScreen` — name + who recommended them, 20-second form | module users |
| `/vendors/visit` (`?vendor=<id>&kind=`) | `LogVisitScreen` — what happened, which vendor, completes the profile if a site visit registers a name-only vendor, details, photos, GPS, "already happened" switch | module users |
| `/vendors/[id]` | `VendorDetailScreen` — hero (call / WhatsApp / map / log), stage track, tabs Visits · Profile · Photos | module users (archived: Admin) |
| `/vendors/[id]/edit` | `VendorEditScreen` (relaxed while potential/contacted) | module users |
| `/vendors/activity` | `ActivityScreen` — pipeline, site visits vs at-our-factory vs added-later, per person, chase list, quiet vendors, follow-ups, window control | Admin |

Layout guard `src/app/vendors/layout.tsx` (sign-in, then `ModuleGuard('vendors')`); shell `src/components/layout/VendorsLayout.tsx`; library `src/lib/vendors/` (constants, api, validation, photos, csv); hook `src/hooks/useVendors.ts`; launcher card in `src/app/modules/page.tsx`.

## 5. Database (`20270426000000_vendor_management.sql`)

- `vendors`, `vendor_visits` (append-only by trigger; `visited_at` server time for live records, noon of the chosen day for entered-later ones), `vendor_visit_photos` (path unique), `vendor_settings` (one row, no browser access). Tables read-only to the browser: write privileges revoked **and** no write policy; `vendors_can_read()` select policies + RESTRICTIVE `module_entry_open('vendors')`.
- Writes (SECURITY DEFINER, `auth.uid()`): `save_vendor` (create / update; stage-aware validation; duplicate by mobile, or by name+city when there is no mobile), `log_vendor_visit`, `set_vendor_status`, `set_vendor_past_entries_until` (Admin), `archive_vendor`, `restore_vendor`. Reads: `vendor_list` (every typed word must match company / person / phone / city / address / materials / recommender; `status_counts` for tabs; `awaiting_visit` filter), `get_vendor`, `vendor_activity` (Admin), `vendors_my_access` (is_admin, window), `vendor_profile_complete` (internal).
- Private bucket `vendor-visit-photos` (5 MB, JPEG), path `{uploader uuid}/{uuid}.jpg`. Registration inside the migration (`app_modules`, `permission_modules`, `view` action, Admin role row); default allowed: nobody. Mirrors `registerModule('vendors')` in `src/lib/permissions/modules.ts`; `ENGINE_GATED_MODULE_KEYS` (13 now) and `enforcement.ts` carry the key.

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
