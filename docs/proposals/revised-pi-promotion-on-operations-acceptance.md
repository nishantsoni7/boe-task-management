# Revised PI (V2+): promote on Operations acceptance, not on Admin approval

> **Status: PLAN ONLY — nothing here is implemented.** This file is the
> migration/RPC plan and the test matrix for the part of the Order document
> lifecycle that was deliberately left out of PR #202. No migration, RPC,
> route or screen changes in this PR.

## 1. The problem, stated exactly

Today a revised PI goes live the moment an administrator approves it:

```
propose_order_pi_revision()                      V2 'pending'
POST /api/orders/pi-revisions/approve            admin only; takes the processing lease
  └ processUnderLease (process-draft/route.ts)   parses the workbook, uploads images
      └ approve_order_pi_revision()              (latest: 20261229000000_order_operations_handoff.sql:677)
          ├ replace_order_submission_parse()     REWRITES the Order: client_name, confirm_date,
          │                                      due_date, total_value, total_product_value,
          │                                      billing_percentage; deletes + reinserts the
          │                                      submission's items (cascading their images);
          │                                      supersedes generated documents
          ├ V1 → 'superseded', V2 → 'approved'   the version in force changes here
          └ assign_order_product_codes()
      ├ step 18b seed_order_submission_pi_terms  (after commit)
      └ step 19 removeObjects(obsolete images)   DELETES V1's product images from storage
order_pi_versions_record_operations_handoff      trigger on 'approved' → awaiting handoff for V2
decide_order_operations_handoff()                Operations accepts / flags — AFTER the fact
```

The requirement is the opposite order: Operations must see the proposed V2
beside the accepted V1, and only Operations acceptance may promote V2 and its
commercial data. While V2 is pending or rejected, V1 and the Order's current
figures, lines, pictures, codes, documents and payment position must stay
usable.

## 2. What the trace found (all readers of the "current" PI)

| Reads | From | Effect of deferring the apply |
|---|---|---|
| Current PI version | `order_pi_versions` status `approved` (partial unique index `order_pi_versions_one_current_per_order`), `orderPiVersions.ts`, `orderMainPi.ts`, page.tsx, `submissions/notify` route | Must learn a new intermediate status |
| Order figures | `orders.total_value` / `total_product_value` / dates — Order page finance position, `orderAdvance`, `AllocatePaymentModal`, dashboards, `/orders/all`, Action Queue, amendments | Unchanged until acceptance — correct |
| Product lines + pictures | `order_submission_items` / `_item_images` keyed by the SUBMISSION (one set per PI, overwritten by a revision) — Order page, documents route, PDF | Must NOT be overwritten at admin approval |
| Product codes | `order_product_codes` (FK `on delete set null`) | Assigned only at apply |
| Handoff / alignment | trigger on `order_pi_versions` status `approved`; `decide_order_operations_handoff` requires the version to be `approved` | Trigger + decision door must accept the new status |
| History | `orderHistory.ts`, `operationsHandoff.ts` event words | New events |

**No copy of V1's parsed lines survives a V2 apply**, and the parsed V2
payload exists only in route memory between parse and RPC. Re-parsing later
is not reproducible (the fingerprint includes `savedOn` and a salesperson
lookup; a parser deploy can change the result), and the operations reviewer
cannot take the processing lease (`assert_order_submission_workbook_editor`
is admin-only after draft). Therefore: **stage the parse at admin approval,
apply it at operations acceptance.**

## 3. Design: stage at Admin approval, apply at Operations acceptance

### 3.1 Schema (one new migration, additive)

1. `order_pi_versions.status` CHECK gains **`admin_approved`**; the
   `decision_complete` check requires `decided_by/decided_at` for it; new
   nullable `applied_by uuid`, `applied_at timestamptz`.
2. `order_pi_versions_one_pending_per_order` widens to
   `status in ('pending', 'admin_approved')` — still one open revision.
3. New table **`order_pi_revision_staged_parses`**: `version_id` (PK, FK),
   `payload jsonb` (the exact `processUnderLease` payload, token removed),
   `fingerprint text`, `seed_terms jsonb`, `image_paths text[]`, `staged_by`,
   `staged_at`, `applied_at`. Service-role write only; append-only guard;
   RLS read for whoever can open the Order (reviewer diff view).

### 3.2 Functions (re-emitted word for word except where stated)

