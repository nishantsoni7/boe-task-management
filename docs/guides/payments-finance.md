# Payments: a one-page guide for Finance

**Remember one sentence:** open Payment Requests and work from the top.

## The four words

Every screen now uses the same words for a payment:

| Word | Meaning |
|---|---|
| **Waiting for Finance** | Recorded, not checked yet. Doesn't count. |
| **Verified** | You checked it. It counts toward the 40% advance. In Finance lists, **Verified — not allocated** means it is verified but not yet given to a PI or Order. |
| **Needs Clarification** | You asked the person who recorded it a question. |
| **Rejected** | Not accepted. Doesn't count. |

## Money that moves instead of being recorded again

- When an approver **closes** a PI (deal lost), its payments come off that PI. They stay verified and become the client's money again: **Verified — not allocated** in Confirmed Payments.
- When Sales (or you, on an Order) add a payment and the client's money is already in the system, they tap **Use this money**. The same payment, with the same Payment ID, moves onto the new PI or Order. You get a notice for information only: "Payment … was moved onto PID-… from money already received". There's nothing to verify again.
- Every move is recorded in the payment's history with who, when and why, and **Correct Allocation** can undo it.

## One list for both HDFC accounts

Bank Statements shows HDFC PRI and HDFC SEC together, month by month, and the **Account** column says where each line is. To look at one account, use the **Account** filter or press its box at the top. Press the box again to see both.

If a credit is in one account and the payment says the other, press **Edit** on the payment and correct the account. Then it can be matched.

## Checking an HDFC payment

An HDFC PRI or SEC payment can only be verified against its bank credit. You need Bank Statements access for this.

1. A statement adds nothing to Confirmed Payments. Only a Payment Request does. When Sales ask, upload the latest statement.
2. In Payment Requests, open **Pending**, then **Match found**. A **PI waiting** tag means a PI cannot be approved until you decide.
3. Open the payment. What Sales entered and what the bank shows are side by side, one credit at a time. Anything that differs is highlighted.
4. If it is the same money, press **Verify and link**. That links the credit and moves the payment to Confirmed Payments.
5. If it is not, press **Not this one**. That credit stops being suggested for this payment, and the next one shows. **Undo** brings it back.
6. To find a credit yourself, use **Search the bank statement**: Bank Statements ID (such as BS-00412), name, amount, UTR or date. It shows only credits with money not matched yet, in both accounts. **Compare** opens the same side-by-side view.

Every bank line has a Bank Statements ID, shown on Bank Statements.

To reject the whole payment, use **Reject payment** at the bottom of the window. **Not this one** only rejects one suggested credit.

If a credit says **Check first**, the name or date does not fit. Use it only if you are sure. If it is a little short of the payment, edit the payment to the bank amount, then verify it. If the money came as part of a bigger transfer in another name and no match shows, add the UTR to the payment and it will appear.

**It says May be a duplicate?** A credit of the same amount, near the same date, is already on another payment. The window names that payment and has **Open this credit**. This check looks only at amount and date, so it can be a different client's money.

- **The other payment has no client:** it usually came from the old bank sync. If it is the same money, open the credit and press **Unlink**, delete that payment in Confirmed Payments, then come back and **Verify** the request. The PI stays attached. Stop first if that payment is on an order or PI.
- **It is in another name:** if that is a different client, this payment is waiting for its own credit. Upload the latest statement and look again.

Do not use the urgent option below for this unless you are sure it is different money, because it would count the same money twice.

**Urgent, and you can see the money in the bank app?** Admins can press **Verify, bank check pending** and give a reason. It counts at once. Confirm the match from **Bank check pending** after your next upload. It turns red if the statement covers the date and no credit is there after 7 days.

## Checking a cash payment

PNB, Paytm and Canara have no statement. Verify them as before, from the **Decision** section.

## Money in the bank with no request

On Bank Statements it reads **No request yet**. Mark it **An old order** or **Not customer money** if it is one, or press **Record it** and say what it is for. It then appears in **Match found**.

## Cleaning up a duplicate that is already in

Reject the newer copy with the reason "Duplicate of P-…". Then open the original in Confirmed Payments and use **Correct Allocation** to put it on the right PI or Order.
