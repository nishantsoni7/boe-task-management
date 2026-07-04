# Phase 3F — Production Observation Note

Status: **Deployed. In observation. Phase 3G not started.**

## 1. Deployment summary

- Commit: `c1b3468` — "feat(permissions): cut over sample tracking to centralized resolver"
- Branch: `main`
- Vercel: production deployment built and cloned commit `c1b3468` successfully; build compiled and typechecked cleanly; deployment status `● Ready`, serving `boe-task-management.vercel.app`.
- Scope shipped: Sample Tracking RLS + application-level authorization now run through the centralized `resolve_permission()` engine instead of the legacy `has_permission()` / `employee_permissions` path. No other module touched.

## 2. Verification summary

All checks below were run directly against the production database and the live deployment immediately after push:

| Check | Result |
|---|---|
| `has_permission(` in active `sample_dispatches` policies | **0** |
| `resolve_permission(` in `sample_dispatches` policies | **exactly 4** (`sample_dispatches_select`, `sd_update_perm_dispatch`, `sd_update_perm_receive`, `sd_update_perm_lost`) |
| All other `sample_dispatches` policies | Unchanged from pre-3F baseline |
| Admin (Nishant) — dispatch / receive / mark_lost / close | **true / true / true / true** |
| Aditya (employee override) — dispatch / receive / mark_lost / close | **true / true / true / false** |
| Standard member, no grants (Jasvi) — all 4 actions | **false / false / false / false** |
| Active Sample Tracking source (`src/`) referencing `has_permission` / `employee_permissions` / legacy `samples_*` keys | **0** (only historical comments remain) |
| `employee_permissions` table / `has_permission(uuid,text)` function / `ep_*` RLS policies | **Present, unchanged** |

## 3. Known caveat

The deployment was too fresh at verification time to have real production traffic or runtime logs. All checks above are build-level and database-level, not an observed end-to-end click-through. **An admin should manually exercise Dispatch → Receive/Mark Lost in the live UI during the observation window** to confirm the resolver-backed authorization behaves correctly under real usage, not just at the RLS/DB level.

## 4. Rollback readiness

Legacy implementation is fully intact and unmodified:
- `employee_permissions` table — present.
- `has_permission(uuid, text)` — present.
- `ep_select_own` / `ep_insert_admin` / `ep_update_admin` / `ep_delete_admin` — present.

Rollback path if an issue is found:
1. **RLS**: new forward migration `DROP POLICY` + `CREATE POLICY` restoring the 4 policies' original `has_permission(...)` expressions (captured in the pre-3F `pg_policies` snapshot from the 3F implementation record).
2. **App code**: `git revert` the `c1b3468` commit.
3. **Verify**: re-diff `pg_policies` against the pre-3F snapshot; re-run the legacy-vs-centralized comparison; confirm Aditya's dispatch/receive/mark_lost work again via the legacy path.

## 5. Observation checklist

- [ ] Admin manually dispatches, receives, and marks a sample lost in production UI.
- [ ] Aditya (or an account with equivalent centralized overrides) confirms dispatch/receive/mark_lost still work for them in the UI.
- [ ] A standard member without grants confirms the relevant action buttons are absent/disabled.
- [ ] No unexpected 403/RLS-denial errors appear in Vercel/Supabase logs for `sample_dispatches` traffic.
- [ ] No unexpected spike in Supabase error logs referencing `resolve_permission` or `sample_dispatches` policies.
- [ ] A stable observation period (no authorization regressions reported) has elapsed.

## 6. Live smoke test — 2026-07-05

**Result: Passed, partial.** Production authorization behaves as intended everywhere it could be exercised; visual UI click-through remains incomplete for reasons unrelated to the app itself.

**What passed:**
- Production deployment confirmed still on the expected Phase 3F code path (commit `c1b3468`, no drift, working tree clean).
- No production data was created or modified during testing.
- The live production `/api/admin/user-permissions` endpoint — the exact route Admin View Mode calls — was exercised over HTTPS using a temporary real admin session (a one-time Supabase magic-link session, not a stored password), then that session was immediately invalidated:
  - **Admin** → `approve, close, create, delete, dispatch, edit, export, manage, mark_lost, receive, view` (full access, as expected).
  - **Aditya** → `dispatch, mark_lost, receive` (matches his centralized employee overrides exactly; **`close` not present** — not newly granted).
  - **Jasvi** (standard member, no grants) → empty permissions array.
- No unexpected grants found for any of the three identities. This corroborates the DB-level `resolve_permission()` checks from the initial cutover verification (§2) with an independent, live HTTP-level check against the real deployed route.

**What remains pending:**
- Visual browser click-through could not be completed — the Claude browser extension was blocked from interacting with `boe-task-management.vercel.app` (permission/navigation denied at the extension level, even after being granted access twice). This is a tooling limitation, not a finding about the app.
- Production currently holds only 1 `sample_dispatches` row, and it is in `approved` status. The dispatch / receive / mark-lost action buttons only render at `qr_submitted` / `dispatched` respectively, so button-rendering behavior for those states could not be click-tested against a real record. No test record was fabricated to force this, per standing instruction to avoid creating fake production data.
- A real admin browser click-through (Dispatch → Receive / Mark Lost) and a natural `qr_submitted`/`dispatched` record remain open follow-ups whenever the extension access issue is resolved and/or such a record occurs naturally.

**Security note:** the service-role-generated magic-link session used above is a verification workaround for this observation task, not a pattern to adopt for routine UI testing. It mints a real, if short-lived, admin-authenticated session outside the normal login flow and should be used sparingly, only for scoped verification like this, and always invalidated immediately after use (as was done here). Normal production UI testing should go through an actual admin login once browser access is available.

**Continued observation status:** Phase 3F remains under observation. This smoke test found no issues and adds independent, live confirmation on top of the original DB-level verification — it does not close the observation period on its own, since the two pending items above (visual click-through, status-gated button rendering) are still open.

## 7. Phase 3G

**Phase 3G (legacy retirement — dropping `employee_permissions`, `has_permission()`, and the `ep_*` policies) must not begin until the checklist above is complete and production behavior has been stable for a full observation period.** This note exists specifically to gate that decision — do not treat 3F's deployment, nor this smoke test, alone as sufficient grounds to start 3G.
