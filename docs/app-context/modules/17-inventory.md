# 17. Inventory (stock for sale)

Verified against checkout `852e0493`. Newest module group member (PR #305 `03a2c60a` + #306 `2dde76a4`, both 2026-10-13).

## 1. Purpose & users

- Furniture stock that is FOR SALE (not the Assets & Access company-asset register): each product has stage in the production pipeline, condition, price, quantity, pictures, and an expected-ready date; salespeople ask to book units for a customer; a Manager confirms/rejects/reverses; stock can be shared to a customer on WhatsApp.
- Roles by permission: Sales/employee = `view` (open module, see every product, request a booking, see/cancel OWN requests). Manager = `create`, `edit`, `delete`, `approve` (all five). Admin role holds all five by `role_permissions` row.
- Go-live recommendation from memory: manager all five, sales `view`, granted in Control Center. Nobody held any `inventory` permission at 2026-10-13 apart from the admin role; whether grants were made since is unknown (unverified, from memory).

## 2. Status at commit 852e0493

- SHIPPED (all three migrations on main, applied to prod 2026-10-13 after dry-run and explicit go-ahead, from memory): `20270313000000_inventory_module.sql`, `20270314000000_inventory_notification_types.sql`, `20270314000100_inventory_booking_notifications.sql`.
- Memory follow-ups: "no notification to the manager on a new request" is now DONE by #306; "removed pictures stay in storage" remains true (see traps).

## 3. Pages and API routes

Pages (`src/app/inventory/`): `/inventory` (StockScreen), `/inventory/[id]` (ProductDetailScreen), `/inventory/[id]/edit`, `/inventory/new` (ProductFormScreen), `/inventory/requests` (RequestsScreen: approvers see every request, others see "My Requests"), `/inventory/notifications` (shared notifications view, category `inventory`).

API routes: NONE. The module is RPC-only from the browser: `src/lib/inventory/api.ts` calls the SECURITY DEFINER functions; pictures upload directly to the Storage bucket.

Layout guard `src/app/inventory/layout.tsx`: (1) signed in, else `/login?redirect=<path>`; (2) `ModuleGuard moduleKey="inventory"` (same guard as every engine-gated module; the launcher card asks the same function).

## 4. Database

Tables (migration `20270313000000`): all with RLS, SELECT policies only for clients, plus RESTRICTIVE `*_module_entry_gate` policies using `module_entry_open('inventory')`; clients cannot write directly.

| Table | Key columns / constraints |
|---|---|
| `inventory_items` | `product_code` text, regex `^[A-Z0-9][A-Z0-9._/-]{0,39}$`, unique among LIVE rows only (`inventory_items_code_live` where `deleted_at is null`); `name` 1-120; `category` optional 1-60; `size_text`, `material` 1-120; `description` <= 1000; `price numeric(12,2) >= 0`; `condition` in new/refurbished/needs_repair/antique; `stage` in raw/in_production/finishing/awaiting_upholstery/under_repair/ready; `expected_ready_on` date (CHECK null when stage = ready); `qty_total` 0..100000; `qty_reserved`, `qty_sold` >= 0; `qty_available` GENERATED = total - sold - reserved; CHECK `qty_sold + qty_reserved <= qty_total` (no oversell); soft delete `deleted_at/by` |
| `inventory_images` | `path` unique, must match `{uploader uuid}/{uuid}.jpg`; `position >= 0`, unique (item_id, position) DEFERRABLE; position 0 = thumbnail; `ON DELETE CASCADE` from item |
| `inventory_bookings` | `request_id` uuid UNIQUE (idempotency key minted by the form); `qty` 1..100000; `customer_name` 1-120; `customer_phone` optional E.164 `^\+[1-9][0-9]{7,14}$`; `note` <= 500; `status` pending/confirmed/rejected/cancelled; requested_by/at; decided_by/at (set together by CHECK); `decision_note` <= 500 |
| `inventory_events` | append-only audit: action in created/updated/deleted/requested/confirmed/rejected/cancelled/reversed, `detail jsonb` |

Functions (all definer, `search_path` pinned, re-check caller; revoked from public/anon, granted to authenticated): `inventory_actor`, `inventory_my_access()`, `inventory_can_upload(name)`, `inventory_save_item(item_id, data jsonb, images text[])`, `inventory_delete_item`, `inventory_request_booking(request_id, item_id, qty, customer_name, phone, note, confirm_now)`, `inventory_decide_booking(booking_id, decision, qty, note)`, `inventory_cancel_booking(booking_id, note)`, `inventory_bookings_list(...)`, `inventory_item_history(item_id, limit 50)`. Notifications (20270314000100): AFTER trigger `inventory_bookings_notify` on `inventory_bookings` calling `inventory_booking_notify()` (definer, same transaction; no execute for anon/authenticated).

Enum values (20270314000000, `ALTER TYPE notification_type ADD VALUE IF NOT EXISTS`): `inventory_booking_requested`, `inventory_booking_decided`. Must be applied before the code or the `type.in.(...)` feed filter gets 22P02.

Module registration inside the migration: `app_modules` (`/inventory`, visibility `live`, sort_order 110), `permission_modules`, `module_permission_actions` (5 actions, default_allowed false), `role_permissions` for role `admin` all true. Mirrors `src/lib/permissions/modules.ts`.

Storage: bucket `inventory-images`, PUBLIC (a client must open the picture from a WhatsApp message), `file_size_limit` 3145728 (3 MB), `allowed_mime_types` = `image/jpeg` only. Policies `inventory_images_insert` / `inventory_images_delete` on `storage.objects`; paths are unguessable and carry no price or customer.

Rollback (documented in the migration header): drop the four tables and `inventory_*` functions, delete the `inventory_images_*` storage policies, empty and delete the bucket, delete module rows.

## 5. Permissions & access

- Module key `inventory`; actions `view`, `create`, `edit`, `delete`, `approve` (`approve` is a custom action registered by the migration; off for everyone until granted).
- `view`: open, see all products, request, see/cancel OWN requests. `create/edit/delete`: the product record (delete is soft; a product with pending requests cannot be deleted). `approve`: see EVERY booking request, confirm/reject/reverse; only approvers may `confirm_now` (`INVENTORY_FORBIDDEN` 42501 otherwise).
- Every write function re-checks; direct table writes are refused; `anon` cannot execute.
- Notification recipients: all active approvers (Admin role or `inventory:approve`) except the requester.

## 6. Business rules

- Quantities: a request RESERVES units immediately (so two salespeople cannot promise the same chairs). Confirm moves reserved -> sold. Reject/cancel gives reserved back. Reversing a confirmed booking (approvers only, reason required: "Say why the sale is being reversed") gives sold units back and logs `reversed`. An approver may confirm with a CHANGED quantity.
- Insufficient stock: `INVENTORY_INSUFFICIENT: Only N available right now` (22023). Same `request_id` retry returns the first booking; reusing a request_id for a different item/qty/user is refused.
- Manager "confirm now" sale (asker and decider) notifies nobody.
- Notification routing: new PENDING request -> every active approver except requester; Confirmed/rejected -> the requester unless they decided it; cancelled by someone else (manager cancelling a pending request, or reversing a confirmed sale) -> the requester; withdrawing your own request tells nobody. `entity_id` = booking id; link opens Booking Requests (approvers) or My Requests; `is_push_sent` true (in-app only). Category `inventory`.
- Stage pipeline (order a piece travels) with default lead-time days offered in the form: raw 30, in_production 21, finishing 10, awaiting_upholstery 7, under_repair 14, ready 0 (`STAGES` in `constants.ts`); the manager overrides per piece. Screens show "ready in about N days".
- Images: max 8 per product (`MAX_IMAGES`), JPEG only, 3 MB each, first = thumbnail. `images.ts` `toJpeg()` re-draws every picture on a canvas, longest edge capped at 1600 px (`MAX_EDGE`), JPEG quality 0.86, so 4-12 MB phone photos fit the 3 MB bucket limit.
- Product code unique among live products only; a deleted code can be reused; bookings keep history.
- WhatsApp share (`src/lib/inventory/whatsapp.ts`): `buildShareMessage()` is plain text with `*bold*` name, Code, Category, Size, Material, Condition, Status (`readyText`), optional Price (`includePrice`; "each" when qty_total > 1), Available N or "Currently sold out", description, then up to 4 picture links last (first link builds the WhatsApp preview card). `waDigits()` normalises Indian mobiles (`[6-9]\d{9}`, optional 0 or 91 prefix) else international `+` numbers 8-15 digits. `waLink()` -> `https://wa.me/<digits>?text=...`; `sharePhotoAndText()` uses the phone share sheet with the actual photo, falling back to `waLink`.

## 7. Key components & lib files

`src/components/inventory/`: StockScreen, ProductCard, ProductDetailScreen, ProductFormScreen, RequestsScreen, sheets.tsx, parts.tsx, ImageUploader, `inventory.module.css`. `src/lib/inventory/`: api.ts, constants.ts (vocabularies and types), errors.ts, filters.ts, format.ts, images.ts, whatsapp.ts. Phone-normalising SQL helper `normalize_lead_phone(text)` (from Exhibition Leads migration) is a hard dependency.

## 8. Decisions made & why

- Public bucket so customers can open pictures from WhatsApp; unguessable paths with no price/customer.
- Reserve-on-request to prevent double promises; `qty_available` computed by DB, never typed.
- Soft delete; code unique among live products only.
- Separate `approve` action (instead of `manage`) so sales see only their own requests.
- Notification trigger sits on `inventory_bookings` (same transaction) rather than app code; booking functions untouched.
- `request_id` idempotency for double taps.

## 9. Known traps, gotchas, unfixed defects

- Adding a migration or module breaks about 15 pin tests (one line each) and the `expenseSurfaces` allowlist (add a set + migration skip + `supabase/tests` regex); a `check (action in (` on a column named `action` is picked up by `orderActivityActions.test` (note `inventory_events.action`).
- Enum first, then code: a missing enum value returns 22P02 for the feed filter. Local replay enums lack five system types (`escalation` etc.); add them locally or the shared feed errors. Local `notifications` has no RLS, prod does.
- Removed pictures stay in storage (no cleanup path) (from memory).
- Public bucket: anyone with a URL can open a picture; do not put customer or price info in paths or images.
- Pane phone-emulation screenshots are cropped; use headless Chrome CDP for mobile checks (from memory).
- Depends on `normalize_lead_phone`, `module_entry_open`, `resolve_permission`, `set_updated_at` (migration begins with a DEPENDENCY MISSING check).
- Phone in bookings must be stored E.164 (`+` prefix) or the CHECK fails; the function normalises first.

## 10. Tests that guard it

- `src/lib/inventory/inventory.test.ts`, `migration.test.ts` (migration contract), `notifications.test.ts`. Run: `npx tsx --test src/lib/inventory/*.test.ts`.
- SQL (disposable DB): `supabase/tests/inventory_module_suite.sql`, `inventory_notifications_suite.sql`.
- Pin tests that enumerate migrations/modules (see traps); `permissions:check` (`npm run permissions:check`) must stay in sync with `modules.ts`.

## 11. Open items / next planned work

- Grant permissions in Control Center (manager five; sales `view`) if not done (unverified).
- Picture cleanup for removed images; storage orphan policy.
- No dedicated docs page exists under `docs/Module Docs` for Inventory (this file is the reference).

## 12. Recheck before changing this module

- Read: `supabase/migrations/20270313000000_inventory_module.sql` (header explains the numbers), `20270314000100_inventory_booking_notifications.sql`, `src/lib/inventory/constants.ts`, `api.ts`, `src/lib/permissions/modules.ts` (inventory block).
- Query: `supabase migration list --linked`; `select * from role_permissions rp join permission_modules pm ... where module_key='inventory'` and `employee_permission_overrides` to see who holds which action.
- Run: `src/lib/inventory/*.test.ts`, `npm run permissions:check`, the two SQL suites on a disposable DB, and the migration-pin tests when adding a migration.

## 13. Two prices (migration 20270408000000, branch feat/inventory-standard-retail-price)

- `inventory_items.price` = STANDARD price (product with basic packaging; column unchanged). New `retail_price` = RETAIL price (taxes, transportation and packaging included), NOT NULL, CHECK `retail_price >= price`; existing rows backfilled retail = price, so the manager must set real retail prices.
- `inventory_save_item` requires both (`price`, `retail_price`); `inventory_bookings_list` returns both. UI shows both everywhere; sort, stats value, booking totals and the WhatsApp "Price" line use the RETAIL price.
- Not yet applied to prod; SQL suites updated but not run (no disposable DB here).
