# Quotations phase 2 (Confirm → PI draft): testing report

Branch `feat/quotation-confirm-pi-draft`, 2026-11-12. Migration `20270615000000_quotation_pi_link.sql`. Dossier `docs/app-context/modules/29-quotations.md`.

## What was built

| Area | What works |
|---|---|
| PI draft card on the builder | On a Sent or Negotiating quotation: what blocks a PI, product by product (name, quantity, price above ₹0, picture); "Confirm → make PI draft"; progress (pictures, starting, storing, Orders checking, linking); then the PI draft opens. A linked quotation shows its PI draft and Open. |
| Download in PI format | The same workbook as a .xlsx file, from any saved quotation with products. |
| The PI it makes | One row per non-optional product: "Room type · Product", quantity per room × rooms (or the fixed number), size, material, picture, price; finish, specification and client note in Customization; discount as an amount; fabric, packing, transport in the footer; one GST figure; client, phone, project and state in Bill To / Ship To; the salesperson in Created By. |
| Database | `quotation_link_pi` links the quotation to the caller's own new PI draft and marks it Confirmed; `quotation_get` shows the PI; history "Confirmed into PI draft PID-…". Orders is not changed. |
| Fix | A 0% GST product no longer reads back as 18%. |

## Results

| Check | Result |
|---|---|
| The PI workbook read back by the REAL PI parser (`src/lib/quotations/piWorkbook.test.ts`) | **5 of 5 pass**: the real Resort Shamshabad quote QT-MVTPTT9W gives 16 products with quantities 18 (Corporate room × 18 rooms), 56 (Boho room × 56), 112 (2 per Boho room) and 39 (fixed), its prices, ₹2,01,79,800 before GST, IGST ₹36,32,364, ₹2,38,12,164 grand total, every picture mapped, **no blocking issue and no warning**; discount, fabric, packing and transport add up; 85 products (footer moved) read; mixed GST rates; blockers named line by line |
| Database, in-memory Postgres (`supabase/tests/quotations_pglite.mjs`, both migrations) | **25 of 25 pass** (phase 1's 20 now on the phase 2 schema, plus: somebody else's or a non-draft PI refused, a Draft quotation refused, a person who may not edit refused; link + Confirmed + history; same call twice returns the same; one PI per quotation; a deleted PI clears the link; closed to anon and never on the client link) |
| Quotation screens and arithmetic (`quotations.test.tsx`, `math.test.ts`) | pass (with the 0% GST check) |
| Full test suite (`npm test`) | **20,542 pass, 0 fail**, 9 skipped (20,551 tests; 5 more than phase 1) |
| TypeScript (`tsc --noEmit`), lint (`eslint .`) | clean; 0 errors, 0 warnings |
| Production build (`next build`, placeholder public Supabase settings) | passes; the four quotation routes compiled |

## Not tested, and why

- **End to end on the real Orders server** (`create_order_submission`, the upload into `order-files`, `process-draft`): it needs a signed-in person with Order Management → Create, and no session can sign in from here. The server re-reads the same workbook with the same parser the test uses, so a refusal there would be a stored-picture or permission problem, not the workbook.
- **Real photographs.** The tests use invented JPEG bytes (the PI tests' own rule); real pictures are the same JPEGs the quotation already stores.

## Live check (5 minutes, signed in, after the migration)

1. Open a test quotation, add a picture to every product, Save, mark it **Sent**.
2. Press **Download in PI format**: the .xlsx opens in Excel with the products, pictures and footer.
3. Press **Confirm → make PI draft**: the PI draft opens in Orders with the products, quantities, prices and pictures; the quotation shows Confirmed and "Open the PI draft".
4. In PI Drafts, discard the test draft. The quotation's link clears by itself.

## Applying the migration

**Before the merge** (it only adds; the live phase 1 screens ignore it; merged first, a Confirm before the apply would make a PI draft that cannot be linked). As phase 1, ALONE (20270610000000 stays pending on purpose; no plain `db push`): backup, then `supabase db query --linked --file` with `begin;` + the file + `commit;`, then `supabase migration repair --status applied 20270615000000 --linked` **from a folder whose `supabase/migrations` has the file**, then `supabase migration list --linked`.
