# Payroll attendance correction — manual test pass

Covers migrations `20260807000000` + `20260808000000` and the app changes that go
with them: the two Payroll Result Detail tabs, the date-level correction modal,
the override layer, recalculation, locking, permissions and audit history.

Everything below needs a **signed-in admin session**, so it is a human pass. The
automated suite (`npx tsx --test "src/**/*.test.ts"`, 1451 tests) already covers
the pure rules — precedence, waivers, tab partitioning, remark validation, lock
and permission decisions, audit shaping and the adjustment sign conversion — and
cannot cover anything below.

## Setup

1. Start the dev server (`npm run dev`) and sign in as an **admin**.
2. Pick a **safe test employee** and a payroll period that is **generated but not
   locked**. `/payroll` lists periods with their status.
3. The employee needs at least one bad attendance day. The reference case is a
   forgotten punch-in: the machine recorded a single late punch and no punch-out,
   which payroll reads as Missing Punch-Out **and** a large Late Arrival.
4. Keep the browser console and network tab open for the whole pass.

---

## 1. Both tabs

| # | Step | Expected |
|---|------|----------|
| 1 | Open `/payroll/results/<periodId>/<employeeId>` | Page loads. No console errors, no failed requests |
| 2 | Look at the tab strip | Two tabs: **Deductions** and **Days Considered**, each with a count |
| 3 | Deductions tab | Only dates that reduced salary. Amounts red, prefixed `−` |
| 4 | Days Considered tab | Paid/present dates: Full Present, Half Day, Weekly Off, Paid Holiday |
| 5 | A full-present row | Green status pill; Payable column shows `1d` in green |
| 6 | The bad date in Deductions | **One** row for the date, with both reasons stacked inside it |
| 7 | Count the Edit buttons on that row | Exactly **one** |
| 8 | Weekly off / holiday rows in Days Considered | **No** Edit button at all |
| 9 | Narrow the window to phone width | Tables scroll inside their own container; the page body does not scroll sideways |

## 2. The correction modal

| # | Step | Expected |
|---|------|----------|
| 10 | Click **Edit** on the bad date | Modal opens, titled *Correct Attendance*, subtitled with employee and date |
| 11 | Top panel | **Machine record** (`IN hh:mm · OUT hh:mm`, or `missing`), **Currently counted as**, and every deduction line with its amount and the date total |
| 12 | Punch fields | Pre-filled with the *effective* attendance, editable, IST |
| 13 | Click the dark backdrop | **Nothing happens** — the modal stays open with values intact |
| 14 | Press `Escape` | Modal closes |
| 15 | Reopen, click the `✕` | Modal closes |
| 16 | Reopen, leave Remark empty | **Save & Recalculate** is disabled |
| 17 | Type only spaces/tabs into Remark | Still blocked; clicking Save shows *A correction remark is required.* |
| 18 | Choose a treatment other than *Recalculate…* | The three waiver checkboxes grey out with an explanatory hint |

## 3. Correcting the date

| # | Step | Expected |
|---|------|----------|
| 19 | Punch-In `10:00`, Punch-Out `18:30`, treatment *Recalculate from the corrected punches*, remark `Forgot to punch in; actual arrival confirmed by manager.` → **Save & Recalculate** | Modal closes; green banner names the date and the new net salary |
| 20 | Deductions tab | The Missing Punch-Out line is **gone** |
| 21 | Same tab | The Late Arrival line is **gone** (10:00 is inside the grace period) |
| 22 | Total Deductions row | Lower than before by the removed amount |
| 23 | Net Salary panel | Higher by the same amount |
| 24 | Days Considered tab | The date is now listed, **Full Present**, green, `1d` payable |
| 25 | The same row | A blue **Corrected** badge next to the date |
| 26 | Hover the badge / read under the status | The remark is shown |
| 27 | Salary Breakdown card | Days Present increased by one where the day was previously absent |

## 4. Amending and history

| # | Step | Expected |
|---|------|----------|
| 28 | Edit the same date again | Modal shows *Already corrected — <first remark>* and the corrected punches, not the machine ones |
| 29 | Change treatment to *Approve as a full paid day*, new remark, Save | Saves; the date stays clean in Deductions |
| 30 | Refresh the page (F5) | The correction persists; the badge and remark are still there |
| 31 | Re-run **Generate** for the period from `/payroll` | The correction still applies — payroll does **not** revert to the machine values |

Then run the SQL in §7 to prove history, currency and raw-data safety.

## 5. Adjustments (the sign fix)

