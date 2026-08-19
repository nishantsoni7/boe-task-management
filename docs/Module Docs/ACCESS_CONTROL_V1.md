# Access Control V1

Status: **shipped and enforced end to end (2026-08-15).** Migrations
`20260901000000` through `20260907000000` are applied to production and verified
read-only. Module entry is now gated in the launcher, in the route guards AND in
the database, and `task-attachments` is private. See
[Closing the parent gate](#closing-the-parent-gate-2026-08-15).

One screen decides what every employee can reach: **Control Center → Access
Control**. It replaced two parallel administrator workflows that could disagree
with each other — Module Visibility (`app_modules`) and Access Control (the
permission engine).

---

## The workflow

Select an employee → see their module list → switch a module on or off → choose
an access level → open Custom only when individual permissions are needed →
review → Save.

That is the whole thing. There are no role templates, no department-role
editors, no scopes, no approval chains, no access-history screen, and no
permission export. Those were considered and deliberately left out of V1.

---

## The five levels

Defined once, in [`src/lib/permissions/levels.ts`](../../src/lib/permissions/levels.ts),
and shared by the screen, the API and the tests.

| Level | Grants |
|---|---|
| **No Access** | nothing — the module is hidden and the route denied |
| **Viewer** | `view` |
| **Contributor** | `view`, `create`, `edit` |
| **Manager** | `view`, `create`, `edit`, plus `approve` and `export` **where the module registers them** |
| **Custom** | exactly the actions the administrator ticks |

A level never invents an action the module does not have. On a module with no
`approve`, Manager and Contributor are the same set, and the screen reports the
lower of the two.

### Protected permissions are Custom-only

`delete` · `admin` · `manage` · `assign` · `dispatch` · `receive` · `mark_lost` ·
`close` · `can_be_order_assignee` · `view_all` · `view_quotations` ·
`manage_quotations` · `approve_order` · `approve_advance_exception` ·
`allocate` · `allocate_correct`

No standard level grants any of these, at any module, ever. They exist because
each one is a decision somebody should have to make on purpose — handing out a
laptop (`assign`) is not the same authority as writing one off (`manage`), and
reversing a payment is not the same as approving one.

**Choosing a standard level clears them.** This is the correction to the first
draft of V1, which carried them through a level change on the reasoning that a
level "has no opinion" about them. That was unsafe in the direction that
matters: an administrator moving somebody *down* to Viewer would have believed
they had reduced that person to read-only while `manage` or `assign` quietly
survived. The screen now names what will be removed and waits for confirmation:

> Changing to Viewer will remove: Assign assets and Manage

Anyone holding a protected action therefore reads as **Custom**, and no preset
matches them, so loading the page can never silently reclassify them.

---

## Module access on/off

The switch on each row is a shortcut into the same per-action state the level
selector writes — **not** a second authority:

- **Off** → No Access (every action denied)
- **On** → Viewer, from which a level is chosen

There is no separate visibility boolean and nothing extra is saved. Because the
level is derived back out of the same state, the switch and the selector cannot
disagree. Turning a module off that holds protected actions names them and asks
first, exactly as a standard level does.

---

## Default-deny

A new employee receives **no optional-module access**. Access is granted per
person; nothing arrives by virtue of a role.

Meetings was the exception and is being closed: it seeded `role_permissions` for
`member` (view) and `manager` (view/create/edit/manage), which made it visible
to all 21 active employees. `20260902000000` removes those defaults and re-grants
the same access as explicit per-employee overrides to the eleven active real
employees who hold it today, so nobody loses access on the day it lands and the
*next* employee inherits nothing. Nine `(DUMMY)`/`Objection` test accounts are
deliberately excluded.

### Test accounts hold nothing by default

Owner decision, 2026-08-14. Test and objection accounts carry **no operational
access** in their default state — not "no protected access", none.

`20260902000000` revokes all five of Test Sales User (DUMMY)'s stored Orders
grants: `view`, `create`, `edit`, `approve`, `manage`. An earlier draft removed
only `approve` and `manage`, reasoning that `20260901000000` leaves
view/create/edit inert. That reasoning was overruled, and correctly: an inert
grant is still a stored decision, and the migration that eventually wires up
Orders `view`/`create`/`edit` would make it live without anyone re-reading the
compatibility file.

These accounts are **not deactivated and not deleted**. They may be granted
temporary explicit permissions later for a specific controlled test. What
changes is the default they return to.

### Masked impact — before and after `20260902000000`

Real employees are masked; the test accounts are named because the decision is
about them. "Effective" means what `resolve_effective_permissions` returns
across employee override → department → role → system default.

| Account | Orders before | Orders after | Meetings before | Meetings after |
|---|---|---|---|---|
| Employee A *(manager, Finance/Orders owner)* | view, create, edit, approve, export, delete, manage | **unchanged** | view, create, edit, manage *(role)* | view, create, edit, manage *(override)* |
| Employee B *(Assets `assign` holder)* | — | — | view *(role)* | view *(override)* |
| Employees C–F *(Contributor-level Finance/Orders)* | view, create, edit | **unchanged** | view *(role)* | view *(override)* |
| Employees G–K *(remaining active real staff)* | — | — | view *(role)* | view *(override)* |
| **Test Sales User (DUMMY)** | view, create, edit, approve, manage | **none** | view *(role)* | **none** |
| **8 other (DUMMY)/Objection accounts** | — | — | view *(role)* | **none** |
| Future employee *(created after this lands)* | — | — | view *(role)* | **none** |
| System Administrators | full *(admin role)* | **unchanged** | full *(admin role)* | **unchanged** |

Net: 14 Meetings override rows replace the two role defaults; five Orders
overrides are soft-revoked on one test account; **no real employee loses
anything**. Every row above is reversible — see the rollback plan at the foot of
the migration.

---

## System Administrators

`users.role = 'admin'` is the authority. Every module guard, RPC and policy
short-circuits on it, so an override saved on this screen could neither add to
an admin's authority nor reduce it — it would only look as though it had.

When an Administrator is selected the row set is locked, the toggles and level
selectors are disabled, and `save()` refuses to build a request. This protects
**every** admin, not only the person doing the editing. Control Center itself
remains admin-only.

## Inactive and deleted users are denied

Both branches of `actor_has_module_permission` require an **active,
non-deleted** user — the admin short-circuit included.

That last part is a correction. The checks the migration replaced tested only
`role = 'admin'`, and mirroring them exactly would have let a deactivated or
soft-deleted admin keep Finance and Orders authority. Deactivating an account
does not end its Supabase session (`/api/control-center/modules/[key]` already
says so), so "they cannot log in anyway" was never a defence.

Denied: null `auth.uid()`, missing user row, inactive or deleted member,
manager, or admin. Allowed: an active admin, and an active employee holding the
exact module/action.

---

## Attendance & Payroll

One row, and it is **not editable**.

The launcher shows Attendance and Payroll as a single card, and their management
surface is admin-only by an explicit product decision that no grant on this
screen can change — see `SELF_SERVICE_MODULE_KEYS` and `resolveManagementAccess`
in [`src/lib/moduleAccess.ts`](../../src/lib/moduleAccess.ts). Rendering two
rows of Viewer/Contributor/Manager controls would be a lie: every switch would
save a row that decides nothing.

So the row says what is true — *"Employees can view their own attendance and
payroll and raise issues. Management access is restricted to system
administrators."* — and nothing on this page writes an attendance or payroll
override.

`/my-attendance` and `/my-payroll` are unchanged and remain served by APIs that
derive the employee from the bearer token, so a cross-employee read is
inexpressible rather than merely refused. Imports, corrections, generation,
adjustments, lock/unlock and settings all remain admin-only.

If an inert Attendance or Payroll override is found on an employee, the row
displays it as *"Unused permissions on record"* and leaves it exactly as it is.
It is not activated and not silently removed.

---

## Finance and Orders enforcement

Before `20260901000000`, both modules let a person *in* and then gated every
control on `users.role === 'admin'` — in the screen, in the RLS policies, and
inside the `SECURITY DEFINER` functions. Stored grants decided nothing. That is
why Dhruv held every Finance and Orders permission and still could not see the
admin options.

| Action | Finance | Orders |
|---|---|---|
| Approve / reject | `finance.approve` | `orders.approve` |
| Correct, reverse, link, unlink | `finance.manage` | — |
| Administrative management | — | `orders.manage` |
| Delete | `finance.delete` | `orders.delete` |
| View / create / edit | **unchanged — ownership** | **unchanged — admin-or-assigned** |
| Export | no server path exists; not exposed | same |
| Assignee eligibility | — | `can_be_order_assignee`, never implied |

`view`, `create` and `edit` were deliberately left alone. Turning every stored
`finance.edit` row into company-wide edit authority is exactly the silent
widening the migration exists to avoid.

---

## Legacy `app_modules`

Still present, still read. Showroom QR's department rule and the
Attendance/Payroll self-service cards depend on it. Nothing was dropped; the
table, its columns, the API routes and the tab implementation all remain, and
`?tab=modules` still resolves for rollback. What changed is that it is no longer
presented as a workflow an administrator is meant to use.

Modules that still depend on it are labelled honestly in Access Control rather
than being routed through the permission engine.

---

## Enforcement labels

The screen states what the engine actually decides, per module, from
[`src/lib/permissions/enforcement.ts`](../../src/lib/permissions/enforcement.ts):

| Label | Meaning | Modules |
|---|---|---|
| **Active** | every registered action is checked | Assets & Access, Meetings |
| **Partly active** | some actions checked, the rest inert | Orders, Finance, Sample Tracking, Task Management |
| **Prepared** | saved, nothing consults it yet | Showroom QR, Employee Records, Performance |
| **Not used** | governed by the admin role by design | Attendance, Payroll |

A single enforced/not-enforced flag could not describe Orders, and had already
gone stale on Meetings. The distinction matters: on 2026-07-16 ten employees
were granted Assets permissions while nothing consulted the engine, and
`20260721000000` then made them all live at once — `20260723000000` exists to
undo it.

---

## Protected visibility actions (`20260903000000`)

Three protected, Custom-only actions. None is granted by Viewer, Contributor or
Manager, and none is granted to anybody by the migration that registers them.

| Action | Module | Means |
|---|---|---|
| `view_quotations` | Task Management | View quotations and quoted prices |
| `manage_quotations` | Task Management | Create, edit, approve or share quotation information |
| `view_all` | Order Management | View all company orders |
| `view_all` | Finance | View all company payments and finance information |

`view_all` is **one action key registered against two modules**. The engine
scopes every grant by `(module_id, action_id)`, so Orders and Finance are
granted independently and neither implies the other.

**Dependencies**, enforced in the Access Control save path and again when
capabilities are derived: `manage_quotations` → `view_quotations` → `view`, and
`view_all` → `view`. Removing a parent removes its dependants, through the same
protected-permission confirmation as any other removal.

### The defect this corrects

`orders.view` did not mean what the screen said it meant. `20260685000000` and
`20260686000000` each added a SELECT policy of the form

```sql
USING (resolve_permission(auth.uid(), 'orders', 'view'))
```

on `orders` and `order_activity_log`, so **any** employee granted Order
Management entry could read **every order in the company**. Those migrations
were fixing a real defect — a granted employee saw zero rows — but they fixed it
by opening the whole table rather than by adding an entry permission. Module
entry and company-wide sight are two decisions, and `20260903000000` separates
them: both policies now require `view_all`, and `view` falls back to the three
ownership policies from `20260655_create_orders.sql` (admin, operations team,
requester/assignee).

This is a **narrowing**. Anyone holding `orders.view` without `orders.view_all`
loses company-wide sight. There are deliberately no compatibility grants.

Finance was never built that way — its SELECT policies are ownership-based
(`20260628000200`, `20260674`, `20260699000000`, `20260707000000`) — so
`finance.view_all` is purely **additive** and no existing Finance policy is
touched. `orders.view_all` therefore reveals no price, payment or finance record
on its own, structurally rather than by convention.

### Full coverage — every table each `view_all` reaches

`20260903000000` creates nine SELECT policies. All are `FOR SELECT`; none adds
create, edit, approve, manage, delete or export anywhere.

| Table | Gate | Kind |
|---|---|---|
| `orders` | `orders.view_all` | repointed from `view` |
| `order_activity_log` | `orders.view_all` | repointed from `view` |
| `order_requests` | `orders.view_all` | added |
| `order_request_activity` | `orders.view_all` | added |
| `order_request_attachments` | `orders.view_all` | added |
| `order_change_requests` | `orders.view_all` | added |
| `finance_payment_requests` | `finance.view_all` | added |
| `finance_payment_request_activity_log` | `finance.view_all` | added |
| `payment_proof_attachments` | `finance.view_all` | added |
| `finance_payment_allocations` | `finance.view_all` | added by `20260918000000` |

## Payment allocation actions (`20260918000000`)

Two protected Finance actions, added with the allocation foundation:

| Action | Module | Grants |
|---|---|---|
| `allocate` | Finance | Allocate part or all of a **verified** payment to a PI submission or a Confirmed Order |
| `allocate_correct` | Finance | **Reverse** an allocation that has already been recorded |

They are independent of each other and of `finance.approve` **in every
direction**, because they are three different jobs: `approve` says the money
arrived (payment *verification*), `allocate` says which piece of business it
belongs to, and `allocate_correct` undoes that. A person may hold any one
without the others.

`default_allowed` is false on both rows, no `role_permissions` row carries
either, and the migration asserts at apply time that it granted them to nobody —
so they arrive only through an explicit per-employee grant, or through the
established active-admin bypass in `actor_has_module_permission`.

Neither confers any visibility. `allocate` holders still have to be able to see
the PI or Order they are naming; `allocate_payment_to_target()` checks that
server-side, accepting the target's own participant rule **or**
`finance.view_all`, so a Finance allocator does not need Order Management access
to do their job.

**`finance_payment_allocations` carries NO Finance module entry gate**, unlike the
other three Finance tables. The confirmed rule is that a salesperson sees the
money attached to a PI or Order they uploaded or own *without* holding Finance
access, and a RESTRICTIVE gate ANDs onto every permissive policy — it would have
hidden a person's own record's payment from them. Nothing is widened: each
permissive SELECT policy carries its own complete authority, and both participant
branches still require Order Management entry and still resolve to a record the
caller can already open. Reading an allocation grants no `allocate`, no
`allocate_correct`, no verification authority and no Finance page.

**Required Phase 2 dependency.** `finance_payment_requests` is not widened, so a
PI owner without Finance access can read the allocation but not the payment row
behind it. The payment-card phase must add the matching participant SELECT policy
to the parent table.

---

The split is the point: **order request attachments are operational documents**
(PI, reference files) and follow Orders; **payment proof attachments are
financial** and follow Finance. So `orders.view_all` reaches every operational
child record and stops precisely at the money.

`order_requests` has no UPDATE policy for any role by design — all mutation goes
through `SECURITY DEFINER` RPCs — so a SELECT policy cannot widen write
authority there. Amending an order still requires `orders.manage` through
`assert_order_amender` (`20260901000000`), untouched here.

A post-condition asserts all nine exist, that no Orders policy still resolves
plain `view` for company-wide sight, and that **no Finance policy can be
satisfied by an Orders grant**.

### The task security boundary (production-observed, 2026-08-14)

The migration history is **incomplete** for the task tables: `tasks` and
`task_activity_log` were created in the original Supabase setup, before
migrations began, so their RLS lives only in the database. Read directly from
production rather than inferred from the repository:

| Table | RLS | SELECT policy |
|---|---|---|
| `tasks` | **enabled** | `auth.uid() = created_by OR auth.uid() = assigned_to OR auth.uid() = delegated_by` |
| `task_activity_log` | **enabled** | same boundary, via the parent task |
| `task_attachments` | enabled | **was `USING (true)`** — every attachment in the company, readable by every account |

**There is no company-wide quotation exposure through `tasks` or
`task_activity_log`.** Both are correctly ownership-scoped. An earlier draft of
this document speculated that `tasks` might lack RLS; that was wrong and has
been removed.

`task_attachments` was the real defect, and `20260903000000` closes it: an
attachment is now readable only by someone who may read its parent task, through
either parent (`task_id`, or `activity_log_id` → `task_activity_log.task_id`).
The write policies are untouched.

> **No admin branch, deliberately.** The production `tasks` policy has no admin
> branch — a System Admin has no company-wide task read through RLS. Adding one
> to the attachment policy would grant *new* authority and leave the child
> broader than its parent, which is the defect being fixed. Admin task tooling
> that needs more already runs with the service role.

### ~~⚠ Storage: the files themselves are still public~~ — CLOSED 2026-08-15

**Resolved by `20260906000000` + `20260907000000`.** The bucket is private, the
blanket read policy is gone, and every read is a short-lived signed URL. The
audit below is kept as the record of what was wrong; see
[Closing the parent gate](#closing-the-parent-gate-2026-08-15) for the fix.

**The RLS fix secures the index, not the bytes.** Audit result:

| Question | Answer |
|---|---|
| Bucket | `task-attachments` |
| Public? | **`public = true`** (`20260607000000`) |
| `storage.objects` SELECT policy | `public_read`: `USING (bucket_id = 'task-attachments')` — **no `TO` clause, so it includes `anon`** |
| Stored value | **a full public URL** via `getPublicUrl`, in `task_attachments.url` |
| `storage_path` column? | **None** |
| Shared with other modules? | **No** — 8 call sites, all task code |
| Upload / delete | client `.upload(path, file)`; `auth_delete` restricts deletes to the uploader |

Every other attachment bucket in this system — `asset-documents`,
`order-request-attachments`, `payment-proofs` — is private and stores a
`storage_path` signed on demand via `createSignedUrl`. `task-attachments` is the
only one that does not.

**Consequence:** anyone holding or guessing a file URL can still retrieve the
file **without authenticating**. `20260903000000` stops an employee from
*enumerating* attachments they shouldn't see; it does not stop retrieval of a
URL already known. **Do not describe task attachments as secured until the
bucket is private.**

**Why it was not converted here.** The blocker is not sharing — the bucket is
exclusive to tasks. It is that `task_attachments.url` stores a *public URL* and
there is no path column. Flipping the bucket to private would break every
existing production file immediately, because nothing can be signed from a
stored URL. A safe conversion is its own migration:

1. Add `task_attachments.storage_path`.
2. Backfill it by parsing the object path out of each stored public URL, and
   verify every row parsed before continuing.
3. Move the 8 call sites to `createSignedUrl`, keeping the public URL as a
   fallback while both work.
4. Flip the bucket to `public = false` and replace `public_read` with a policy
   scoped to the parent task.
5. Drop the fallback.

Steps 1–3 are backward-compatible and can ship first; only step 4 is the cutover.

### Approved access configuration (owner, 2026-08-14)

Applied by `20260903000000` as **employee overrides**, in the same transaction as
the Orders narrowing, so nobody loses access in between. No role or department
grant is written, so the owner can change any of it later through Access Control
→ Custom without another migration.

| Person | `orders.view` | `orders.view_all` | `finance.view` | `finance.view_all` |
|---|:--:|:--:|:--:|:--:|
| Dhruv | ✅ | ✅ | ✅ | ✅ |
| Jasvi | ✅ | ✅ | — | — |
| Aditya | ✅ | ✅ | — | — |
| Ashok, Mohit, Prerna, Saksham, Shravi | ✅ | — | ✅ | — |

**Jasvi and Aditya receive no Finance grant of any kind** — no payment data, no
summaries, no proofs, no Finance navigation. The five Sales employees get
`finance.view` as module *entry*; the existing ownership/participant policies are
what limit each of them to payments on their own orders and requests.

Only `view` and `view_all` are ever granted — 18 rows, no mutation action among
them. **No quotation permission is granted to anyone**: the register stays with
System Admin until the owner grants it explicitly.

### The quotation boundary, stated exactly

| Who | Sees quotation customer fields? |
|---|---|
| Creator / assignee / delegator of the task | **Yes — intentionally.** They cannot do the work otherwise. |
| Holder of `view_quotations` | Yes, plus the register and the request form |
| Everyone else | **No** — no row, no fields, no attachments, no navigation |

The first row is a **business boundary, not a database gap**: those fields are
deliberately available to the person doing the work, and this document makes no
claim that they are protected from them. Everyone else is blocked by the `tasks`
RLS policy itself, which never returns the row.

Quotation gating is enforced in navigation, routes and field redaction; the
row-level boundary is the existing task ownership policy. `view_quotations`
appears in **no** RLS policy by design — resolving it in one would *widen* the
task boundary and hand quotation holders other people's tasks.

**The register and request creation are restricted to System Admin and to
senior staff explicitly granted the permissions through Custom access.** Normal
employees see no quotation navigation, register, creation screen, or
quotation-specific customer fields — except on a task they created, received or
delegated, where those fields are needed to perform the work.

**No price is reachable through ordinary task access.** There is no price column
in Task Management at all — see below.

**There is no price column in Task Management.** `20260652` adds `task_type`,
`customer_name`, `contact_number`, `company_name` and `city_project` and nothing
else. Quoted prices (`rate_override`, `mrp_at_time`) live in
`showroom_inquiry_items` under the separate Showroom QR module, which these
actions do not govern. `view_quotations` is named for prices as well because it
is the action that will gate them if the Task Management quotation workflow ever
grows a commercial field.

> The module key is **`task_management`**, not `tasks`. The business requirement
> is written `tasks.view_quotations`; the registered action is
> `task_management.view_quotations`.

---

## Deployment

**`20260901000000` and `20260902000000` must be applied together, in that
order, with nothing between them, in the same controlled checkpoint.** Applying
enforcement without the cleanup hands Order Request approval and Order amendment
authority to a test account. Neither file may ship without the other being ready
to apply in the same window. A repository test asserts the two files sort
adjacently, that the cleanup declares the dependency in its own header, and that
both halves are present.

### What actually happened (2026-08-14)

The four earlier migrations this pair once sat behind — `20260831000000`
(which lives on `chore/meeting-pi-import-831`, not on `main`), `20260832000000`,
`20260833000000` and `20260834000000` — are all applied. That prerequisite is
discharged; the note that used to stand here was stale on both counts.

**The first attempt to apply `20260901000000` failed and rolled back cleanly.**
It aborted at statement 18 with:

```
ERROR: function public.link_finance_payment_to_order(uuid, uuid, text) does not exist
(SQLSTATE 42883)
```

`GRANT EXECUTE` resolves by exact argument-type list, and two grants named
signatures that never existed: `link_finance_payment_to_order` was granted as
`(uuid, uuid, text)` against an authoritative `(uuid, uuid)`
(`20260691000000:41`), and `admin_delete_order_request` as `(uuid)` against an
authoritative `(uuid, boolean)` (`20260705000000:264`) — the second would have
failed on the very next statement. Both are corrected in commit `2b86a61`. All
twelve of `20260901000000`'s own `CREATE OR REPLACE` signatures were audited
against their defining migrations and match, so no rogue overload was ever
created. `20260902000000` was not modified.
[`src/lib/permissions/migrationSignatures.test.ts`](../../src/lib/permissions/migrationSignatures.test.ts)
now parses every GRANT/REVOKE/COMMENT/DROP/ALTER in both files and compares each
argument list against the signature derived from the defining migration, so this
class of defect fails in the repository rather than against production.

Both migrations were then applied together, in order, and both report Local +
Remote in `supabase migration list --linked`.

### Post-migration parity (read-only)

Verified against production inside `BEGIN READ ONLY`:

| Check | Result |
|---|---|
| Dhruv — Finance, Orders, Meetings | intended grants retained, incl. `can_be_order_assignee` |
| Aditya — Assets & Access + Meetings | retained, `assign` included; Meetings `view` |
| Test Sales (DUMMY) — Orders + Meetings | **zero** effective permissions |
| Test Sales — active Orders overrides | **0** |
| Nine (DUMMY)/Objection accounts — Meetings | **zero**, all nine |
| Eleven grandfathered employees | all retain Meetings (Dhruv 4, the other ten 1 each) |
| System Admin | active, not deleted |

**Verdict: PASS.** No active real employee lost Meetings access.

**The authority fingerprint changed, and that is expected.** It moved from
`82 / 14b9b47fd0ea01e6cc3b790f7ee35375` to
`81 / d312ce85dd429285b8e44883bc966d0c`. The hash did **not** stay the same, and
nothing here should be read as claiming it did — a fingerprint is a digest of
the grant set, so a single intended grant removal necessarily changes it.

The one-row difference is fully accounted for. Ajaypal
(`5a03d543-0e9a-4722-a96e-6036e9f54b91`, role `member`, `is_active = false`,
`is_deleted = false`) held `meetings.view` through the `member` role default
that `20260902000000` removes, and is deliberately **not** among the eleven
grandfathered employees — the re-grant joins on `u.is_active`, so an inactive
employee is skipped by design rather than re-granted. `resolve_effective_permissions`
does not itself filter on `is_active`, which is why the account still counted
toward the earlier figure. Net effect: `81 + 1 = 82`, one intentional
fail-closed removal against an inactive account, and no other change.

### Frontend

The database is ahead of the deployed frontend until the Access Control release
branch merges to `main`.

---

## Closing the parent gate (2026-08-15)

Access Control stored a decision that nothing read. Unticking **Module access**
wrote an explicit `view = false` override and the card said *Hidden*, but the
launcher and the routes gated on `app_modules.visibility_type` — a table this
screen never writes. Jasvi kept Sample Tracking. Four releases closed it.

### PR #25 — the parent gate (`view`) in the frontend

Module entry became **effective `view`, and nothing else**, in both places that
decide it: the launcher card and a shared `ModuleGuard` route guard, both asking
`canAccessManagementModule`. A leftover child action is dormant, never an entry
ticket. Route guards added for Task Management, Sample Tracking, Assets & Access,
Showroom QR (admin surface only), Employee Records, Performance and Finance;
Orders and Meetings already worked this way and were left alone.

Control Center stopped deriving *Visible/Hidden* from "any action is allowed" —
it is `view` alone — and the product-readiness badges (**Active / Partly active /
Prepared / Not used**) were removed from employee cards. They describe how far a
module's CODE is cut over, are identical for every employee, and sat beside a
per-employee switch. That information still drives the banner inside the Change
Access modal, where an administrator choosing individual actions needs it.

**Deliberately not gated**, and asserted so in `20260905000000`:

| Module | Why |
|---|---|
| `employee_records` | `users` is joined by every module for `full_name`; gating it closes the product for all non-admins |
| `showroom_qr` | its four tables also back the PUBLIC customer QR pages |
| `performance` | self-service EOD records every employee writes about themselves |

### `20260904000000` — Sample Tracking in the database

`sample_tracking_module_open()` (admin OR effective `view`), evaluated FIRST in
all ten `sample_dispatches` policies. Ownership (`requested_by`) and the
lifecycle grants are only reached once it passes. The admin UPDATE policy and
the admin DELETE branch are untouched, and asserted so.

### PR #26 — enabling a module must not erase Custom permissions

A regression the parent gate created. Ticking **Module access** ON applied the
Viewer preset, which writes a COMPLETE map — an explicit deny over every child
action the employee held. It erased Aditya's Sample Tracking `dispatch`,
`receive` and `mark_lost`, silently, because the destructive-action confirmation
only ever ran on the OFF path. The ON branch had been unreachable while a module
counted as "on" whenever ANY action was allowed; once entry correctly became
`view` alone, that employee rendered as OFF and the path went live.

`enableModuleEntry()` now states the smallest thing the checkbox means: `view`
becomes true and every other action keeps its value. Exactly one action changes.
**Picking a level explicitly still applies the whole preset and still revokes** —
a preset is a complete statement; that is the point of choosing one.

### `20260905000000` — parent gates for the remaining modules

27 tables across Task Management, Assets & Access, Meetings, Orders and Finance,
as **`AS RESTRICTIVE` policies** rather than rewrites. Postgres AND-s a
restrictive policy with the OR of every permissive one, so each existing
ownership, assignment, participant and `view_all` rule keeps its exact meaning,
nothing routes around the gate, and a permissive policy added later is gated
automatically. `view_all` is additional scope and never a substitute for `view`.

Creating a task from a Meetings review now also requires `task_management:view`;
the control is absent rather than offered and refused. A read-only check found
**0** employees holding `meetings:view` without it.

### `20260906000000` / `20260907000000` — private task attachments

`task-attachments` was the only public bucket, and its `storage.objects` SELECT
policy was `bucket_id = 'task-attachments'` to PUBLIC — no task, ownership or
role check. **Three** surfaces carried such a URL, not one:

| Surface | Rows |
|---|---|
| `task_attachments.url` | 469 |
| `tasks.attachment_url` | 40 |
| `task_activity_log.attachment_url` | 10 |

All three gained a `storage_path`, backfilled and asserted — **519/519 mapped,
0 unmapped, 0 orphaned**. Storage policies became task-aware: module entry AND
creator/assignee/delegator on the parent task, plus admin, plus `owner` (the
uploader, because comment attachments upload the object before the row exists).
`906` left the bucket public so it was safe to apply ahead of the frontend; `907`
flipped it private and re-runs the backfill first, so rows created during the
deploy window still map.

Reads are 300-second signed URLs minted with the caller's own session — **no
service role in client code**. Legacy `url` / `attachment_url` columns remain
`NOT NULL` and now receive `storage://task-attachments/<path>`: a canonical
reference that names the object without being fetchable. They are compatibility
fields, not a security exposure, and may stay.

Verified after `907`: bucket private, **no public bucket remains in the project**,
no blanket read policy, 3 task-aware policies, a copied public URL returns **HTTP
400**, and no permission row changed (last permission write predates the release).

### The agreed workflow

**localhost review → documentation → GitHub → Vercel.** Changes are reviewed
running locally first, the record here is updated as part of the same change,
and only then does it reach a branch, a PR and a deployment. Migrations are
applied in their own controlled checkpoint with a dry run first, and a migration
that can break a live screen is split so the breaking half waits for
confirmation — `906` then `907` is the worked example.

---

## Control Center: Action Queue removed (2026-08-15)

The **Action Queue** navigation entry is gone. Every row it listed was a deep
link into Finance or Order Requests; it decided nothing, stored nothing and
configured nothing, so it was a second way to reach two modules rather than a
Control Center function.

The route `/admin/control-center/action-queue` is **left in place** so existing
links and bookmarks still resolve, and the Finance and Orders pages it pointed at
are untouched. Only the navigation entry in `ControlCenterLayout` was removed.
