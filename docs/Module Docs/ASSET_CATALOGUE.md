# Asset Catalogue and Owner Overview

Migration `20270131000000_asset_catalogue.sql`. Assets & Access module.

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

### Required order: migration first, then frontend

1. **Before the release**, run `asset-catalogue-post-release-checks.sql` (read-only) and keep
   the section A values as the baseline.
2. **Apply the migration.** Confirm first that `npx supabase migration list --linked` shows
   `20270131000000` as the only pending version. Its number must still be above every applied
   version: if production has moved past it, renumber before pushing. It is safe for the
   **currently deployed** frontend. The old app never selects `product_id`, reads no catalogue
   table, and only ever writes one of the six backfilled category keys, all of which pass the
   new foreign key.
3. **Deploy the frontend.** The new app selects `assets.product_id` and reads
   `asset_categories` / `asset_products`. Against a database without the migration, every asset
   screen gets a 400 from PostgREST. **Never deploy the frontend first.**

### After the release: exact checks

Run `docs/Module Docs/asset-catalogue-post-release-checks.sql` (SELECT only). It returns one
JSON row, and every value has an `expect:` beside it in the file:

| Check | Expected |
|---|---|
| Section A (asset count, per type/status, assignments by status, access records, status/custody mismatch) | Identical to the pre-release baseline |
| `B_ledger_has_version` | 1 |
| `C_original_six_present` / `C_categories_total` | 6 / 6 |
| `C_assets_without_category`, `C_products_total`, `C_assets_with_product`, `C_catalogue_history_rows` | 0 |
| `D_action_default_denied` | 1 |
| `D_non_admin_role_grants`, `D_employee_grants` | 0 |
| `E_authenticated_write_privs`, `E_anon_select`, `E_permissive_write_policies`, `F_rpcs_anon_executable` | 0 |
| `E_entry_gates` | 3 |
| `F_write_rpcs_definer_pinned` | 6 |
| `F_asset_triggers` | 2 |
| `F_restrict_fks` | 3 |
| `F_history_guard` | 1 |

Then check the app itself:

- **As Admin:** Asset Inventory loads with the same counts as before. Catalogue shows the six
  categories, with "used by" totals that add up to the asset count. Edit an existing asset,
  change nothing, and save: it must succeed.
- **As an ordinary employee:** My Assets shows category names. `?view=asset-catalogue` falls
  back to My Assets.

A failed check is a stop: do not grant the permission to anyone until every check passes.

### Rollback, and its limit

`docs/Module Docs/asset-catalogue-rollback.sql` restores the pre-migration schema. It was tested
locally: on a freshly migrated database it removes every table, column, function and permission
row it added. Roll the **frontend back first**, because the new frontend cannot run on the old
schema.

**Hard limit.** Once any asset names a product, the script refuses, and there is no override.
That link exists only in `assets.product_id`, so rolling back would destroy it. Clear or record
those assignments first, as a deliberate decision.

**Even when no asset has a product, a rollback permanently deletes the catalogue itself.** It
drops the three catalogue tables, so everything created or changed after release is deleted, not
archived:

| After-release catalogue data | What happens on rollback |
|---|---|
| Categories added after release | The rows and display names are deleted. Assets and pending change requests filed under one **keep its key as plain text** (e.g. `workshop_equipment`). The old app shows it in words derived from the key. A category renamed after creation shows its **original** words, because the key came from its first name. The old app can no longer offer it for new assets, but editing such an asset keeps it. |
| Renames of the six original categories | Lost. They read as before the release ("Laptop Desktop", "Mouse Keyboard"). |
| Products, assigned or not | Deleted. An assigned product blocks the rollback (hard limit above). |
| Retired flags | Lost. The old app offers exactly its fixed six again. |
| Catalogue change history (who / what / when) | Deleted. Per-asset history in `asset_activity_log` is untouched, including "Updated product" entries, which store names rather than ids. |
| "Manage Asset Catalogue" grants | Deleted: employee, role and department. |

Because that is irreversible, the script **prints these counts and refuses** whenever any of them
is non-zero, until the operator runs, in the same session,
`set boe.asset_catalogue_rollback_discard = 'yes';`. **Export first:** the file's header contains
a read-only query that returns the categories, products, history and grants as one JSON value.
Keep that JSON as the record.

A rollback straight after release, before anyone has used the catalogue, discards nothing and
needs no acknowledgement. `assets.asset_type` is never modified, so no other asset data needs
restoring.

Verified locally for each case:
- straight after release: rolls back without an acknowledgement;
- catalogue used, no acknowledgement: refuses and lists the counts;
- with the acknowledgement: rolls back, and assets keep the key text;
- a product assigned: refuses even with the acknowledgement.
