# Asset Catalogue and Owner Overview

Migration `20270130000000_asset_catalogue.sql`. Assets & Access module.

## The three words

| Term | What it is | Where it lives |
|---|---|---|
| **Category** | A grouping such as Laptop / Desktop or Phone. | `asset_categories`. Its primary key **is** the value `assets.asset_type` has always stored (`laptop_desktop`), now a RESTRICT foreign key. The key never changes; renaming changes `name` only. |
| **Product** | A reusable type or model within a category, such as one laptop model. It has no holder, no status and no code. | `asset_products` (unique name **within** a category). An asset may name one through the nullable `assets.product_id`. |
| **Asset** | One item BOE owns, with its `BOE-AST-…` code, which may be assigned to a person. | `assets`, unchanged. Custody is still the open `employee_assets` row. |

Before this migration, categories were a list of six values compiled into the app
(`ASSET_CATEGORY_OPTIONS`). That list is gone, so there is one catalogue, not two.

## Backfill

- The six existing categories are inserted under their existing keys. Any other value found in
  `assets.asset_type` or `asset_change_requests.proposed_asset_type` is kept under its own key.
  Production had none on 2026-09-27.
- **No products are created.** Existing brand and model text is inconsistent, so turning it into
  catalogue rows would publish guesses. Existing assets keep `product_id = NULL` and their own
  name, brand and model exactly as entered.
- No asset row is updated.

## Retire, never delete

There is no DELETE path, and every foreign key into the catalogue is RESTRICT. Retiring
(`is_active = false`) stops an entry being offered for **new** assets:

- An existing asset in a retired category still saves edits to other fields.
- An existing asset shows its retired category in the edit form, labelled "(inactive)".
- A product that assets already name cannot move to another category.
- Changing an asset's category clears a product that belonged to the old category, and that
  change is recorded in the asset's history.

## Who may change it

The permission is `assets_access.manage_asset_catalogue`, shown in the app as **Manage Asset
Catalogue**. It is protected, denied by default and depends on `view`.

- **Granting.** The migration grants it to nobody except the admin role. An administrator grants
  it per person in Control Center → Access Control → the employee → Assets & Access → Change
  level → Custom.
- **What it allows.** Add, rename, retire and reactivate categories and products, and see usage
  counts through `asset_catalogue_usage()`, which returns counts only.
- **What it does not allow.** It gives no inventory sight, no asset create, assign, edit, delete
  or manage, no access records, no Control Center rights and no payroll. No combination of the
  asset actions adds up to it.
- **Enforcement.** The catalogue tables grant clients SELECT only. Writes go through four
  SECURITY DEFINER RPCs (`create_/update_asset_category`, `create_/update_asset_product`), each
  of which calls `can_manage_asset_catalogue()` first. A direct PostgREST insert or update is
  refused with 42501.
- **Audit.** Every change writes an append-only `asset_catalogue_activity` row recording actor,
  name and time. The Catalogue screen shows it under "Recent catalogue changes".

## Owner overview (Asset Inventory)

- **Counts.** Active assets (retired and disposed are not counted), Assigned, Available and Needs
  attention. Each count opens the rows behind it.
- **Needs attention.** Lists each asset once, with every reason that applies:
  - a record that needs review (status and custody disagree);
  - lost;
  - handover not accepted, with days waiting;
  - under repair;
  - condition recorded as poor or damaged;
  - warranty ending within 30 days, only when an expiry is recorded.
- **Not flagged.** Available stock is never flagged. There is no "overdue return", because no
  expected-return date is recorded.
- **No cost figures.** Purchase price and purchase date are empty on every production asset, so
  no total is shown.
- **Views.** All assets (search, then Category / Product / Status / Held by, then More filters,
  then Clear), By person (drills into the list filtered to that holder) and By category (every
  count drills into the list).

## Verifying

- `supabase/tests/asset_catalogue_assertions.sql` checks denial of direct requests, the
  delegate's limits, duplicates, retirement, renames keeping links, audit and revoking. It
  creates its own fixtures and rolls back. Run it on a disposable local database that has the
  migration applied:
  `tr -d '\r' < supabase/tests/asset_catalogue_assertions.sql | docker exec -i supabase_db_<project> psql -U postgres -d postgres`
- `src/lib/permissions/manageAssetCatalogue.test.ts`, `src/lib/assets/catalogue.test.ts`,
  `src/lib/assets/overview.test.ts`, `assetFilters.test.ts` and `viewRouting.test.ts` need no
  database.

## Deploy order and rollback

- **Deploy order.** Apply the migration **before** deploying the frontend. The app reads
  `assets.product_id` and the catalogue tables, and an older database would answer 400.
- **Rollback.** A reviewed script is kept outside the repo in
  `temporary/asset-catalogue/rollback_20270130000000.sql`. It was tested on a local copy and
  refuses to run while any asset names a product. `assets.asset_type` is never modified, so no
  asset data needs restoring.