| # | Step | Expected |
|---|------|----------|
| 32 | `/payroll/monthly-review/<userId>?year=&month=` → add an **Addition** of ₹1,000 with a note | Estimated Net Salary rises by exactly ₹1,000 |
| 33 | Delete it, add a **Deduction** of ₹1,000 | Estimated Net Salary **falls** by exactly ₹1,000 |
| 34 | With that deduction still pending, regenerate payroll, then open Payroll Result Detail | Adjustments card shows `−₹1,000.00`; Net Salary is gross − deductions − ₹1,000 |
| 35 | Correct an attendance date while the ₹1,000 deduction is pending | The deduction stays a **deduction** — it must not flip to a credit |
| 36 | Compare the monthly-review preview total with the generated result total | Identical |

> Before the fix a ₹1,000 deduction *increased* net salary by ₹1,000 — a ₹2,000
> swing. Step 33 is the one that would have caught it.

## 6. Locking and permissions

| # | Step | Expected |
|---|------|----------|
| 37 | `/payroll/results/<periodId>` → **Lock Payroll** → confirm | Period locks |
| 38 | Reopen Payroll Result Detail | Amber banner: *Payroll for this period is locked. Attendance can no longer be corrected.* |
| 39 | Every Edit button | Disabled, with the lock reason as tooltip |
| 40 | API directly (below) while locked | `422` and the same message — the UI is not the only guard |
| 41 | API as a non-admin (below) | `403 Only payroll administrators can correct attendance.` |
| 42 | API with no token | `401 Unauthorized` |

```bash
curl -i -X POST http://localhost:3000/api/payroll/attendance-correction \
  -H "Content-Type: application/json" \
  -H "authorization: Bearer <TOKEN>" \
  -d '{"payroll_period_id":"<PERIOD_ID>","employee_id":"<EMPLOYEE_ID>","attendance_date":"2026-07-21","check_in_at":"2026-07-21T04:30:00.000Z","check_out_at":"2026-07-21T13:00:00.000Z","day_treatment":"auto","remark":"api check"}'
```

Get `<TOKEN>` from the browser console of a signed-in session:
```js
JSON.parse(Object.entries(localStorage).find(([k]) => k.includes('auth-token'))[1]).access_token
```
Run it once signed in as admin on a **locked** period (expect 422), once signed in
as a member (expect 403), and once with the header removed (expect 401).

## 7. Database proofs

Run in the Supabase SQL editor. Replace `<EMP>` and `<DATE>`.

**Raw attendance unchanged** — the machine values must still be what the import
wrote, even though payroll now uses different ones:
```sql
SELECT attendance_date, check_in_at, check_out_at, status, created_at, updated_at
FROM   public.attendance_records
WHERE  user_id = '<EMP>' AND attendance_date = '<DATE>';
```
`updated_at` must equal the import time, **not** the time you saved the correction.

**Correction history retained, exactly one current:**
```sql
SELECT corrected_at, is_current, day_treatment, remark,
       corrected_check_in_at, corrected_check_out_at,
       original_classification, revised_classification,
       original_deduction_amount, revised_deduction_amount,
       original_net_salary, revised_net_salary,
       superseded_at, superseded_by
FROM   public.attendance_day_corrections
WHERE  user_id = '<EMP>' AND attendance_date = '<DATE>'
ORDER  BY corrected_at;
```
Expect one row per save; every earlier row `is_current = false` with a
`superseded_at` and a `superseded_by` pointing at its successor; the newest row
`is_current = true`. Old remarks and old before/after figures must still be there.

**Only one current version, globally:**
```sql
SELECT user_id, attendance_date, count(*) AS current_versions
FROM   public.attendance_day_corrections
WHERE  is_current
GROUP  BY user_id, attendance_date
HAVING count(*) > 1;
```
Must return **zero rows** (the partial unique index guarantees it).

**Payroll totals before/after** — capture before correcting and again after:
```sql
SELECT total_deductions, net_salary, days_present, days_absent, generated_at
FROM   public.payroll_results
WHERE  payroll_period_id = '<PERIOD>' AND employee_id = '<EMP>';
```

**No stale deduction lines for a corrected date:**
```sql
SELECT l.line_date, l.deduction_type, l.hours_deducted, l.amount_deducted
FROM   public.payroll_deduction_lines l
JOIN   public.payroll_results r ON r.id = l.payroll_result_id
WHERE  r.payroll_period_id = '<PERIOD>' AND r.employee_id = '<EMP>'
ORDER  BY l.line_date;
```
The corrected date must not appear at all after a full-day correction.

---

## Recording results

Note the step number and the actual behaviour for anything that deviates, plus
any console error, failed request or SQL result that does not match. Payroll
figures should be recorded as before/after pairs, not just "changed".
