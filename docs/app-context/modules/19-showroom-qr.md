# 19. Showroom QR and Showroom Admin

Verified against checkout `852e0493`. Module key `showroom_qr` (display "Showroom QR"). Closed from the development side on 2026-09-09 (PR #144, `caf614b`); no migration since `20260669`.

## 1. Purpose & users

- Two surfaces in one module:
  - `/showroom/*` = CUSTOMER-FACING and completely UNAUTHENTICATED. A visitor scans the salesperson's QR badge (`/showroom/join?sp=<user uuid>`), types their OWN details, scans product stickers with the phone's native camera (each scan opens a NEW TAB at `/showroom/product/<code>`; there is no in-app camera), builds a project list (cart) and submits an inquiry.
  - `/showroom-admin/*` = authenticated salesperson/admin surface: own inquiries, own QR code, quotation building and PDF, and (for those allowed) Product Master and Categories.
- Users: customers (anonymous), salespeople / showroom teams (department rule), admin.
- Terminology split on purpose: internal screens say "Sales Candidate" (`SALES_CANDIDATE_LABEL`), the customer-facing quotation PDF says "Sales Consultant" (`SALESPERSON_LABEL`). Do not unify.

## 2. Status at commit 852e0493

- SHIPPED and stable. Quotation flow + product-image pipeline (#144), categories (`20260669`), numbering (`20260650`), share token (`20260646`).
- A design gap left explicitly as a product decision: no authenticated in-app scan/cart mirror for salespeople (would be a new page tree).
- Everything under `/showroom-admin` (inquiry list salesperson column, stage labels, Preview vs Generate & Download) was NEVER verified in an authenticated browser session by the agent that built it (from memory); the public flow and `/showroom/share/<token>` were driven in a browser.
- No code path on this checkout sets `showroom_inquiries.quotation_status` to `converted` or `lost` (grep of `src/app/api/showroom` and `showroom-admin` finds only readers; the PATCH route accepts the timestamps `converted_at`/`lost_at`, `shared_at`, `status`, `discount_percent`, `notes`). The dashboard counts `quotation_status === 'converted'` so those states depend on manual DB edits or are unreachable (verify with a DB query before relying on them).

## 3. Pages and API routes

Public pages (`src/app/showroom/`, layout is a bare passthrough: no sidebar, no auth): `/showroom/join` (reads `?sp=`, shows salesperson name, captures customer), `/showroom/scan`, `/showroom/product/[product_code]`, `/showroom/project-list`, `/showroom/done`, `/showroom/share/[token]` (read-only inquiry view for the customer). Client state is in `localStorage`: `boe_sp`, `boe_customer`, `boe_cart` (must survive the new tabs).

Admin pages (`src/app/showroom-admin/`, layout `ModuleGuard moduleKey="showroom_qr"`): `/showroom-admin` (My Inquiries, dashboard counts), `/showroom-admin/inquiry/[inquiryId]` (quotation editor, ~1400+ line page), `/showroom-admin/qr` (My QR Code), `/showroom-admin/products` (+ `new`, `[product_code]/edit`; `ProductTable`, `ProductStepper`, `ProductImagePanel`), `/showroom-admin/categories`. Sidebar (from Master Context): My Inquiries, My QR Code, Product Master (listed as admin only), Back to BOE OS.

API (`src/app/api/showroom/`):

| Route | Auth | Purpose |
|---|---|---|
| `inquiry` GET | bearer; own rows, admin all (`?viewAs=<uuid>` admin only) | list |
| `inquiry` POST | PUBLIC (service role server-side) | create inquiry + items atomically with cleanup fallback; requires `salesperson_id` (uuid, must be an active, non-deleted user), `customer.customer_mobile`, non-empty `cart`; validates quantities |
| `inquiry/[id]` GET/PATCH | bearer; owner or admin | read (three flat queries) / update `status` (new, in_discussion, quotation_sent, closed), `discount_percent` 0-100, `notes`, `converted_at`, `lost_at`, `shared_at` |
| `inquiry-items` POST, `inquiry-items/[itemId]` PATCH/DELETE | bearer; owner or admin | add line; update `quantity`, `rate_override` (positive number or null), `customization_note`; remove |
| `products` GET | bearer | active products for the add-product search |
| `products/by-code/[product_code]` GET | PUBLIC (service role) | one active product for the customer page (now includes `images` and `dimensions`) |
| `salesperson/[user_id]` GET | PUBLIC | returns ONLY the salesperson name |
| `share/[token]` GET | PUBLIC (service role) | public-safe fields only: no salesperson_id, discount or internal notes |
| `quotation/[id]` GET/POST | bearer; owner or admin; `runtime nodejs`, `maxDuration 60` | GET = read-only preview (writes nothing; shows `DRAFT` when `quotation_no` is null); POST = generate PDF, assign `quotation_no`, set `status='quotation_sent'`/`quotation_status='sent'` (only when still `draft`) |
| `admin/products` GET/POST, `[product_code]` GET/PATCH/DELETE; `admin/categories` GET/POST, `[id]` PATCH/DELETE | bearer; admin OR `resolveModuleAccess('showroom_qr', app_modules row, profile, teamFallback)` | product master + categories via SERVICE ROLE |

## 4. Database

Tables (all RLS on):
- `showroom_products`: `product_code` unique, `name`, `category`, `description`, `specifications jsonb`, `image_url` (+ images array and dimensions, `20260647`), `mrp numeric(10,2)`, `is_active`. SELECT only `is_active = true` for authenticated; INSERT/UPDATE admin-only by RLS.
- `showroom_categories` (`20260669`): case-insensitive unique name, `is_active`, admin write/delete policies.
- `showroom_inquiries`: `salesperson_id` (FK users), `customer_name`, `customer_mobile`, `company`, `city`, `project_name`, `lead_source` default 'Showroom QR', `status` in (new, in_discussion, quotation_sent, closed), `discount_percent numeric(5,2)`, `notes`, `share_token` (unique index; `shared_at`) (`20260646`), `quotation_no`, `quotation_status` in (draft, sent, converted, lost) default draft, `quotation_sent_at`, `converted_at`, `lost_at` (`20260648/49`). Policies: select/update by owner or admin, insert only `salesperson_id = auth.uid()`; public flows bypass via service role (no anon policy exists or should).
- `showroom_inquiry_items`: `inquiry_id` (cascade), `product_id`, `quantity > 0`, `mrp_at_time`, `rate_override`, `customization_note`.
- `showroom_quotation_seq (year, last_seq)`; function `get_or_create_quotation_no(p_inquiry_id)` (SECURITY DEFINER, idempotent): format `BOE-QTN-<year>-<NNNN zero padded 4>`, unique index `showroom_inquiries_quotation_no_uidx`. It is a WRITE despite the name. Year = `extract(year from now())` in DB time zone (UTC), so around 31 Dec/1 Jan IST the year may lag by a few hours.
- Entry gates: `20260905000000_module_view_parent_gates.sql` adds module-entry gates on products/categories/inquiries/items (`showroom_qr`).
- Storage: no dedicated bucket in migrations. Product images are PASTED URLs (all 187 production URLs were `https://bestofexports.com/wp-content/uploads/...` on 2026-08-07, 202 products, 184 with images, up to 3 images each, from memory). Env `SHOWROOM_PRODUCT_IMAGE_BUCKET` (default bucket name `products`) and `NEXT_PUBLIC_SHOWROOM_IMAGE_HOSTS` exist for optional storage paths and optimizer host allowlist.
- Registration: `20260645_create_control_center_v1.sql` (app_modules row `/showroom-admin`, department-gated), `20260660_create_permission_engine.sql` (actions `view`, `create`, `edit`, `manage`).

Migrations: `20260643_create_showroom_qr_v1`, `20260646_add_showroom_inquiry_share_token`, `20260647_add_showroom_product_images_dimensions`, `20260648_add_showroom_item_quotation_fields`, `20260649_add_showroom_inquiry_quotation_tracking`, `20260650_add_showroom_quotation_numbering`, `20260669_create_showroom_categories`, `20260905000000_module_view_parent_gates`.

## 5. Permissions & access

- Registered actions: `view`, `create`, `edit`, `manage` (`modules.ts`). Admin UI guard: `ModuleGuard moduleKey="showroom_qr"` = effective `showroom_qr:view`.
- The legacy `app_modules` department rule (sales / showroom teams) still exists and the API routes for product/category admin use `resolveModuleAccess` with a team fallback (`team` containing "sales" or "showroom"). The layout comment says NO `department_permissions` rows were backfilled: confirm that showroom staff hold `showroom_qr:view` explicitly or via the legacy rule.
- Inquiries: owner (`salesperson_id`) or admin only. `?viewAs=` is admin-only (View As).
- CONTRADICTION: Master Context lists "Product Master" as admin only, but `admin/products` and `admin/categories` routes admit any user for whom `showroom_qr` is visible (module access), executing writes with the SERVICE ROLE (RLS admin-only is bypassed). Code is the truth: product master writes are open to all showroom module users, not only admins.
- Public endpoints (inquiry POST, products/by-code, salesperson, share) are unauthenticated by design; they use the service role server-side and return minimal fields.

## 6. Business rules

- Cart: `MAX_ITEM_QUANTITY = 99`, `MIN_ITEM_QUANTITY = 1` (`cart.ts`, `quantity.ts`). Server re-validates quantities (authority test `quantityAuthority.test.ts`).
- Quantity authority on the quotation screen: the DB is authoritative; a typed value is a proposal until the server confirms; an empty or invalid box is never persisted and never discarded.
- Inquiry stage shown to humans (`inquiryStage.ts`, no new DB status): Selecting Products, Quotation Draft, Quotation Sent, Converted, Lost, Closed; `converted`/`lost` always win; `status='closed'` must show as Closed (earlier bug showed "Selecting Products").
- Quotation: line price = `rate_override` if set else `mrp_at_time`; `discount_percent` (0-100) applied to subtotal; PDF footnote "GST @ 18% extra." (`quotationPdf.ts`). `quotation_no` assigned on first Generate; Preview (GET) never increments the sequence and shows DRAFT. POST moves `status` -> `quotation_sent`, `quotation_status` draft -> sent with `quotation_sent_at` only from `draft`. Outcome states are terminal (route refuses to move off anything but draft).
- Quotation images: each image fetched server-side (browser-like User-Agent `BOE-Operating-System/1.0 ...`), resized to ~480 px JPEG q82 (a 1.5 MB PNG became ~80 KB), a failed image shows a labelled placeholder; best effort, so a slow origin once silently produced an imageless PDF until `maxDuration = 60` was set. Credentials (apikey/Authorization bearer service role) are sent ONLY to Supabase hosts (earlier code leaked the service role key to the WordPress host).
- Thumbnails: `ProductThumb` retreats optimized -> original -> placeholder; widths 384 (1x) / 750 (2x) at q55, list thumbs 64/128 at q35; `minimumCacheTTL` 2678400. Hosts allowlist default `bestofexports.com`, `www.bestofexports.com` (`src/lib/imageHosts.ts`, read by `next.config.ts`).
- Salesperson name unresolved reads "Not assigned" on internal screens, em dash handled in PDF path.

## 7. Key components & lib files

`src/lib/showroom/`: cart.ts, quantity.ts, inquiryStage.ts, salesCandidate.ts, quotationPdf.ts (PDFKit), quotationImages.ts, productCode.ts, productLookup.ts, productNav.ts, productCounts.ts, emptyState.ts. `src/components/showroom/`: ProductThumb, WorkflowSteps. `src/lib/imageHosts.ts`. Admin product components in `src/app/showroom-admin/products/`. Admin inquiry page `src/app/showroom-admin/inquiry/[inquiryId]/page.tsx`.

## 8. Decisions made & why

- Customer flow stays unauthenticated; state in localStorage because of new-tab scans.
- Preview is read-only so numbers are not burned (`BOE-QTN-YYYY-NNNN` has no gaps from previews); status writes live only in POST (Generate & Download).
- Pasted-URL images, not a bucket: no upload pipeline exists; therefore host allowlist plus fallback.
- Credential hygiene on image fetch; `maxDuration` on the PDF route; code extracted from the route (911 -> 350 lines) because a Next route file may only export handlers.
- "Sales Candidate" internal vs "Sales Consultant" customer-facing.
- `GET` of salesperson returns name only.

## 9. Known traps, gotchas, unfixed defects

- `get_or_create_quotation_no()` is a write. Never call it from a GET/preview.
- PostgREST schema-cache failures on nested joins: routes use flat queries on purpose; keep that pattern when columns change.
- Optimizer probes can lie for 31 days (cached fallback); repeat measurements, check `x-vercel-cache`, test a second image. The optimizer works on Vercel; sharp failure is local-only. `bestofexports.com` can time out from a dev machine.
- PDF text assertions: PDFKit writes hex strings inside `TJ` arrays; build with `{ compress: false }` and decode hex runs.
- CRLF trap: splicing with node `readFileSync(...,'utf8')` and splitting on `\n` leaves stray CR and silently defeats `core.autocrlf` normalisation; detect with `xxd` on `git show :path`.
- `preview_start` binds to the session's primary directory, not the worktree being edited; verify a string you changed before trusting a browser check.
- Ledger-pin tests and the `expenseSurfaces` allowlist break on new migrations (see other dossiers).
- Public POST has no rate limit / bot protection (unverified beyond reading the validation fragments); `customer_mobile` only trimmed.
- Product Master write access wider than the docs say (section 5).
- Quotation year uses DB time zone.
- No code sets `quotation_status` converted/lost (section 2).
- Showroom admin inquiry page is ~1400 lines; edits there need extra care (`WorkflowSteps` shared).
- Two earlier branch-surgery incidents: re-check `git branch --show-current` before committing; another session can move HEAD.

## 10. Tests that guard it

- `src/lib/showroom/*.test.ts`: cart, emptyState, inquiryStage, productCode, productCounts, productLookup, productNav, quantity, quotationImages, quotationPdf, salesCandidate. Route/source tests: `src/app/api/showroom/inquiry/quantityAuthority.test.ts`, `previewIsReadOnly.test.ts` (pins GET read-only; located near the quotation route).
- Run: `npx tsx --test src/lib/showroom/*.test.ts src/app/api/showroom/**/*.test.ts` (quote bracket paths on Windows; see memory `tsx-test-bracket-path-glob`).

## 11. Open items / next planned work

- One post-deploy usage pass: change a quantity -> Preview -> Generate -> confirm the Sales Candidate is the assigned person (needs an authenticated session).
- Decide whether salespeople need an authenticated scan/cart (product decision).
- Decide how `converted`/`lost` get set (no code path).
- Optional image upload pipeline / bucket.

## 12. Recheck before changing this module

- Read: `src/app/api/showroom/quotation/[id]/route.ts`, `inquiry/route.ts` (public POST), `inquiry/[id]/route.ts`, `src/lib/showroom/quotationPdf.ts`, `quotationImages.ts`, `inquiryStage.ts`, `20260650_add_showroom_quotation_numbering.sql`, `src/app/showroom-admin/layout.tsx`, `src/lib/imageHosts.ts`, `next.config.ts` images section.
- Query: counts of `showroom_inquiries` by `status`/`quotation_status`; distinct image hosts in `showroom_products.image_url`/images; who holds `showroom_qr:view`.
- Run: showroom tests above; open `/showroom/join?sp=<uuid>` and a share link in a browser; generate a quotation PDF and check the number and images.
