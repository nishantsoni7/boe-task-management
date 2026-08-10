# <Module Name>

Last verified: **YYYY-MM-DD**

> Copy this file, fill every section, and add a row to
> [README.md](README.md). `npm run docs:check` requires the sections marked
> **required** below to be present in any document listed as `Full` in the index.
>
> Write what is true today. If something is planned, say so in *Planned next
> work* — never in *Purpose* or *Main workflows*.

---

## Purpose *(required)*

What business problem this solves, in two or three sentences. Not a feature list.

## Status *(required)*

`Active` (in daily production use) · `Foundation` (usable, still gaining core
workflows) · `Planned` (not built).

State plainly whether the work is **deployed** or **branch-only**.

## Users *(required)*

Who uses it and for what. Separate admin from employee.

## Routes *(required)*

| Route | Who | What it is |
| --- | --- | --- |

## APIs *(required)*

| Route handler | Method | Who | Enforcement |
| --- | --- | --- | --- |

Name the file that refuses an unauthorized caller. "RLS" alone is not an answer
if the route uses the service role.

## Tables *(required)*

| Table | Owns | RLS | Migration |
| --- | --- | --- | --- |

## Permissions *(required)*

How access is decided, and **where it is enforced on the server**. Reference
[../BOE Master Context/08_Authorization_Matrix.md](../BOE%20Master%20Context/08_Authorization_Matrix.md)
rather than restating it.

## Main workflows *(required)*

The two to five things people actually do, in order.

## Business rules *(required)*

Reference rule IDs from
[../BOE Master Context/07_Business_Rule_Index.md](../BOE%20Master%20Context/07_Business_Rule_Index.md).
Add new rules to that index; do not define them only here.

## Notifications

Types written, category, who receives them, deep-link target.

## Audit history

What is recorded, where, and what is immutable. If nothing is audited, say so.

## Dependencies

Which modules this reads from or writes to, and what breaks if they change.

## Main files *(required)*

| File | Role |
| --- | --- |

## Tests *(required)*

| File | Covers |
| --- | --- |

## Known limitations *(required)*

Honest list. Cross-reference risk IDs from
[../BOE Master Context/09_Risk_Register.md](../BOE%20Master%20Context/09_Risk_Register.md).

## Planned next work

Small, sequenced items. Not a wish list.

## Owner

Named owner if one exists in the repository; otherwise `unassigned`.
