# Order Request Attachment — Storage test plan

These checks cover the **Storage API** layer (object uploads, signed URLs, and
object deletion) for the private `order-request-attachments` bucket. They are the
counterpart to the database-level assertions in
`supabase/tests/order_request_attachment_auth_assertions.sql`, which cover RLS and
the finalization/cleanup RPCs and are **not** repeated here.

> **Run these only after the migrations
> (`20260710000000_order_request_assignee_ownership.sql`,
> `20260711000000_order_request_attachments.sql`) have been applied to a
> controlled environment** (staging or an isolated test project), using real
> authenticated sessions for an admin, an assigned salesperson, and an unrelated
> user. They exercise Supabase Storage over the network and cannot be simulated in
> a rolled-back SQL transaction.

## Checklist

- [ ] **Pure assignee upload to admin-created draft denied** — as the assigned salesperson (not the creator), an object `PUT` into an unfinalized admin-created draft's path is rejected by the Storage INSERT policy.
- [ ] **Pure assignee signed URL / read for that draft denied** — as the assigned salesperson, `createSignedUrl` (or a read) for that draft's object fails; no readable URL is issued.
- [ ] **Same assignee read succeeds after admin finalizes** — once the admin finalizes the request, the assigned salesperson can `createSignedUrl` and open the object.
- [ ] **Finalized client deletion denied** — after finalization, an ordinary client Storage `remove` of the object is rejected (draft-only DELETE policy) for everyone, admin included.
- [ ] **Creator draft rollback deletion succeeds** — the creator can `remove` their own unfinalized draft's objects (the failed-submission rollback path).
- [ ] **Admin stale-draft deletion succeeds** — objects of a stale (> 24h) unfinalized draft are removed through the admin-authenticated, service-role cleanup API.
- [ ] **Metadata and object both removed after successful cleanup** — after a completed cleanup (creator rollback or admin route), neither the `order_request_attachments` row nor the Storage object remains.
- [ ] **No orphan object remains after failure recovery** — if a cleanup partially fails, the request row and its metadata survive (paths stay discoverable); a retry converges and leaves no orphaned object behind.
