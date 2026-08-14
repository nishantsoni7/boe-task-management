# Access Control V1

Status: **database applied, frontend awaiting merge.** Migrations
`20260901000000` and `20260902000000` are applied to production and verified by
a read-only parity check (2026-08-14). The frontend ships in a separate release
branch that has not been merged — see [Deployment](#deployment).

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
`close` · `can_be_order_assignee`

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

### Known limitation — quotations are not enforced in the database

`view_quotations` and `manage_quotations` are enforced in the **navigation, the
routes and the screens**, not in RLS:

| Layer | Enforced |
|---|---|
| Navigation | Quotation Requests and New Request hidden, badge count included |
| Route | `/tasks/quotation-requests` and `/new` redirect before any query runs |
| Fields | `customer_name`, `contact_number`, `company_name`, `city_project` redacted to `null` |
| Database | **not enforced** — see below |

A quotation request **is** somebody's assigned task. Hiding the row in RLS would
take an employee's own assigned work away from them, which the requirement
explicitly forbids. So the row stays readable to whoever the ordinary task
policies already allow, and a caller with a valid session can still reach it
through direct PostgREST. What an employee without `view_quotations` loses is
the quotation register, the request form and the customer's commercial details —
not the task.

Closing that gap needs column-level redaction that varies per user, which
Postgres column grants cannot express (they are role-based; see
`20260813000000` for where that pattern does work). It is not attempted here.

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