| Function | Change |
|---|---|
| `order_pi_versions_guard` | allow `pending→admin_approved`, `admin_approved→approved`, `admin_approved→rejected` |
| `approve_order_pi_revision` | same checks and lock order; **stores the staged payload and sets `admin_approved`**; does NOT call `replace_order_submission_parse` or `assign_order_product_codes`; V1 stays `approved` |
| `order_pi_versions_record_operations_handoff` | fires on `admin_approved` for V2+ (records the V2 handoff, supersedes V1's handoff, does **not** reset alignment — V1 is still in production); idempotent when the same version later becomes `approved` |
| `replace_order_submission_parse` | accepts a transaction-local marker `boe.pi_revision_apply_id = <submission id>` (the `in_pi_submission_approval` pattern): with it, skips the lease-token check (refusing if a fresh lease is held, 55P03) and the admin-editor assertion; logs the reviewer as actor |
| **new** `apply_order_pi_revision(version_id, actor)` | internal, definer, no client grant: Order not cancelled; locks submission + versions; sets marker + amendment context; applies the staged payload; supersedes V1; V2 → `approved` with `applied_by/at`; assigns codes; applies staged seed terms; logs `pi_revision_applied` |
| `decide_order_operations_handoff` | stale check accepts `admin_approved`; `accepted` on an `admin_approved` version calls `apply_order_pi_revision` **before** writing the handoff decision; a flag on a not-yet-applied version does not touch alignment |
| `reject_order_pi_revision` | also `admin_approved → rejected` (staged parse kept as history, never applied) |
| `propose_order_pi_revision` | refusal message mentions a revision awaiting operations |
| `update_order_submission_client_details` / item edits / process-draft "Change PI" | refuse while a version is `admin_approved` (the staged payload would silently overwrite them) |

**Lock order** at acceptance: reviewers (SHARE) → orders (FOR UPDATE) →
submission (FOR UPDATE) → versions → handoff. Admin approval unchanged.
`set_order_operations_reviewer` still takes the reviewer row first → no cycle.
(Separately noted: the plain admin "Change PI" path locks submission → orders
today, the reverse of `approve_order_pi_revision`; fix in the same migration.)

### 3.3 Route and screens

* `pi-revisions/approve` route / `processUnderLease` in **staging mode**:
  lease, parse and image upload as today (content-addressed keys, V1's objects
  untouched); call the re-emitted RPC; **skip step 18b and step 19** (no V1
  image deletion). A later service-role sweep may remove images no row cites.
* `orderPiVersions.ts`: `admin_approved` status, label "Approved by Admin —
  awaiting Operations", amber tone; Main PI card keeps V1 as current and shows
  V2 as a separate pending proposal.
* Operations review: V2 workbook beside V1 plus a **commercial difference
  table** computed from the staged payload vs the Order (client, value, dates,
  lines added/removed/changed quantity or rate). Material differences are
  stated in the Accept dialog; acceptance applies them through the amendment
  context (the existing amendment rule), so there is still one source of truth.

## 4. Test matrix (to be written with the implementation)

SQL, on a disposable stack (`supabase/tests/run_revised_pi_promotion_local.sh`):

1. Admin approval → V2 `admin_approved`; Order figures, items, images, codes,
   generated documents, payment position **unchanged**; V1 still `approved`.
2. Handoff for V2 recorded at admin approval; alignment not reset; reviewer notified once.
3. Operations accept → staged payload applied in one transaction: figures,
   items, codes, V1 `superseded`, V2 `approved`, `pi_revision_applied` event.
4. Operations flag → nothing applied; V1 remains; reason visible.
5. Admin reject of an `admin_approved` V2 → `rejected`; nothing applied.
6. Stale tab: accepting a superseded/rejected V2 refused; double accept refused; no double apply.
7. Admin edit paths refused while V2 is `admin_approved`.
8. Permission: non-reviewer, admin-not-reviewer, anon — refused at the RPC.
9. Reassignment during an `admin_approved` V2 (both orders, two sessions — extend `run_order_operations_handoff_race.sh`).
10. **Order 0524 / legacy**: an Order with no handoff and the 0524 backfilled
    V1 handoff keep working; `20261230000000` assertions still pass.
11. The old path (a V2 already `approved` before the migration) is untouched.

TypeScript: `piRevisionApproveRoute.test.ts`, `processDraftRoute.test.ts`
(step 18b/19 skipped in staging mode), `orderPiVersions` view tests, the three
migration inventories.

## 5. Why this is not in PR #202

It re-emits seven live functions on the Orders/PI chain (including the one
`approve_order_submission` / Order 0524 path depends on), changes a Next route
that holds a processing lease, and alters when product images are deleted.
Doing it safely needs its own review, its own race tests and its own rollout
freeze — the same treatment `20261229000000` received. Until it lands, the
production behaviour is unchanged: an admin-approved revised PI is in force
immediately, and the Order page says so in words ("PI V2 is approved by Admin
and in force; Operations has not accepted it yet").
