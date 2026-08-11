# Known Risks and Technical Debt

Last verified: **2026-08-11** (commit `a33c14e`).

Every entry is backed by a measurement or a file reference taken from this
repository on that date. Nothing here is speculative.

Severity: how bad if it happens · Likelihood: how likely within ~6 months.

---

> ### 🚨 R-0 is a live production credential exposure. Read it first.

| ID | Area | Evidence | Operational effect | Likelihood | Severity | Treatment | Phase | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **R-0** | **Secrets** | **One** `service_role` JWT (issued 2026-05-20, project `albnsrohngkljfsrrrhf` — same ref as `.env.local`) appears in **five** files across Git history: the three UAT scripts plus the since-deleted `scripts/capture-performance.js` and `scripts/seed-demo-tasks.js`. One `anon` key also appears. Full scan: `npm run check:secrets -- --history` | A `service_role` key **bypasses every RLS policy**. Anyone with repository read access has full read/write on every table — salaries, attendance, audit history — regardless of the entire authorization model documented here | **Certain** (already exposed) | **Critical** | **Rotate at Supabase — that is the only step that revokes anything.** Source cleanup done 2026-08-11 (credentials now read from the environment; `check:secrets` reports tracked files clean), but the value remains in history and stays live until rotated | **Immediate** | **OPEN — rotation outstanding** |
| **R-1** | Authorization | `/my-attendance`, `/my-payroll`, `/my-issues` have no `app_modules` guard | An employee whose card is hidden can still open their own records by URL. **Own data only** — APIs derive the employee from the token | High (already true) | Low | Confirm as intended self-service, or add a guard. **Product decision, not a bug fix** | Next | Open — awaiting owner |
| **R-2** | Authorization | 98 API routes: **15** use shared `requireAdmin`, **71** hand-roll a `users` role read in **9 different `select()` shapes**, **78** use the service role (bypassing RLS) | In service-role routes the hand-rolled check is the only boundary. A new route that forgets one is a silent hole | Medium | **High** | Extract one `requireRole`/`requireAdmin` helper; migrate routes in small batches, highest-risk first; add a test asserting every service-role route calls it | Next 30 days | Open |
| **R-3** | Maintainability | 20 files over 1,200 lines; largest `src/app/finance/page.tsx` **2,679**, `src/app/tasks/[id]/page.tsx` **2,621**, `src/app/orders/requests/page.tsx` **2,061** | Merge conflicts, hidden permission branches, untestable logic, slow review | High | Medium | Staged extraction (constants → helpers → stateless sections → hooks → services → policies). See [12_Large_File_Plan.md](12_Large_File_Plan.md) | Next 60–90 days | Open |
| **R-4** | Test architecture | 121 test files, **3,211 tests**, but 20 of 25 `src/app` directories have **none**. Concentrated in `lib/payroll` (26), `lib/assets` (14) | Calculations are well protected; UI workflows, task lifecycle and notifications are not | High | Medium | Add behaviour tests at the highest-risk uncovered points (task ownership, notification scoping, module visibility) — not coverage for its own sake | Next 30 days | Open |
| **R-5** | Stale configuration | `threshold_half_day_hours` is stored, validated, pinned in every snapshot and **editable**, but has **zero** read sites in calculation code | An admin can change a number believing it affects pay. It does not | High (already true) | Medium | **Done 2026-08-11:** marked inactive and read-only in the settings UI, help text corrected. Retiring the field entirely needs an owner decision (it is pinned in historical snapshots) | Now / later | **Mitigated** |
| **R-6** | Migration discipline | Two filename conventions coexist: **65** `YYYYMMDD_` and **94** `YYYYMMDDHHMMSS_` | Ordering ambiguity when two same-day migrations exist; already caused a history-repair incident | Low | Medium | Convention documented and validated for **new** files only. Deployed files are never renamed | Now | **Mitigated** (documented + checked) |
| **R-7** | Documentation accuracy | Root `CLAUDE_START_HERE.md.txt` pointed at **7 paths, 7 of which did not exist**. `02_Current_System_State.md` called Attendance and Payroll "Early Stage" | A new contributor or assistant starts from a false map and rebuilds what exists | High (already true) | Medium | **Done 2026-08-11:** broken entry point removed, records rebuilt from code, `docs:check` now fails on a broken local link | Now | **Mitigated** |
| **R-8** | CI | No `.github/` directory existed; the only PR checks were Vercel's | A branch could reach review with failing types or tests | High | Medium | **Done 2026-08-11:** `.github/workflows/verify.yml` runs docs check, typecheck, lint and the full suite on PRs and pushes | Now | **Mitigated** (build step still local-only — see note) |
| **R-9** | Observability | No error boundaries; `console.error` in route handlers; no request/correlation id; no deployment identifier in logs | A production failure is diagnosed by guessing which of 98 routes it came from | Medium | Medium | Local, no-cost first steps only: consistent route error shape and a correlation id. Sentry/central logging is a separate funded task | Next 60–90 days | Open |
| **R-10** | API consistency | 588 `{ error }` responses vs 30 `{ success }` vs 7 `{ ok }`; 7 distinct status codes with no documented meaning | Clients handle failures differently per route; new routes copy whichever neighbour they saw | Medium | Low | Document the intended shape, then converge new routes; do not rewrite 98 handlers | Later | Open |
| **R-11** | Shared UI | Module shells were duplicated per module (Attendance/Payroll fixed in `789c771`); others remain distinct components | A fix applied to one shell silently misses the others | Medium | Low | Apply the Attendance & Payroll pattern to the next duplicated pair when one is touched anyway | Later | Partially treated |
| **R-12** | Data | `payroll_holidays` is empty in production. Salary effect **proven by test**, not inferred — `src/lib/payroll/engine.holidays.test.ts` | An unregistered holiday becomes a working day and, with the office shut, an absence. **It is usually not charged** — the month's paid leave absorbs it — but it **silently consumes the employee's paid-leave entitlement**, so their own next absence is no longer covered. Once the allowance is spent, each further unregistered closure costs **one full day's pay** | High | **High** | Operational, not code: holidays must be entered. Add an empty-state warning on the payroll run screen | Next 30 days | Open — **effect now proven and correctly stated** |
| **R-13** | Release safety | No `gh` CLI on the dev machine; releases are manual rebase-merges; migrations must be applied **before** merge or PostgREST 42703s | A merge without its migration breaks the module for everyone | Medium | **High** | Documented in `02_Current_System_State.md` and the PR template checklist | Now | **Mitigated** (documented + checklist) |
| **R-14** | Module boundaries | Module-specific logic sits in generic folders: `src/lib` holds 211 files including `teamPerformance.ts` (1,774 lines), `objections.ts`, `orderRequestAttachments.ts` | Ownership is unclear; unrelated domains import each other | Medium | Low | Feature-folder direction recorded in [11_File_Structure_Plan.md](11_File_Structure_Plan.md). **No mass move now** | Later | Open |
| **R-15** | Accessibility | No repo-wide a11y checking. The payroll guide was built to the standard (heading order, non-colour signals, focus states); other pages are unverified | Inconsistent experience; unknown WCAG position | Medium | Low | Apply the guide's checklist when a page is next redesigned | Later | Open |

