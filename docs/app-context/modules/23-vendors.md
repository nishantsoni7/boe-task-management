# 23. Vendors (outsourcing vendor base and visit log)

Written 2026-10-28 from the build, on branch `feat/vendor-management`. Migration `20270425000000` is **NOT APPLIED** to production at the time of writing; the module is invisible to everyone until it is applied and a person is granted `view`.

## 1. Purpose & users

- The company is moving more manufacturing to outside vendors. Dhruv is the person who finds, visits and manages them. The owner wants a structured, searchable vendor base and **proof of every vendor visit** (who, when, where, whom they met, what was seen, photographs).
- Users: anyone granted `vendors` → `view` (Dhruv, per employee; no department rule) can add vendors, edit profiles, log visits and read everything. Admin (role) also sees **Visit Activity**, changes a vendor's status, and archives / restores vendors.

## 2. Status

- Built and verified in an in-memory Postgres (22 checks, `supabase/tests/vendor_management_pglite.mjs`), `tsc`, `eslint`, 17 unit tests, and the structural guards. **Not seen on screen** and **not run against real Supabase** (storage policies, `module_entry_open`, `resolve_permission` are stubs in the PGlite harness).
- Open owner decisions taken as defaults (see section 8): GPS captured automatically; camera capture preferred; no ratings / price / payment terms; fixed product-type list; no notification on a new visit; no link to orders.

## 3. Pages (`src/app/vendors/`)

| Route | Screen | Who |
|---|---|---|
| `/vendors` | `VendorListScreen` — status tabs with counts, search, filters, sort, paging; all state in the URL | module users |
| `/vendors/visit` (`?vendor=<id>`) | `LogVisitScreen` — pick or create vendor, visit details, photographs, GPS | module users |
| `/vendors/[id]` | `VendorDetailScreen` — hero with Call / WhatsApp / Map / Log visit, tabs Visits · Profile · Photos | module users (archived: Admin) |
| `/vendors/[id]/edit` | `VendorEditScreen` | module users |
| `/vendors/activity` | `ActivityScreen` — per person, quiet vendors, follow-ups due | Admin |

Layout guard `src/app/vendors/layout.tsx`: signed-in check with `/login?redirect=`, then `ModuleGuard('vendors')`. Shell `src/components/layout/VendorsLayout.tsx`. Library `src/lib/vendors/` (constants, api, validation, photos, csv). Hook `src/hooks/useVendors.ts`. Launcher card in `src/app/modules/page.tsx`.

## 4. Database (`20270425000000_vendor_management.sql`)

- `vendors` (profile; `submission_id` unique idempotency key; unique **active** `phone_e164`; archive fields all-or-none), `vendor_visits` (append-only by trigger; `visited_at` is server time; `location_source` gps|unavailable; `distance_m` computed from the vendor's address point; `follow_up_needed` requires a date), `vendor_visit_photos` (path unique — one photograph, one visit; kind factory|person|product|other).
- Tables are read-only to the browser (`vendors_can_read()` select policies + RESTRICTIVE `module_entry_open('vendors')`); no write policy exists. All writes are SECURITY DEFINER functions reading `auth.uid()`: `save_vendor`, `log_vendor_visit`, `set_vendor_status`, `archive_vendor`, `restore_vendor`. Reads: `vendor_list` (all typed words must match; returns `status_counts` for the tabs), `get_vendor`, `vendor_activity` (Admin), `vendors_my_access`.
- Private bucket `vendor-visit-photos` (5 MB, JPEG), path `{uploader uuid}/{uuid}.jpg`; module users may read attached photographs; an unattached upload is visible only to its uploader.
- Registration inside the migration (`app_modules`, `permission_modules`, `module_permission_actions` view, Admin role row). Default allowed: nobody. Mirrors `registerModule('vendors')` in `src/lib/permissions/modules.ts`; `ENGINE_GATED_MODULE_KEYS` and `enforcement.ts` carry the key.

## 5. Business rules

- A visit needs: purpose, person met, what was discussed, outcome, and at least one photograph; a vendor's **first** visit needs a factory photograph. Follow-up outcome needs a future date. GPS is optional but its absence is recorded and shown (“No location recorded”); the app never treats it as verified.
- “At the vendor” = a GPS visit within 500 m (`AT_SITE_METRES`) of the vendor's address point. The point is pinned from the first good fix (accuracy ≤ 200 m) when the vendor has none.
- The same active mobile number cannot create a second vendor: the answer names the existing vendor and the screen offers to log the visit there. Archiving frees the number; restoring re-checks it.
- Day boundaries are Asia/Kolkata.

## 6. Decisions & why

- Visits are append-only (trigger): the point of the module is a record that cannot be tidied afterwards; corrections are new visits.
- Tabs show per-status counts under the current search (the status filter is applied after the counts are taken).
- Search is multi-word AND across company, person, phone, city, state, address, materials, product types — a person remembers fragments, not exact names.
- List state lives in the URL (`useListUrlState`) so Back / reload / share restore the exact view.
- Half-written visits are kept in `localStorage` (`vendors:visit-draft:v1`) minus photographs.

## 7. Traps

- Photographs: the browser shrinks to 1800 px JPEG; the bucket allows only `image/jpeg`.
- The `permissions:check` script reads the live database; it reports `vendors` as missing until the migration is applied.
- New migration files must be added to the two ledgers in `src/lib/finance/participantAndOrderTotalSecurity.test.ts`.
- The PGlite harness stubs platform objects; it proves the SQL executes and behaves, not Supabase's storage layer.

## 8. Defaults taken (owner to confirm)

GPS automatic; camera capture attribute on photo inputs (gallery still possible on desktop); no price / payment terms / ratings / visit targets; fixed product-type list (editable only by migration); no notification when a visit is logged; no link from a vendor to an order or production job (phase 2).

## 9. Recheck before changing

`supabase migration list --linked` shows `20270425000000` with a non-empty remote before calling it applied; re-run `node supabase/tests/vendor_management_pglite.mjs <pglite dir>`; grep `vendor_list` for a newer migration that re-issues it (the latest definition wins).
