# Proposal: show the reviewer what changed between a returned PI and its resubmission

Status: **proposed, not built**. It needs a migration, so it is left for review.
Branch `feat/orders-summary-pi-history` ships only the UI-only first step, described below.

## The problem

When an Admin presses **Needs Changes**, Sales edits the PI and resubmits it. The reviewer then has to
work out what moved. Before this branch, the only account was the Sales reply and an Activity line
"PI replaced".

## What the data holds today (inspected 2026-09-27, local replay of every migration)

| Source | What it records | Gap |
|---|---|---|
| `order_submission_activity` `changes_requested` | who returned it, when, the note | no content |
| `order_submission_activity` `parse_replaced` (every Edit PI on a draft, and every workbook re-upload via Change PI) | `before`/`after` of grand total, total before GST, GST, discount, discount wording, confirmation date, due date, workbook SHA; item and image counts (20270122000000) | **no product lines** |
| `order_submission_activity` `submitted` | the Sales reply (note) | — |
| `order_submission_items` | the lines **as they are now** | the lines at the moment of the return are overwritten |
| `/api/orders/pi-edits` (mode `apply`) | computes a full per-line `diffPi()` and `change_summary` for the edit | **thrown away**, never stored |

So quantity and price changes can be seen today only through the totals they moved.

## Shipped in this branch (UI only, no migration)

`src/lib/orders/resubmissionChanges.ts` finds the latest `changes_requested` before the latest
`submitted`, then compares the first `parse_replaced.before` against the last `parse_replaced.after` in
between. It also lists the other edit events in between (client details, internal details, …). The
PI Draft page shows this beside the Sales reply as **What changed since it was returned**, for a PI
that is with the reviewer.

The panel says plainly that product quantities and prices are not recorded separately. Nothing is
written, and the audit trail is read only.

## Proposed design for line-level changes

### Recommended: snapshot at the return (option B)

1. **New append-only table** `public.order_submission_return_snapshots`
   - `id uuid pk`, `submission_id uuid not null references order_submissions(id) on delete cascade`,
     `activity_id uuid not null unique references order_submission_activity(id)` (the `changes_requested` row it belongs to),
     `taken_at timestamptz not null default now()`,
     `items jsonb not null` (for each line: id, item_sequence, source_product_code, product_name, quantity,
     cost_per_piece, total_amount, dimensions, material, customization, sort_order),
     `figures jsonb not null` (the same keys `parse_replaced` records), `terms jsonb not null`
     (client city, fabric responsibility, commercial terms note, billing %).
   - Bounded: at most the PI's own line count; no images (their SHAs are already in the trail).
2. **Written only by `request_order_submission_changes()`**, inside the same transaction as the
   `changes_requested` activity row (a SECURITY DEFINER function, `search_path = public, pg_temp`,
   following the 20270120 definer audit). No client writes: `revoke insert, update, delete` from
   `anon`, `authenticated`, `service_role` (no update or delete for anyone), plus a trigger that refuses
   UPDATE and DELETE except through the existing cascade.
3. **RLS select** = `can_view_order_submission(submission_id)`: exactly the people who can already
   read the PI and its lines, so nobody new sees anything.
4. **The page** reads the snapshot for the latest return and diffs it against the current lines with
   the existing `normalizePi()` / `diffPi()` / `PiDiffView`. That is the same comparison an Admin
   already reads for a revised PI on an Order: lines added and removed, quantity, price and line total
   before and after, and text changes.
5. **Back-fill:** none. A return that happened before the migration has no snapshot, and the page falls
   back to the totals panel shipped now.

Why B rather than A (below):
- It covers **every** way a returned PI can change (Edit PI, Change PI workbook re-upload, the
  per-field editors, an Admin amendment), not just the route that computes a diff.
- It trusts nothing the browser or API sends: the database copies its own rows.
- The trail itself is not changed.

### Alternative: record the diff with each edit (option A)

Extend `replace_order_submission_parse` to accept a bounded `change_detail` array in its payload and
store it in the `parse_replaced` metadata. It is smaller, but it relies on the API's computed diff and
misses edits that do not go through that route. **Not recommended.**

### Delivery checklist (for whoever builds it)

- Migration `2027xxxxxxxxxx_order_submission_return_snapshots.sql`, plus its down-script from the
  #209 generator.
- The migration inventory suites (about 11 pins move with one new migration; see
  `docs/testing`), the definer `pg_temp` audit, and the anon-lockout checks.
- SQL suite:
  - exactly one snapshot per return
  - the snapshot is readable by owner, reviewer and approver, and by nobody the PI is hidden from
  - UPDATE and DELETE are refused
  - a resubmission without an edit shows no line changes
- Render test for the panel's line section; the existing totals fallback stays covered.
- Dry-run `db push` against a local copy of production history before release.
