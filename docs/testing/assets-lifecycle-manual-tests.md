# Assets & Access — lifecycle manual test pass

Covers the work in migrations `20260726000000`–`20260731000000` and the app
changes that go with them: the asset detail page, permanent transfer history,
repair/service records, warranty and documents, list search and filters, asset
notifications, and the form-modal behaviour.

Everything below needs a signed-in session, so it is a **human pass**. The
automated suite (`npx tsx --test "src/**/*.test.ts"`) covers the pure rules —
warranty derivation, cost totals, custody resolution, transfer validation,
search/filter behaviour, notification recipients, document validation, view
routing and modal dismissal — and cannot cover any of the below.

Use a **non-production asset** you create for the purpose. Nothing here needs
destructive testing against real inventory.

---

## Setup

1. Sign in as an **admin**.
2. Open `/assets-access`. The sidebar shows My Records (My Assets, My Access,
   Notifications) and Management (Asset Inventory, Asset Requests, Access
   Register).

---

## 1. List: load, search, filters

| # | Step | Expected |
|---|------|----------|
| 1 | Open Asset Inventory | Table loads. Columns: Asset, Asset Code, Category, Current Holder, Status, Condition, Warranty, Last Updated, Actions |
| 2 | Type a partial asset name into the search box | List narrows as you type |
| 3 | Search an asset **code** (`BOE-AST-…`), a **serial**, a **brand**, a **model** | Each finds the asset |
| 4 | Search the **name of an employee** holding an asset | That employee's assets are listed |
| 5 | Search two words, e.g. `dell priya` | Only rows matching **both** appear |
| 6 | Click **Filters** | Panel opens with Category, Status, Assigned Employee, Department, Location, Condition, Warranty, Purchased Between |
| 7 | Apply each filter **individually** | Each narrows correctly; the button reads `Filters (1)` |
| 8 | Apply **two or three together** | Results narrow further, never widen |
| 9 | Click **Clear** | Full inventory returns; the count badge disappears |
| 10 | Apply a filter combination that matches nothing | Empty state: "No assets match this search…" — not a blank table |
| 11 | Inventory with no assets at all | Empty state: "No assets in inventory yet." |
| 12 | Watch the table at a normal desktop width (≥1280px) | No horizontal scrollbar |
| 13 | Resize to mobile width | Cards replace the table and stay readable |

## 2. Asset detail page

| # | Step | Expected |
|---|------|----------|
| 14 | Click an asset name (or **Open**) | `/assets-access/<id>` opens |
| 15 | Header | Asset code, name, status badge, warranty badge, category, holder, department |
| 16 | Five tabs | Overview, Assignment History, Repair & Service, Warranty & Documents, Activity History |
| 17 | Open an **old** asset with no new records | Every tab loads. Empty states read "No … yet", never an error |
| 18 | Overview | Name, code, category, serial, brand, model, description, purchase date/price, vendor, invoice no., status, custodian, department, location, condition, warranty status, total repair spend, created, last updated |
| 19 | Direct-URL a non-existent asset id | "This asset does not exist, or you do not have access to it." |

## 3. Create, edit, validation

| # | Step | Expected |
|---|------|----------|
| 20 | **+ Create Asset**, save with an empty name | Error inside the modal; the modal stays open; entered values are kept |
| 21 | Fill in and save | Asset created, appears in the list with a generated `BOE-AST-…` code |
| 22 | On the detail page, **Edit Asset**, change brand and save | Saved; Activity History gains "Details updated" with before → after per field |

## 4. Modal behaviour — the whole of requirement 8

Run these on **any** Assets modal (Create Asset, Assign, Transfer, Add Repair,
Warranty Details, Upload Invoice, Reject Request…).

| # | Step | Expected |
|---|------|----------|
| 23 | With a modal open, click the **sidebar** behind it | Nothing happens — navigation is not clickable |
| 24 | Click the dimmed **backdrop** | Modal stays open. Nothing is lost |
| 25 | Press **Escape** | Modal closes |
| 26 | Reopen, click the **✕** | Modal closes |
| 27 | Reopen, click **Cancel** | Modal closes |
| 28 | Fill fields, cause a **failing** save (e.g. save an edit while signed in as someone without permission) | Error shows **inside** the modal, the modal stays open, every entered value is still there |
| 29 | Click the save button twice quickly | Only one write happens; the button reads "Saving…" and is disabled |
| 30 | With the modal open, scroll the page | The page behind does not scroll |
| 31 | Press **Tab** repeatedly | Focus cycles inside the dialog and never reaches the sidebar |
| 32 | Close the modal | Focus returns to the control that opened it |

## 5. Custody lifecycle

Perform in order on one test asset.

| # | Step | Expected |
|---|------|----------|
| 33 | **Assign Asset** to employee A (set a handover date, condition, remarks) | Status → Assigned; Current Holder → A; A's acceptance is Pending |
| 34 | Assignment History tab | Movement row `Assigned` with from/to, departments, recorded and handover dates, condition, remarks, actor |
| 35 | Sign in as **A**, My Assets → **Accept Asset** | Acceptance recorded; Activity shows "Assignment accepted" |
| 36 | Back as admin: **Transfer Asset** → employee B | Holder becomes B (pending acceptance); A's custody period shows as Returned; a `Transferred` movement row appears |
| 37 | **Transfer Asset** → a company **location** instead | Status → Available, Location set, no custodian claimed |
| 38 | **Mark Returned** with a condition and a storage location | Status → Available; condition and location updated; `Returned` movement row |
| 39 | **Mark Lost** with a reason | Status → Lost; Assign/Transfer disappear; Record Recovery appears |
| 40 | **Record Recovery** to a location or an employee | Status returns to Available/Assigned; the write-off stays in the history beside the recovery |
| 41 | At every step, confirm **Current Holder** | Never shows "Assigned" with a blank holder, and never names a holder for an available asset |