---

## R-0 remediation, in order

Found during the 2026-08-11 structural audit. **Not introduced by it.**

### Exposure, as measured

`npm run check:secrets -- --history` over 6,097 historical blobs found
**two distinct tokens**, both for the production project, both issued
2026-05-20:

| Token | Appears in |
| --- | --- |
| `service_role` — **bypasses RLS** | `uat-seed.mjs`, `uat-cleanup.mjs`, `uat-simulate.mjs`, `capture-performance.js` (deleted), `seed-demo-tasks.js` (deleted) |
| `anon` — publishable | `uat-simulate.mjs` |

One key in five files, not five keys. **Rotating it once invalidates every
copy**, including the two in files that no longer exist.

### Steps

1. ✅ **Source cleanup — done 2026-08-11.** All three live scripts read
   credentials from the environment and stop with a clear message when one is
   missing. `check:secrets` reports tracked files clean and now runs inside
   `npm run verify`. `uatScriptCredentials.test.ts` fails if a literal returns.
   **This revoked nothing.**
2. ⬜ **Rotate** the `service_role` key — Supabase dashboard → Settings → API.
   **Only this revokes access.** Every copy, including those in Git history,
   dies with it.
3. ⬜ Replace it in Vercel (production, preview, development) and in authorized
   local `.env.local` files.
4. ⬜ Rotate the shared UAT password.
5. ⬜ Redeploy or restart anything that reads environment variables at startup.
6. ⬜ Confirm the application still works, and that the **old** key is rejected.
7. ⬜ Check Vercel logs for authentication or database errors after rotation.
8. ⬜ Decide whether the UAT scripts should target production at all, or a
   separate project.
9. ⬜ Optional, owner's decision, rewrites history and affects every clone:
   purge the blobs with `git filter-repo`. **Rotation makes this cosmetic** —
   never treat it as the fix, and never attempt it before step 2.

Until step 2 is done, every access-control property documented in
[08_Authorization_Matrix.md](08_Authorization_Matrix.md) is bypassable by anyone
who can read the repository.

## R-12, stated precisely

The first version of this entry said an unregistered public holiday "is charged
as an absence". That was inferred from an empty table and is **too strong**.
`engine.holidays.test.ts` runs the real engine and establishes what actually
happens:

| Scenario | Charged | Entitlement |
| --- | --- | --- |
| One unregistered holiday, otherwise clean month | **₹0** — paid leave absorbs it | **Consumed** |
| One unregistered holiday + one genuine absence | **One day's pay** | Spent on the earlier absence |
| Two unregistered holidays in a month | **One day's pay** | Spent on the first |

So the harm is usually **not** a visible deduction. It is that a company closure
silently spends an entitlement the employee earned by attending, and the loss
only surfaces later, on a day they genuinely take off. That is harder to notice
than a wrong number on a payslip, which makes it worse rather than better.

The fix is unchanged and operational: enter the holidays.

## Not risks (checked and cleared)

- **Migrations are forward-only.** The only real `DROP TABLE` statements are in
  `20260640_reset_assets_access_v1.sql`, a deliberate v1 reset. Every other
  `DROP TABLE` occurrence in the tree is a commented rollback note.
- **Salary privacy at the column level** is enforced by grants, not convention,
  and asserted by a test.
- **Payroll calculations are well covered** — 26 test files in `src/lib/payroll`
  alone, including rounding, leave absorption, settlement and snapshot
  behaviour.
