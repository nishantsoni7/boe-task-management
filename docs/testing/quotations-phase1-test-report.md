# Quotations phase 1: testing report

Branch `feat/quotations-module`, 2026-11-12 (night). Migration `20270614000000_quotations_module.sql`. Dossier `docs/app-context/modules/29-quotations.md`.

## What was built

| Area | What works |
|---|---|
| Module | `quotations` in Control Center (view, create, edit, view_all), Admin only until granted; launcher tile; module shell |
| List `/quotations` | My / everyone's, status filter (Open, Draft, Sent, Negotiating, Confirmed, Lost, Archived, All), search, before-GST value, last client open, New quotation dialog |
| Builder `/quotations/[id]` | Client and project, contact, client type, delivery state → GST type (with a warning when they disagree), room types × rooms, products (picture upload, size in feet and inches with inches shown, material, finish, specification, per-room or fixed quantity, price, GST rate, optional, client and internal notes, move, duplicate, remove with Undo), discount, fabric, packing, transport, notes; live totals; Save (button or Ctrl+S) refused if somebody else saved first; status (sent, negotiating, confirmed, lost with a reason, archive, reopen); history |
| Print `/quotations/[id]/print` | The quotation as the client gets it, room-type totals, GST split, the PI sheet's 7 expectations and 23 terms word for word; Print or save as PDF |
| Client link `/q/[token]` | No login; client-safe fields only; "not active" page when the link is off; records each open (once per 30 min) |
| WhatsApp | Opens WhatsApp with the message and link filled in (wa.me); the salesperson presses send |

## Results

| Check | Result |
|---|---|
| Database, in-memory Postgres (`supabase/tests/quotations_pglite.mjs`, the real migration over Supabase-style default grants) | **20 of 20 checks pass** |
| Arithmetic (`src/lib/quotations/math.test.ts`) | **11 of 11 pass**, including the real Resort Shamshabad quote QT-MVTPTT9W to the rupee: ₹2,01,79,800 + CGST ₹18,16,182 + SGST ₹18,16,182 = ₹2,38,12,164; IGST ₹36,32,364, same total; 669 pieces |
| Printed quotation, registration, privacy (`src/components/quotations/quotations.test.tsx`) | **12 of 12 pass** |
| Full test suite (`npm test`) | **20,537 pass, 0 fail**, 9 skipped (20,546 tests), run from clean after the last code change |
| TypeScript (`tsc --noEmit`) | clean |
| Lint (`eslint .`) | 0 errors, 0 warnings (the one existing warning on main, an unused id map in a test, is fixed in this PR) |
| Production build (`next build`) | passes; `/quotations`, `/quotations/[id]`, `/quotations/[id]/print`, `/q/[token]` compiled |
| Vercel preview build (required check) | see the pull request |

### What the 20 database checks prove

1. Registered with four Admin rows; the picture bucket is public and capped at 3 MB.
2. A person without the grant, or signed out, can neither read nor write.
3. The tables are closed to signed-in and anonymous clients (direct select and insert refused).
4. `quotation_my_access` reports exactly the grants.
5. Numbers are `QT-<initials>-<5 digits>` from 01001; a Rajasthan client starts on CGST + SGST, others on IGST.
6. A blank client is refused; see-all without create cannot start one.
7. A salesperson sees only their own, even when asking for everyone's; see-all sees everyone.
8. Save writes room types and lines in order, linked; the list value is quantity × price without optional lines.
9. Discount, fabric and packing move the value the same way the screen does.
10. A save based on an older copy is refused as stale.
11. Bad input (negative price, two quantities, no quantity, unknown room type, odd GST rate, a path-traversal picture path, zero rooms) is refused and leaves the saved quotation untouched.
12. Another salesperson cannot touch it; see-all alone reads but cannot save; edit + see-all (pricing desk) can.
13. Sharing gives one 32-character link (the same one again) and a draft becomes Sent.
14. The link works without signing in, carries only client-safe fields, and a wrong or injected token shows nothing.
15. An open is recorded once per 30 minutes and shows on the list.
16. Turning the link off closes it at once.
17. Lost needs a reason; Confirmed is locked; only an administrator reopens it.
18. The history records every step and cannot be edited or deleted, even by the table owner.
19. Pictures go only into the uploader's own folder, as .jpg, and only for people who may create or edit.
20. Internal helpers are closed to clients; only `quotation_public` is open to anon.

## Not tested, and why

- **Signed in, in a browser.** No session can sign in from here (passwords are never typed by the assistant), and Vercel previews need their own sign-in. The owner's first look after the migration is the signed-in test.
- **On the real database.** Production reads were refused by the safety check overnight. On 12 Nov the owner applied the migration alone (about 06:00 IST, after a verified backup); `to_regclass('public.quotations')` returned the table and `migration list` shows 20270614000000 remote. No quotation has been made on the real database yet.
- **Picture upload end to end.** The storage policy is proven in PGlite; the browser upload path is the same code Inventory uses (`toJpeg`), but it has not run against the real bucket.
- **Phones.** The screens use the BOE shell and stack at 767 px; not seen on a real phone.

## Morning check (5 minutes, signed in)

1. Open **Modules → Quotations**. If it says "being set up", the migration is not applied yet (steps below).
2. **New quotation**: client "Test client", delivery state Telangana → GST shows IGST.
3. Add a room type "Boho room" × 56, a product "Bed", size 6'0" x 6'6" x 1'6" (shows 72 × 78 × 18 in), quantity 1 per room, price 56000 → line total ₹31,36,000. Add a picture.
4. **Save**. Then **Print / PDF**: the quotation opens with the terms.
5. **Create client link**, open it in a private window: the quotation shows without login. Press **Open WhatsApp with the message** (do not send).
6. Mark it **Archive** when done.

## Applying the migration (done 2026-11-12; kept as the recipe)

Lesson from 12 Nov: run step 3 from a folder whose `supabase/migrations` has the file (the main checkout was on an older branch and `migration repair` failed with "file does not exist"; it worked from the worktree).

`20270610000000` is pending on purpose, so do NOT run a plain `supabase db push` (it would apply that one too). Apply this file alone, as on 11 Nov:

1. Backup: `node "$HOME/BOE-Development/backups/tools/backup-all.mjs"` then `verify-backups.mjs`.
2. Apply alone inside one transaction (a file with `begin;` + the migration + `commit;`) via `supabase db query --linked --file <that file>`.
3. Record it: `supabase migration repair --status applied 20270614000000 --linked`.
4. Confirm: `supabase migration list --linked` shows `20270614000000` with a remote value.

Rollback is in the migration header (drop the four tables, the sequence, the functions, the two storage policies and the bucket, and the registration rows).
