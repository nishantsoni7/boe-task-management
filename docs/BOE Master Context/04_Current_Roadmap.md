# BOE TASK MANAGEMENT — Current Roadmap

Last verified: **2026-08-11**

Overall status: **Production active**, internal BOE team.
Approach: incremental, verified changes. Structural work before new modules.

> The June 2026 roadmap listed Attendance, Payroll and Employee Records as
> upcoming priorities. All three are now in production. This is the rebuilt list.

---

## Now (in flight)

| Item | Business purpose | Depends on | Exit condition | Verification | Touches production data |
| --- | --- | --- | --- | --- | --- |
| Attendance & Payroll UI consolidation | One module for one job; removes duplicated shells that caused missing links | — | Merged to `main` and deployed | `npm run verify`; signed-in admin + employee pass | No — no migration |
| How Payroll Works redesign | Employees can understand their own pay in ~2 minutes | Consolidation | Merged and deployed | `guide.test.tsx`; signed-in pass | No |
| Documentation and verification foundation | A contributor can start from the repository instead of old chats | — | `npm run verify` green in CI | `docs:check`, CI run | No |
| Credential remediation (R-0) | A `service_role` JWT sat in tracked source for months | — | Key rotated at Supabase and replaced everywhere | `check:secrets` in `verify`; `uatScriptCredentials.test.ts` | **Yes** — key rotation, owner-performed |

## Next (30 days)

| Item | Business purpose | Depends on | Exit condition | Verification | Touches production data |
| --- | --- | --- | --- | --- | --- |
| **R-2** Converge API authorization onto one helper | 71 routes hand-roll a role check in 9 shapes; 78 bypass RLS. One missed check is a silent hole | Nothing | Every service-role route calls the shared helper; a test asserts it | New test + full suite | No |
| **R-12** Populate `payroll_holidays` | The table is empty, so a company closure **silently consumes the employee's paid-leave entitlement** instead of being recognised as a holiday. It is usually not charged — paid leave absorbs it — so the loss surfaces later, on a day the employee genuinely takes off. Effect proven by `engine.holidays.test.ts`, not inferred | Owner supplies the holiday list | Current-year holidays entered; empty-state warning on the payroll run screen | Manual + a warning test | **Yes** — data entry, admin-performed |
| **R-1** Decide self-service route gating | An employee whose card is hidden can still open their own records by URL | Owner decision | Documented as intended, or a guard added | Access tests | No |
| **R-4a** Tests for the highest-risk untested paths | Task ownership, notification scoping, module visibility have no behaviour tests | — | Each has a failing-first test | Full suite | No |
| Employee Records module document | Live module with no document | Template | Document merged, listed in the index | `docs:check` | No |

## Later (60–90 days)

| Item | Business purpose | Depends on | Exit condition | Verification | Touches production data |
| --- | --- | --- | --- | --- | --- |
| **R-3** Decompose `finance/page.tsx` and `tasks/[id]/page.tsx` | 2,679 and 2,621 lines, no tests, highest business risk | R-4a tests exist first | Steps 1–3 of the extraction order done | `npm run verify` + signed-in pass | No |
| **R-9** Observability first steps | A production failure is currently diagnosed by guessing which of 98 routes it came from | — | Consistent error shape + correlation id; no new paid service | New tests | No |
| Task Management + Notifications module documents | Two active modules with no document | Template | Merged | `docs:check` | No |
| **R-5** Decide `threshold_half_day_hours` | Marked inactive; whether to restore the band or retire the field is unresolved | Owner decision | ADR recording the decision | — | No |
| Supabase opaque API key migration | Legacy JWT API keys are deprecated by Supabase and two were exposed in Git history; the new formats already work with the installed packages | Verification of service-credential routes, Storage, quotations and external integrations | Legacy keys disabled with the application verified green | Checklist in `02_Current_System_State.md` | No — configuration only. **Not started; no application patch approved** |

## Deferred (explicitly not doing)

| Item | Why not |
| --- | --- |
| Feature-folder migration of `src/lib` | Pure rename; fixes no observed defect. Do it per module, when that module is already being changed (`11_File_Structure_Plan.md`) |
| API response-shape rewrite across 98 routes | Large diff, no user benefit. Converge new routes instead (R-10) |
| Replacing Supabase or the auth model | Would be a rewrite; nothing is wrong with either |
| Microservices / event bus / global state library | No observed problem to solve |
| Sentry or centralized logging | Needs a funded service and production secrets |
| Rewriting deployed migrations | Forbidden — forward-only (ADR-0003) |
| Repo-wide accessibility remediation | Apply the guide's checklist per page as pages are touched (R-15) |

---

## Standing constraints

- Production data is changed only by an authorized admin through the
  application, never by a migration or a script.
- Migrations are applied **before** the merge that deploys their code.
- No feature work lands with a failing check.