## 6. Repair & service

| # | Step | Expected |
|---|------|----------|
| 42 | **Send for Repair** (type, issue, vendor, sent date) | Status → Under Repair; custody is **unchanged** — the holder stays accountable |
| 43 | **Record Return from Service** with a cost, condition and next-service date | Status returns to Assigned (if still held) or Available |
| 44 | Repair & Service tab | Total Spend, Service Records count, Last Service, Next Service — all correct |
| 45 | **Add Repair / Service** for a past service with a cost | Total Spend increases by exactly that amount, formatted `₹1,20,000` (Indian grouping) |
| 46 | Enter a **negative** cost | Refused with a sentence, inside the modal |
| 47 | Enter a returned date **before** the sent date | Refused with a sentence |

## 7. Warranty & documents

| # | Step | Expected |
|---|------|----------|
| 48 | **Add Warranty Details** — set expiry far in the future | Warranty badge reads **Active** |
| 49 | Set expiry within 30 days | **Expiring Soon**, with "Expires in N days" |
| 50 | Set expiry in the past | **Expired** |
| 51 | Clear the expiry | **Not Available** (never "Expired") |
| 52 | Set expiry **before** start | Refused inside the modal |
| 53 | **Upload Invoice** (PDF or image ≤10 MB) | Appears under Documents; Activity gains "Invoice uploaded" |
| 54 | **Upload Warranty Card** | Same, as "Warranty card uploaded" |
| 55 | Click **Open** on a document | Opens in a new tab through a short-lived signed URL |
| 56 | Try uploading a `.exe` renamed to `.pdf`, or a >10 MB file | Refused with a clear sentence; nothing is uploaded |
| 57 | **Remove** a document with a reason | Disappears from the list; Activity gains "Document removed" with the reason |

## 8. Retire / dispose / restore

| # | Step | Expected |
|---|------|----------|
| 58 | Try **Retire** while the asset is still held | Refused: take it back first |
| 59 | Return it, then **Retire Asset** | Status → Retired; Assign/Transfer gone |
| 60 | **Restore to Service** | Status → Available; both events are in the history |

## 9. Activity history

| # | Step | Expected |
|---|------|----------|
| 61 | Activity History tab | Newest first, one entry per action performed above |
| 62 | Each entry | Event label, actor name, date and time, and useful detail lines |
| 63 | Scan every entry | **No raw UUIDs anywhere** — people and files are named |
| 64 | Look for any edit/delete control on the timeline | There is none |

## 10. Notifications

| # | Step | Expected |
|---|------|----------|
| 65 | As the recipient, open **Notifications** in the Assets sidebar | Only `asset_*` notifications appear — no task/finance/order rows |
| 66 | Assign an asset to someone; sign in as them | "… was assigned to you. Please accept it." |
| 67 | Accept it; sign in as the assigner | "… accepted …" |
| 68 | Transfer between two people | Both the new and previous holder are notified |
| 69 | Mark lost | Last holder **and** admins notified |
| 70 | Send for repair / return from repair | Holder and admins notified |
| 71 | Raise an edit or removal **request** as a non-admin | Admins notified |
| 72 | Approve / reject it as admin | The requester is notified; a rejection carries the reason |
| 73 | Perform any action on yourself | You are **not** notified about your own action |
| 74 | Click **View asset** on a notification | Opens that asset's detail page |
| 75 | Click **View request** on a request notification | Opens the Asset Requests screen |
| 76 | Click an unread row | Turns read; the sidebar badge decreases |
| 77 | **Mark all read** | All rows read; badge → 0 |
| 78 | Trash icon on one row | That row only is deleted |
| 79 | Select several, **Delete selected (N)** | Only those are deleted |
| 80 | **Delete all** | Only **Assets** notifications are deleted — check the Tasks bell still has its own |
| 81 | Repeat the same action twice within two minutes | Only one notification is created |
| 82 | Set an asset's warranty to expire in ~10 days, reload the inventory | Admins get one "Warranty … expires in N days" — and only one, even after several reloads |

## 11. Permissions

| # | Step | Expected |
|---|------|----------|
| 83 | Sign in as an employee with **no** Assets permissions | No Asset Inventory / Asset Requests / Access Register in the sidebar |
| 84 | Same user: paste `/assets-access/<id>` directly | "You do not have permission to view asset details." |
| 85 | Same user: paste `/assets-access?view=asset-inventory` | Lands on My Assets instead |
| 86 | Grant only **view** in Control Center → Access Control, reload | Inventory visible; **no** Assign/Transfer/Return/Repair buttons |
| 87 | Grant only **assign** | Assign appears; Transfer/Return/Mark Lost do not |
| 88 | Grant only **manage** | Transfer/Return/Mark Lost/Repair appear; Assign does not |
| 89 | As a non-admin with view, open an asset | Request Edit / Request Removal are offered instead of Edit / Delete |

## 12. Console and network

| # | Step | Expected |
|---|------|----------|
| 90 | Keep DevTools open through the whole pass | No new console errors |
| 91 | Watch the Network tab | No unexpected 4xx/5xx. A refused action returns 401/403 with a JSON `error` and no SQL, no stack, no internal names |
