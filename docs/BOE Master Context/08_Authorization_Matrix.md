# Authorization Matrix

Last verified: **2026-08-11** (commit `a33c14e`).

Developer documentation. Built from code, not from intent. Every row names the
file that actually enforces the rule.

---

## The two controls, and why confusing them is dangerous

| Control | What it does | What it does NOT do |
| --- | --- | --- |
| **Module visibility** (`app_modules`) | Decides whether a launcher card appears, and for `custom`, which named individuals see it | **Does not authorize anything.** Hiding a card hides a card. |
| **Route and API authorization** | Refuses the request | — |

**Hiding a navigation item is never authorization.** A route with no client
guard is not necessarily open: the API and RLS are the boundary. A route with a
client guard is not necessarily safe either, if its API is unguarded. Always
check the server.

Resolver: `src/lib/moduleAccess.ts`
- `resolveModuleAccess` — may this person open the module's card
- `resolveManagementAccess` — may they run its administrative surface. For
  Attendance and Payroll this returns `admin` and **no visibility mode can widen
  it** (`SELF_SERVICE_MODULE_KEYS`)

Permission engine (Orders, Meetings, Assets): `src/lib/permissions/resolver.ts`
→ `hasPermission(supabase, uid, module, action)`.

---

## Route families

Legend — ✅ full · 👤 own records only · 📖 read-only · ❌ refused · ➖ n/a

| Route family | Anon | Employee | Manager | Admin | Custom module access | Own-record limit | Write | Server enforcement |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/login` | ✅ | ✅ | ✅ | ✅ | ➖ | ➖ | ➖ | Supabase Auth |
| `/modules` | ❌ | ✅ | ✅ | ✅ | filters cards | ➖ | ➖ | `src/app/modules/page.tsx` + RLS |
| `/my-attendance` | ❌ | 👤 | 👤 | 👤 | not required (see R-1) | yes | ❌ | `/api/attendance/*` derive employee from token |
| `/my-payroll` | ❌ | 👤 | 👤 | 👤 | not required (see R-1) | yes | ❌ | `/api/payroll/my-result` — employee id is the caller's; no parameter to tamper with |
| `/my-issues` | ❌ | 👤 | 👤 | 👤 | not required | yes | raise/re-raise own | `src/lib/objections.ts`, RLS |
| `/payroll/how-it-works` | ❌ | 📖 | 📖 | 📖 | ➖ | ➖ | ❌ | `src/app/payroll/layout.tsx` `guide_only`; page reads no employee record |
| `/attendance/*` | ❌ | ❌ | ❌ | ✅ | **cannot widen** | ➖ | admin | `src/app/attendance/layout.tsx` → `resolveManagementAccess` + RLS `20260812000000` |
| `/payroll/*` (other) | ❌ | ❌ | ❌ | ✅ | **cannot widen** | ➖ | admin | `src/app/payroll/layout.tsx` → `resolveManagementAccess` + RLS |
| `/payroll/settings` | ❌ | ❌ | ❌ | ✅ | ➖ | ➖ | admin | `PayrollGuard` + `/api/payroll/settings` `requireAdmin`; `payroll_settings` RLS admin-only |
| `/admin/members` | ❌ | ❌ | ❌ | ✅ | ➖ | ➖ | admin | page role check + `users` column grants (`20260813000000`) |
| `/admin/control-center` | ❌ | ❌ | ❌ | ✅ | ➖ | ➖ | admin | page role check + RLS |
| `/super-admin` | ❌ | ❌ | ❌ | ✅ | ➖ | ➖ | admin | page role check |
| `/dashboard`, `/tasks/*` | ❌ | ✅ | ✅ | ✅ | ➖ | assignee/creator scoping | own tasks | task APIs + RLS |
| `/performance` | ❌ | 👤 | ✅ | ✅ | ➖ | own report | ❌ | `/api/performance-metrics` |
| `/performance/team` | ❌ | ❌ | ✅ | ✅ | ➖ | ➖ | ❌ | `/api/performance-metrics/team` — authorized against the real caller |
| `/samples` | ❌ | ✅ | ✅ | ✅ | ➖ | requester scoping | own requests | sample APIs + RLS |
| `/assets-access` | ❌ | 👤 | 👤 | ✅ | grantable actions | own assets/access | permission-gated | `src/lib/permissions/assetsAccess.ts`; **removal approval is admin-only** |
| `/meetings` | ❌ | ❌ | permission | ✅ | permission engine | ➖ | permission-gated | `src/app/meetings/layout.tsx` → `hasPermission` |
| `/orders` | ❌ | ❌ | permission | ✅ | permission engine | assignee scoping | `admin OR assigned_to` | `src/app/orders/layout.tsx`; mutation via SECURITY DEFINER RPCs — `order_requests` has **no UPDATE policy** by design |
| `/finance` | ❌ | ❌ | module | ✅ | `resolveModuleAccess` | ➖ | module | `src/app/finance/layout.tsx` |
| `/showroom/*` (public) | ✅ token | ✅ | ✅ | ✅ | ➖ | share token | ❌ | token scoping |
| `/notifications` | ❌ | 👤 | 👤 | 👤 | ➖ | `user_id = caller` | mark/delete own | `src/lib/notificationAccess.ts` — `attendance_payroll` is admin-only by category |

---

## Enforcement inventory (measured 2026-08-11)

| Pattern | Count | Note |
| --- | --- | --- |
| API routes total | 98 | |
| Using shared `requireAdmin` | 15 | `src/lib/security/attendancePayrollApiAuth.ts` |
| Hand-rolling a role read from `users` | 71 | **9 different `select(...)` shapes** — see R-2 |
| Using the service role (bypasses RLS) | 78 | For these, the route handler **is** the boundary |

The service-role count is the important one: in 78 routes RLS is bypassed, so the
in-route check is the only thing standing between a caller and the data. That is
why R-2 is rated as it is.

---

## Verified privacy properties

Each is asserted by a test that runs in the standard suite:

| Property | Test |
| --- | --- |
| An employee cannot read another employee's attendance or payroll | `src/lib/security/attendancePayrollIsolation.test.ts` |
| Self-service APIs cannot express a cross-employee read | `src/lib/security/attendancePayrollSelfService.test.ts` |
| Attendance/payroll API routes refuse non-admins | `src/lib/security/attendancePayrollApiIsolation.test.ts` |
| `select('*')` on `users` never appears | `src/lib/users/noStarSelect.test.ts` |
| Issue rows stay scoped to their owner | `src/lib/security/objectionIsolation.test.ts` |
| Salary/notes columns are not table-granted | `src/lib/security/usersPrivateColumns.test.ts` |
| `custom` visibility does not grant management access | `src/lib/moduleAccess.test.ts` |
| The employee navigation contains no management route | `src/components/layout/attendancePayrollNav.test.tsx` |

---

## Open items

**R-1 — self-service routes have no module guard.** `/my-attendance`,
`/my-payroll` and `/my-issues` have no `app_modules` check. An employee whose
Attendance & Payroll card is hidden can still open them by typing the URL. They
see **only their own data** — the APIs derive the employee from the token — so
this is a visibility gap, not a data leak.

*Pre-existing; not introduced by the module consolidation.* Classified as
**intended self-service access pending product confirmation**: an employee's own
attendance and payslip are arguably always theirs to see. **Not changed here** —
tightening it would remove access some employees have today, which is a product
decision. Tracked as R-1 in [09_Risk_Register.md](09_Risk_Register.md).

**R-2 — inconsistent authorization implementation.** See the register.
