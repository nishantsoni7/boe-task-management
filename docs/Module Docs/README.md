# Module Documentation Index

Last verified: **2026-08-11**

One entry per module. **Full** documents follow
[_MODULE_TEMPLATE.md](_MODULE_TEMPLATE.md) and exist for modules that are
high-risk (money, access, privacy, audit) or actively changing; the rest carry an
index entry until they are next worked on, which is deliberate — an oversized
document nobody maintains is worse than an honest short one.

**Depth** is a claim about the document, not about the module:

| Depth | Means |
| --- | --- |
| `Full` | Follows the template; every required section present. **Enforced by `docs:check`.** |
| `Partial` | Accurate and useful, but predates the template. Convert when the module is next worked on. |
| `Rules` / `Historical plan` / `Phase notes` | A record of a specific kind, not a module document |
| `Index` | No document yet — the table below is all there is |

`npm run docs:check` verifies that every document listed here exists, and that
every `Full` document carries its required sections and a `Last verified:` date.

---

## Modules

| Module | Doc | Depth | Status | Entry route |
| --- | --- | --- | --- | --- |
| Attendance & Payroll | [ATTENDANCE_PAYROLL_MODULE.md](ATTENDANCE_PAYROLL_MODULE.md) | Full | Active | `/payroll`, `/my-attendance` |
| Attendance (domain plan) | [ATTENDANCE_MODULE_PLAN.md](ATTENDANCE_MODULE_PLAN.md) | Historical plan | Superseded in part | — |
| Payroll rules (current) | [PAYROLL_ATTENDANCE_RULES.md](PAYROLL_ATTENDANCE_RULES.md) | Rules | Active | — |
| Payroll rules v1 | [PAYROLL_RULES_V1.md](PAYROLL_RULES_V1.md) | Rules | **Superseded** by `src/lib/payroll/rules.ts` (see M-1) | — |
| Attendance & Payroll issues | [ATTENDANCE_PAYROLL_ISSUES.md](ATTENDANCE_PAYROLL_ISSUES.md) | Partial | Active | `/my-issues` |
| Performance Management | [PERFORMANCE_MODULE.md](PERFORMANCE_MODULE.md) | Partial | Active | `/performance` |
| Finance & Orders | [FINANCE_ORDER_WORKFLOW.md](FINANCE_ORDER_WORKFLOW.md) | Partial | Active | `/finance`, `/orders` |
| Admin Control Center | [CONTROL_CENTER_USABILITY_PASS.md](CONTROL_CENTER_USABILITY_PASS.md) | Partial | Active | `/admin/control-center` |
| Permissions engine | [PERMISSIONS_MIGRATION_PHASE3F_OBSERVATION.md](PERMISSIONS_MIGRATION_PHASE3F_OBSERVATION.md) | Phase notes | Deployed, in observation | — |
| Task Management | *index entry only* | Index | Active | `/dashboard`, `/tasks/*` |
| Notifications | *index entry only* | Index | Active | `/notifications` |
| Sample Tracking | *index entry only* | Index | Active | `/samples` |
| Assets & Access | *index entry only* | Index | Foundation | `/assets-access` |
| Meetings | *index entry only* | Index | Active | `/meetings` |
| Employee Records | *index entry only* | Index | Active | `/admin/members` |
| Showroom QR | *index entry only* | Index | Active | `/showroom-admin` |

### Modules without a full document

These are real, working modules. The absence of a document is recorded debt, not
a claim that the module is unimportant. Write the document from the template
when the module is next substantially changed.

| Module | Main tables | Authorization | Main tests |
| --- | --- | --- | --- |
| Task Management | `tasks`, `task_attachments`, `daily_work_logs` | Assignee/creator scoping + RLS | `src/lib/tasks/*`, `src/lib/listState.test.ts` |
| Notifications | `notifications` (type is a **PG enum**) | `user_id = caller`; category gate in `notificationAccess.ts` | `notificationCache.test.ts`, `notificationMutations.test.ts` |
| Sample Tracking | `sample_dispatches`, `sample_notifications` | Requester scoping + RLS | `sampleNotificationDeletes.test.ts` |
| Assets & Access | `employee_assets`, `employee_access_details`, `asset_activity_log`, `asset_access_requests`, `asset_maintenance_history` | Permission engine (`permissions/assetsAccess.ts`); removal approval admin-only | `src/lib/assets/*` (14 files) |
| Meetings | `meetings`, `meeting_attendees`, `meeting_orders`, `meeting_order_items`, `meeting_activity_log`, `meeting_update_history` | Permission engine (`permissions/modules.ts`, `moduleKey: 'meetings'`) | `src/lib/meetings/*` (7 files) |
| Employee Records | `users` (salary columns **column-granted**) | Admin only | `users/noStarSelect.test.ts`, `usersPrivateColumns.test.ts` |
| Showroom QR | product/inquiry/quotation tables | Share-token scoping for public routes | `src/lib/showroom/*` (4 files) |

---

## Cross-cutting records

These are not modules but are read alongside them:

- [../BOE Master Context/08_Authorization_Matrix.md](../BOE%20Master%20Context/08_Authorization_Matrix.md) — who may do what
- [../BOE Master Context/07_Business_Rule_Index.md](../BOE%20Master%20Context/07_Business_Rule_Index.md) — rule → code → test
- [../BOE Master Context/09_Risk_Register.md](../BOE%20Master%20Context/09_Risk_Register.md) — known debt
- [../adr/README.md](../adr/README.md) — architecture decisions
- [../testing/](../testing/) — manual test scripts

## Verification SQL

The `.sql` files in this folder are **read-only verification queries** used to
confirm a migration behaved as intended. They are not migrations and are never
applied as such.
