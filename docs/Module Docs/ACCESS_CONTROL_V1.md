# Access Control V1

Status: **implemented, not deployed.** Migrations `20260901000000` and
`20260902000000` are written and unapplied.

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
| **Partly active** | some actions checked, the rest inert | Orders, Finance, Sample Tracking |
| **Prepared** | saved, nothing consults it yet | Task Management, Showroom QR, Employee Records, Performance |
| **Not used** | governed by the admin role by design | Attendance, Payroll |

A single enforced/not-enforced flag could not describe Orders, and had already
gone stale on Meetings. The distinction matters: on 2026-07-16 ten employees
were granted Assets permissions while nothing consulted the engine, and
`20260721000000` then made them all live at once — `20260723000000` exists to
undo it.

---

## Deployment

**`20260901000000` and `20260902000000` must be applied together, in that
order, with nothing between them.** Applying enforcement without the cleanup
hands Order Request approval and Order amendment authority to a test account.
A repository test asserts the two files sort adjacently.

Both sit behind four earlier unapplied migrations, one of which lives on another
branch — see the deployment order in the Prompt 6 report.
