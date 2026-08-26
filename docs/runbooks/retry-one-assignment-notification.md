# Retrying one missing assignment notification

**Nothing in this document has been executed.** It describes an action to take
*after* the hotfix is deployed, by a person, once.

## Why this exists

Before the hotfix, all four task-creation screens inserted the assignment
notification from the browser, under the creator's session, addressed to the
assignee. No client role may write a `notifications` row for somebody else, so
the database refused it. The task was created; nobody was told.

One such task is known:

| | |
|---|---|
| task id | `87d87668-b434-43b8-a2d6-e94afc4bb855` |
| title | `test task` |
| assignee | `6507df9f-cdeb-4ebd-849f-8498c165d596` |
| notification | none — confirmed by query |

Any other task created in the same window has the same gap. This procedure fixes
one at a time, deliberately.

## What is deliberately NOT done

- **No backfill.** No script sweeps `tasks` for missing notifications and writes
  rows. A bulk insert of old notifications would put unread badges and unread
  counts on people's screens for work that has since moved on, and there is no
  way to preview it before it lands in production.
- **No task id in application code.** `87d87668-…` appears in this document and
  in nothing that ships. A production identifier compiled into the application
  is a fact that goes stale and cannot be corrected without a deploy.
- **No direct SQL insert.** Writing the row by hand bypasses every check the
  route performs, and gets the type, the title format or the push flag wrong the
  first time somebody does it from memory.

## The procedure

It is one authenticated POST to the same route the application uses:

```
POST /api/tasks/87d87668-b434-43b8-a2d6-e94afc4bb855/notify-assignment
```

**As a browser action**, which is the simplest form and needs no tooling — sign
in as the task's creator or as an admin, open any page of the application, and
run this in the developer console:

```js
await fetch('/api/tasks/87d87668-b434-43b8-a2d6-e94afc4bb855/notify-assignment',
            { method: 'POST' }).then(r => r.json())
```

The session cookie travels automatically. There is no body, no token to paste
and nothing to configure — the route reads no body at all.

**Expected responses:**

| Response | Meaning | Action |
|---|---|---|
| `{"status":"created"}` | the notification now exists | done |
| `{"status":"skipped_duplicate"}` | it already existed | done — nothing was written |
| `{"status":"skipped_self"}` | the task's assignee is its own creator | correct; no notification is owed |
| `403` | you are neither the task's creator nor an admin | sign in as the creator, or as an admin |
| `404` | the task no longer exists | nothing to do |
| `500` | the write failed | check the server log; safe to run again |

Every one of these is safe to repeat. The route checks for an existing
notification before writing, so a second run answers `skipped_duplicate`.

## What the route verifies before writing

All of it server-side, on every call, with the task id as the only input:

1. **The caller is authenticated** — from the session cookie. A missing session
   is 401, and the service-role client is not even constructed.
2. **The task still exists** — fetched by id; 404 if not.
3. **The caller is authorized** — the task's `created_by`, or an admin by
   `users.role`. Not the assignee: being the recipient does not entitle you to
   cause the notification.
4. **The recipient is derived from the task** — `tasks.assigned_to`, read from
   the row. Never supplied by the caller.
5. **No `task_assigned` notification already exists** for that task and that
   assignee — and if one does, nothing is written.

The body is `tasks.title`, read at the same moment; the type, headline and
`is_push_sent: false` come from code. There is no request body to influence any
of it.

## Confirming afterwards

```sql
select id, user_id, type, title, is_read, created_at
from   public.notifications
where  task_id = '87d87668-b434-43b8-a2d6-e94afc4bb855'
  and  type = 'task_assigned';
```

One row, `user_id` = `6507df9f-…`. The assignee's Task badge increments and the
row appears in their grouped card for that task.

## Finding others, if you want to

Read-only. It lists tasks assigned to somebody other than their creator that
have no assignment notification, newest first — not a backfill, a worklist:

```sql
select t.id, t.title, t.assigned_to, t.created_at
from   public.tasks t
left   join public.notifications n
       on n.task_id = t.id and n.type = 'task_assigned'
where  t.assigned_to is not null
  and  t.assigned_to <> t.created_by
  and  n.id is null
order  by t.created_at desc
limit  50;
```

Decide per task whether telling somebody now is useful. For an old, completed or
cancelled task it usually is not.
