/**
 * PI CORRECTION REQUESTS — what migration 20260930000000 promises.
 *
 * Behavioural proof: supabase/tests/order_submission_correction_requests_assertions.sql.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATION = 'supabase/migrations/20260930000000_order_submission_correction_requests.sql'
const sql = readFileSync(join(process.cwd(), MIGRATION), 'utf8')
const code = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
const raise = code.slice(code.indexOf('function public.request_order_submission_correction'))
const raiseBody = raise.slice(0, raise.indexOf('$$;') + 3)
const close = code.slice(code.indexOf('function public.resolve_order_submission_correction'))
const closeBody = close.slice(0, close.indexOf('$$;') + 3)

describe('a request changes NO PI data', () => {
  test('the raising function writes to no PI or Order table', () => {
    // The entire promise of the feature. Checked here AND re-derived by the
    // migration from its own installed definition at apply time.
    assert.ok(!/update\s+public\.order_submissions/i.test(raiseBody))
    assert.ok(!/update\s+public\.orders\b/i.test(raiseBody))
    assert.ok(!/delete\s+from/i.test(raiseBody))
    assert.match(code, /writes PI or Order data; it must not/)
  })

  test('it inserts into exactly one table', () => {
    const inserts = [...raiseBody.matchAll(/insert into (\S+)/g)].map(m => m[1])
    assert.deepEqual(inserts, ['public.order_submission_correction_requests'])
  })
})

describe('who may raise one, and when', () => {
  test('the OWNER only — not an admin, not a reviewer', () => {
    assert.match(raiseBody, /ORDER_SUBMISSION_NOT_OWNER/)
    assert.match(raiseBody, /v_sub\.created_by is distinct from v_actor/)
    assert.match(raiseBody, /v_sub\.submitted_by is distinct from v_actor/)
  })

  test('only once the PI has left their hands', () => {
    // While it is still editable the owner has a faster door, and offering the
    // request form there would be offering the slower of two.
    assert.match(raiseBody, /ORDER_SUBMISSION_STILL_EDITABLE/)
  })

  test('one open request per section', () => {
    assert.match(raiseBody, /ORDER_SUBMISSION_REQUEST_ALREADY_OPEN/)
  })
})

describe('what a request must carry', () => {
  test('a section from a fixed set', () => {
    assert.match(code, /check \(section in \('client', 'schedule', 'products', 'commercial', 'other'\)\)/)
    assert.match(raiseBody, /ORDER_SUBMISSION_BAD_SECTION/)
  })

  test('a requested change AND a mandatory reason, both bounded', () => {
    assert.match(raiseBody, /ORDER_SUBMISSION_NO_CHANGE_REQUESTED/)
    assert.match(raiseBody, /ORDER_SUBMISSION_NO_REASON/)
    assert.match(raiseBody, /ORDER_SUBMISSION_TEXT_TOO_LONG/)
    assert.match(code, /char_length\(requested_change\) <= 1000/)
    assert.match(code, /char_length\(reason\) <= 1000/)
  })

  test('and it lands in PI Activity', () => {
    assert.match(raiseBody, /'correction_requested'/)
    assert.match(raiseBody, /log_order_submission_activity/)
  })
})

describe('closing one', () => {
  test('is an ACTIVE ADMIN only, through the same predicate that amends a PI', () => {
    // Deciding what happens to a reviewed record is the same authority as
    // amending one, so it uses the same predicate rather than a second rule.
    assert.match(closeBody, /can_admin_edit_order_submission\(v_req\.submission_id\)/)
    assert.match(closeBody, /ORDER_SUBMISSION_NOT_ADMIN/)
  })

  test('a rejection must say why', () => {
    assert.match(closeBody, /ORDER_SUBMISSION_NO_REJECTION_NOTE/)
  })

  test('records the actor, the time and the edit that answered it', () => {
    assert.match(closeBody, /resolved_by = v_actor/)
    assert.match(closeBody, /resolved_at = now\(\)/)
    assert.match(closeBody, /resolved_edit_activity_id = p_edit_activity_id/)
  })

  test('and the linked edit must belong to THIS PI', () => {
    assert.match(closeBody, /ORDER_SUBMISSION_BAD_EDIT_LINK/)
    assert.match(closeBody, /a\.submission_id = v_req\.submission_id/)
  })

  test('a closed request stays closed', () => {
    // Re-closing would overwrite who decided and when, which is the part worth
    // keeping.
    assert.match(closeBody, /ORDER_SUBMISSION_REQUEST_CLOSED/)
  })

  test('and NOTHING deletes a request, ever', () => {
    assert.ok(!/delete\s+from/i.test(closeBody))
    assert.match(code, /a refused request is history/)
    assert.match(sql, /NEVER deleted/)
  })
})

describe('the table', () => {
  test('is read-only from a client; every write goes through the two RPCs', () => {
    assert.match(code, /grant select on table public\.order_submission_correction_requests to authenticated/)
    assert.ok(!/grant (insert|update|delete)[^;]*order_submission_correction_requests/i.test(code))
    assert.match(code, /directly writable by a client role/)
  })

  test('is visible to whoever may already see the PI — no second audience', () => {
    assert.match(code, /using \(public\.can_view_order_submission\(submission_id\)\)/)
  })

  test('cannot hold a half-closed state', () => {
    // One constraint rather than three, so the states cannot drift apart.
    assert.match(code, /order_submission_correction_requests_closure/)
  })
})

describe('this is not a workflow engine', () => {
  test('three states, and they are named in the table', () => {
    assert.match(code, /check \(status in \('open', 'resolved', 'rejected'\)\)/)
  })

  test('no configurable transitions, no rules table', () => {
    assert.ok(!/transition|state_machine|workflow_rules|_config\b/i.test(code))
    assert.match(sql, /THIS IS NOT A WORKFLOW ENGINE/)
  })
})

describe('the notification reuses the existing pattern', () => {
  const route = readFileSync(
    join(process.cwd(), 'src/app/api/orders/submissions/notify/route.ts'), 'utf8')

  test('the three new events join the existing union', () => {
    for (const e of ['pi_correction_requested', 'pi_correction_resolved', 'pi_correction_rejected']) {
      assert.ok(route.includes(`'${e}'`), `${e} is not handled`)
    }
  })

  test('recipients are resolved SERVER-SIDE, never named by the browser', () => {
    const block = route.slice(route.indexOf("event === 'pi_correction_requested'"))
    const scoped = block.slice(0, block.indexOf("} else if"))
    assert.ok(scoped.includes("eq('role', 'admin')") || scoped.includes('users_with_module_permission'))
    assert.ok(!scoped.includes('body.recipients'))
  })

  test('and the client type agrees with the route', () => {
    const notify = readFileSync(join(process.cwd(), 'src/lib/notify.ts'), 'utf8')
    for (const e of ['pi_correction_requested', 'pi_correction_resolved', 'pi_correction_rejected']) {
      assert.ok(notify.includes(`'${e}'`), `${e} missing from the client union`)
    }
  })
})

describe('the migration itself', () => {
  test('is forward-only and dependency-checked', () => {
    assert.ok(Number(MIGRATION.split('/').pop()!.split('_')[0]) > 20260929000000)
    assert.match(code, /DEPENDENCY MISSING: 20260929000000/)
  })

  test('drops nothing an earlier migration owns', () => {
    assert.ok(!/drop (table|column|policy|constraint|function)/i.test(code))
  })
})
