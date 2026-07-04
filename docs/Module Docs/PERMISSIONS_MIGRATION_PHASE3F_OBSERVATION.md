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

## 6. Phase 3G

**Phase 3G (legacy retirement — dropping `employee_permissions`, `has_permission()`, and the `ep_*` policies) must not begin until the checklist above is complete and production behavior has been stable for a full observation period.** This note exists specifically to gate that decision — do not treat 3F's deployment alone as sufficient grounds to start 3G.
