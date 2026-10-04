import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Source pins: the three Acknowledge screens save through acknowledge_task() and nothing else, and the migration is the
// same kind of door change_task_status() is. Executed behaviour is in acknowledgeTask.test.ts (the client) and
// supabase/tests/task_acknowledge_assertions.sql (the database).

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n')

const CALLERS = [
  { file: 'src/app/tasks/[id]/page.tsx', fn: 'const acknowledge = async', next: 'const applyStatusChange = async', tag: 'acknowledge' },
  { file: 'src/app/tasks/my/page.tsx', fn: 'const handleAcknowledge = async', next: 'const handleDelete = async', tag: 'my-tasks/acknowledge' },
  { file: 'src/app/dashboard/page.tsx', fn: 'const handleAcknowledge = async', next: 'const userMap = useMemo', tag: 'dashboard/acknowledge' },
]

function body(file: string, fn: string, next: string): string {
  const text = read(file)
  const a = text.indexOf(fn)
  assert.ok(a >= 0, `${file}: ${fn} not found`)
  const b = text.indexOf(next, a)
  assert.ok(b > a, `${file}: ${next} not found after ${fn}`)
  return text.slice(a, b)
}

for (const c of CALLERS) {
  test(`${c.file}: Acknowledge is ONE database call — no browser-side tasks update or history insert`, () => {
    const src = body(c.file, c.fn, c.next)
    assert.match(src, /acknowledgeTask\(supabase,/)
    assert.doesNotMatch(src, /\.from\('tasks'\)/, 'no direct tasks write')
    assert.doesNotMatch(src, /\.from\('task_activity_log'\)/, 'no direct history write')
    assert.doesNotMatch(src, /acknowledged_at:\s*now/, 'no browser-made acknowledgement stamp')
    assert.doesNotMatch(src, /new Date\(\)\.toISOString\(\)/, 'no browser clock')
    assert.match(read(c.file), /from '@\/lib\/tasks\/acknowledgeTask'/)
  })

  test(`${c.file}: only an answer (or a read-back of our own row) is adopted; the message is shown for everything else`, () => {
    const src = body(c.file, c.fn, c.next)
    assert.match(src, /adoptableAck\(outcome\)/)
    assert.match(src, /acknowledgeMessage\(outcome\)/)
    assert.match(src, /shouldAnnounceAck\(outcome\)/)
    // The fixed "Failed to acknowledge" alert that treated every failure alike is gone.
    assert.doesNotMatch(src, /Failed to acknowledge task/)
  })

  test(`${c.file}: the acknowledgement notice is still sent for the creator, with its own log tag`, () => {
    const src = body(c.file, c.fn, c.next)
    assert.match(src, /postAcknowledgedNotice\(/)
    assert.ok(src.includes(`'${c.tag}'`), `tag ${c.tag}`)
    assert.doesNotMatch(src, /fetch\('\/api\/notify-status-update'/, 'the fetch lives in one shared helper')
  })
}

test('the double-click guards are kept (and added to My Tasks, which had none)', () => {
  const detail = body(CALLERS[0].file, CALLERS[0].fn, CALLERS[0].next)
  assert.match(detail, /if \(acknowledgingRef\.current\) return\s*\n\s*acknowledgingRef\.current = true/)
  assert.match(detail, /finally \{[\s\S]*acknowledgingRef\.current = false[\s\S]*setAcknowledging\(false\)/)

  const my = body(CALLERS[1].file, CALLERS[1].fn, CALLERS[1].next)
  assert.match(my, /if \(acknowledgingRef\.current\) return\s*\n\s*acknowledgingRef\.current = true/)
  assert.match(my, /finally \{\s*acknowledgingRef\.current = false/)

  const dash = body(CALLERS[2].file, CALLERS[2].fn, CALLERS[2].next)
  assert.match(dash, /if \(acknowledgingIds\.has\(task\.id\)\) return/)
  assert.match(dash, /finally \{[\s\S]*next\.delete\(task\.id\)/, 'released on every path, including a thrown one')
})

test('the notification route is untouched: it still reads action "acknowledged" and the status-change path is not involved', () => {
  const route = read('src/app/api/notify-status-update/route.ts')
  assert.match(route, /acknowledged/)
  const helper = read('src/lib/tasks/acknowledgeTask.ts')
  assert.match(helper, /action: 'acknowledged'/)
  assert.doesNotMatch(helper, /activityLogId/, 'the acknowledged notice stays unlinked')
  assert.doesNotMatch(helper, /change_task_status|tasks\/statusChange/, 'independent of the status-change work')
})

test('the shared client reconciles by reading, and never sends the mutation twice', () => {
  const helper = read('src/lib/tasks/acknowledgeTask.ts')
  assert.equal((helper.match(/\.rpc\(/g) ?? []).length, 1, 'one rpc call site')
  assert.match(helper, /AbortSignal\.timeout\(ACK_WRITE_TIMEOUT_MS\)/)
  assert.match(helper, /ACK_WRITE_TIMEOUT_MS = 30_000/)
  assert.doesNotMatch(helper, /\.update\(|\.insert\(|\.upsert\(|\.delete\(/, 'the read-back cannot write')
})

// ── The migration ────────────────────────────────────────────────────────────

const MIGRATION = 'supabase/migrations/20270303000000_task_acknowledge_rpc.sql'

test('acknowledge_task() is a locked, definer-safe, authenticated-only door', () => {
  const sql = read(MIGRATION)
  const code = sql.replace(/^\s*--.*$/gm, '')
  assert.match(code, /create or replace function public\.acknowledge_task\(p_task_id uuid\)/)
  assert.match(code, /security definer/)
  assert.match(code, /set search_path = public, pg_temp/)
  assert.match(code, /v_uid\s+uuid := auth\.uid\(\)/)
  assert.match(code, /from public\.tasks where id = p_task_id for update/)
  // The only parameter is the task id: no actor, time, status or note arrives from the browser.
  assert.doesNotMatch(code, /p_actor|p_user|p_now|p_status|p_note/)
  assert.match(code, /revoke all\s+on function public\.acknowledge_task\(uuid\) from public, anon;/)
  assert.match(code, /grant execute on function public\.acknowledge_task\(uuid\) to authenticated;/)
  assert.doesNotMatch(code, /\bto (anon|public)\b/)
  // Every object the body touches is schema-qualified.
  const fnBody = code.slice(code.indexOf('as $$'), code.indexOf('$$;'))
  assert.doesNotMatch(fnBody, /\b(from|into|update)\s+(?!public\.)(tasks|task_activity_log)\b/)
})

test('acknowledge_task() writes the stamp, Working and BOTH history rows — and nothing else', () => {
  const code = read(MIGRATION).replace(/^\s*--.*$/gm, '')
  assert.match(code, /acknowledged_at = v_now/)
  assert.match(code, /status\s+= 'working'::public\.task_status/)
  assert.match(code, /values \(p_task_id, v_uid, 'acknowledged', null\)/)
  assert.match(code, /values \(p_task_id, v_uid, 'status_changed', v_from, v_task\.status, null\)/)
  assert.equal((code.match(/insert into public\.task_activity_log/g) ?? []).length, 2)
  assert.doesNotMatch(code, /insert into public\.notifications/, 'no notification is written here')
  for (const rule of ['TASK_ACK_FORBIDDEN', 'TASK_ACK_NOT_APPLICABLE', 'TASK_ALREADY_ACKNOWLEDGED', 'TASK_ACK_WRONG_STATUS', 'TASK_NOT_FOUND']) {
    assert.ok(code.includes(rule), rule)
  }
  assert.match(code, /'quotation_request'/)
  assert.match(code, /'pending', 'started', 'working', 'waiting', 'blocked'/)
})
