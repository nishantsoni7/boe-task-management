# 24. Sales, Marketing, Pricing (Coming soon)

Written 2026-10-31 from the build, on branch `feat/coming-soon-modules` (PR #557). Migration `20270515000000` was **APPLIED to production on 2026-11-01** by the owner, before the merge.

## 1. Purpose & users

- The owner named three modules for future work (2026-10-31) and will say what goes in each later. Do not invent their features. Nothing in the app is known to belong to them yet.
- Access is the same for all three: Admin holds them; anybody else is Off until granted On, per person, in Control Center → Access (group Sales). A grant is `view`, the only action registered.

## 2. Status

- Each module opens a Coming soon page and nothing else. There is no data, no API route, no notification and no write.
- Checked by `tsc`, lint, the test suite and an executed in-memory rehearsal of the migration. **Not seen in a browser or signed in.**

## 3. The model

Each is a real engine-gated module with a key, a route, a launcher tile and a row in Control Center, so that real work only has to fill it. The key is the route: `sales` → `/sales`, `marketing` → `/marketing`, `pricing` → `/pricing`.

## 4. Pages

| Route | Screen | Who |
|---|---|---|
| `/sales`, `/marketing`, `/pricing` | `ComingSoonModule`: the standard module shell (brand, Home, one Overview item, the user area) around `ComingSoonNotice` (the module's icon, a Coming soon badge, one line, Back to Modules) | Admin, or `view` |

Each `src/app/<module>/layout.tsx` is `ModuleGuard` with `deniedRoute="/modules"`; each `page.tsx` is one line. Shell and notice: `src/components/layout/ComingSoonModule.tsx` and `comingSoonModule.module.css`. Launcher tiles: `src/app/modules/page.tsx`, after Inventory in the default order.

## 5. Database (`20270515000000_register_sales_marketing_pricing_modules.sql`)

Registration only, the same four tables as Vendors: `app_modules` (sort 120, 130, 140; `live`, which no longer decides entry for an engine-gated module), `permission_modules`, `module_permission_actions` (`view`, default off), `role_permissions` (Admin). No table, function, policy or notification type. The final block raises unless all three Admin rows exist. Rollback is in the file's header.

Mirrored by `registerModule` in `src/lib/permissions/modules.ts`, `ENGINE_GATED_MODULE_KEYS` (16 now), `MODULE_ENFORCEMENT` in `enforcement.ts`, `MODULE_WORDS` in `accessCatalog.ts` and `ModuleIcon`.

## 6. Business rules to remember

- A tile is an ordinary tile. "Coming soon" appears on the page that opens, because the launcher carries no status pill (recorded in `src/app/modules/page.tsx`, and a tile is icon, badge and name in `moduleCardSurface.test.ts`).
- Nobody but Admin sees a tile until they are granted it. That is the default the owner agreed on 2026-10-31.

## 7. Traps

- Before the migration is applied an Admin still sees the tiles and can open the pages, because `canAccessManagementModule` answers for the Admin role before it reads any permission. Only granting to staff needs the migration.
- `/coming-soon` is hard-coded to "Attendance Module". It is the default `deniedRoute`, so these layouts pass `/modules` instead. A real module built here should keep doing that.

## 8. Recheck before changing

When a module gets its real work: give it its own layout in `src/components/layout/`, as Vendors has, and take it off `ComingSoonModule`; drop the Coming soon wording from `modules.ts`, the migration's successor, `enforcement.ts`, `accessCatalog.ts` and the launcher; register the new actions; every table needs `module_entry_open('<key>')` and every function its own check. Until then `view` is enforced only by the card and the guard, which is enough because there is nothing behind them.
