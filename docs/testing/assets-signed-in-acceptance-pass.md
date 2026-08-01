# Assets & Access — signed-in acceptance pass

The 12 checks that gate acceptance of the asset lifecycle work (commit
`4e11034`). One session, roughly 20 minutes, in order.

This is the SHORT pass. `assets-lifecycle-manual-tests.md` is the exhaustive
version (92 checks) — use it when something here fails and you want to narrow
it down.

## Before you start

Two facts about production, verified against the database on 1 Aug 2026:

* There are **3 assets**, and none of them has any assignment, movement,
  service or document history.
* `asset_activity_log` is **empty**. Those three assets predate the log, and
  `asset_created` is only written on insert.

So on an existing asset, **"No activity recorded for this asset yet." is the
correct result, not a defect.** That is check 1 — it is the backward-compat
path, and it is the single most valuable thing on this list.

Everything else needs a **new** asset. Create one called `TEST — Acceptance
Pass` so it is obvious later. It will pick up the next code (`BOE-AST-000005`;
`000004` was consumed by a rolled-back database probe).

> The asset you create **cannot be deleted afterwards** once you assign it —
> that is the permanent-history rule working as designed. Name it clearly and
> retire it at the end rather than expecting to remove it.

---

## The 12 checks

### 1. An existing asset opens and all five sections load
Asset Inventory → click an existing asset's name.

- Header shows code, name, status badge, warranty badge.
- All five tabs open without error: Overview, Assignment History, Repair &
  Service, Warranty & Documents, Activity History.
- Empty tabs read "No … yet". **Warranty badge should read "Not Available"** —
  not "Expired".
- ❌ **Fail if** any tab throws, or a section shows a raw error string.

### 2. Create the test asset
**+ Create Asset**. First save it with the **name blank**.

- Error appears **inside** the modal; the modal stays open; your other entered
  values are still there.
- Fill in the name and save. The asset appears in the list with a generated
  `BOE-AST-…` code.

### 3. Assign it to an employee
Open it → **Assign Asset**. Set a handover date, condition and remark.

- Status → **Assigned**; Current Holder → that employee; acceptance **Pending**.
- Assignment History gains a movement row with from/to, department, both dates,
  condition, remark and your name.
- ❌ **Fail if** Current Holder is blank while status says Assigned.

*(Optional but worth it: sign in as that employee, My Assets → Accept Asset.)*

### 4. Transfer to a second employee
**Transfer Asset** → another employee.

- Holder becomes the new person (pending acceptance).
- The **first employee's custody period is still listed**, now closed. It must
  not vanish.
- A `Transferred` movement row appears.

### 5. Return it
**Mark Returned**, set a condition and a storage location.

- Status → **Available**; Location set; no custodian claimed.
- The returning employee's custody period remains in the history.

### 6. Mark it lost, then recover it
**Mark Lost** with a reason → status **Lost**; Assign/Transfer disappear;
Record Recovery appears.

**Record Recovery** to a location → status **Available**.

- ❌ **Fail if** the loss entry disappears from the history. The recovery is
  recorded *beside* it, never instead of it.

### 7. Add a repair record and confirm the total
**Add Repair / Service** — type Repair, a vendor, cost `1200`.

- Repair & Service tab: **Total Spend = ₹1,200** (Indian grouping), record
  count 1.
- Add a second record at `800` → **Total Spend = ₹2,000**.
- ❌ **Fail if** the total reads `₹12,00800` or similar — that is string
  concatenation and is the specific bug this was built to avoid.
- Try a **negative** cost → refused with a sentence inside the modal.

### 8. Add warranty dates and confirm the derived status
**Add Warranty Details**.

| Set expiry to | Badge should read |
| --- | --- |
| ~1 year out | **Active** |
| ~10 days out | **Expiring Soon** + "Expires in 10 days" |
| yesterday | **Expired** |
| cleared | **Not Available** |

- Set expiry **earlier than** start → refused inside the modal.

### 9. Upload and open a document
**Upload Invoice** → a small PDF or image.

- Appears under Warranty & Documents with size and uploader.
- **Open** launches it in a new tab (a signed URL — it will expire, that is
  correct).
- Try a file **over 10 MB**, and a `.exe` renamed to `.pdf` → both refused with
  a clear sentence, nothing uploaded.

### 10. Confirm notifications reached the right people
Sign in as the employee you assigned to in step 3.

- Assets sidebar → **Notifications**: "… was assigned to you. Please accept it."
- The feed contains **only** asset rows — no task, finance or order rows.
- Back as yourself: you were **not** notified about your own actions.
- Click **View asset** → opens that asset's page.
- Delete one row, select two and **Delete selected**, then **Delete all** →
  confirm the **Tasks** bell still has its own notifications afterwards.

### 11. Confirm a normal employee cannot reach admin-only asset data
Sign in as an employee with **no** Assets permissions.

- Sidebar shows only My Assets / My Access / Notifications — no Asset
  Inventory, Asset Requests or Access Register.
- Paste the test asset's URL `/assets-access/<id>` directly → "You do not have
  permission to view asset details."
- Paste `/assets-access?view=asset-inventory` → lands on My Assets instead.
- ❌ **Fail if** either URL renders inventory data.

### 12. Modal behaviour, on any Assets modal
Open **Assign Asset** (or any other) and run all five:

| Do this | Expect |
| --- | --- |
| Click the sidebar behind the modal | Nothing. Navigation is not clickable |
| Click the dimmed backdrop | Modal stays open, nothing lost |
| Press **Escape** | Closes |
| Click **✕** | Closes |
| Click **Cancel** | Closes |

Also: scroll the page with the modal open (it must not scroll), and press Tab
repeatedly (focus must stay inside the dialog).

---

## Finish

Retire the test asset (**Retire Asset**) rather than trying to delete it — once
it has history, deletion is refused by design.

Keep DevTools open throughout. **No new console errors**, and no unexpected
4xx/5xx in the Network tab.

---

## Already verified, so not repeated here

Run against production on 1 Aug 2026 — 18 structural checks and 10 behavioural
guard probes, all passing:

* every existing asset survived the migration, has a unique code and a valid status
* exactly one database function per name (no PostgREST ambiguity), all SECURITY DEFINER
* no UPDATE or DELETE policy on transfer, service or activity history, for anyone
* transfer and activity history refuse modification and deletion **even from the
  service connection** — proven, not assumed
* an asset with movement history refuses deletion
* asset codes are immutable; negative service costs, reversed warranty dates and
  unknown statuses are all refused
* the custody functions refuse an unauthenticated caller
* the document bucket is private, 10 MB, 10-type allow-list, 3 policies
* 15 asset notification types registered; no stored warranty-status column
* zero assets in production are "assigned with no custodian" or "unassigned with
  a custodian"

The script is `docs/Module Docs/assets-lifecycle-verification.sql`.
