import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { lockWarningText, runLockFlow } from './lockWarning'

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

const open = {
  code: 'attendance_unresolved', requires_acknowledgement: true, unresolved: 3, conflicts: 1, fingerprint: 'fp-1',
  employees: [{ full_name: 'Asha', unresolved: 2, conflicts: 1 }, { full_name: 'Bala', unresolved: 1, conflicts: 0 }],
}

describe('lock confirmation text', () => {
  test('open items and draft conflicts are counted and named; a reason is asked for', () => {
    const text = lockWarningText(open)
    assert.match(text, /3 unresolved salary items, of which 1 disagree with this draft/)
    assert.match(text, /Asha: 2 unresolved, 1 disagree with the draft/)
    assert.match(text, /type the reason below\. It is recorded with your name/)
  })
  test('a stale acknowledgement says the review changed', () => {
    assert.match(lockWarningText(open, true), /THE REVIEW CHANGED SINCE YOU LOOKED/)
  })
})

describe('refusals that can never be acknowledged', () => {
  test('an unreadable review (503) is shown as an error: no prompt, nothing sent again', async () => {
    const bodies: Record<string, unknown>[] = []
    let prompts = 0
    const out = await runLockFlow('t', 'p', 'Lock?', { confirm: () => true, prompt: () => { prompts++; return 'reason' } },
      async b => { bodies.push(b); return { ok: false, status: 503, json: { code: 'attendance_review_unavailable', retryable: true, error: 'could not be loaded … Try again in a moment.' } } })
    assert.equal(out.status, 'error')
    assert.match(out.error!, /Try again/)
    assert.equal(prompts, 0)
    assert.equal(bodies.length, 1)
  })

  test('a month still in progress is shown as an error, never acknowledged', async () => {
    let prompts = 0
    const out = await runLockFlow('t', 'p', 'Lock?', { confirm: () => true, prompt: () => { prompts++; return 'x' } },
      async () => ({ ok: false, status: 422, json: { code: 'payroll_month_in_progress', error: 'September 2026 has not ended yet' } }))
    assert.equal(out.status, 'error')
    assert.equal(prompts, 0)
  })
})

describe('the lock button follows the server', () => {
  const ui = (answers: (string | null)[], confirmed = true) => {
    const seen: string[] = []
    return {
      seen,
      ui: { confirm: (m: string) => { seen.push(m); return confirmed }, prompt: (m: string) => { seen.push(m); return answers.shift() ?? null } },
    }
  }

  test('nothing open: one confirmation, one request — the existing flow', async () => {
    const bodies: Record<string, unknown>[] = []
    const { ui: u, seen } = ui([])
    const out = await runLockFlow('t', 'p', 'Lock payroll for October?', u, async b => { bodies.push(b); return { ok: true, status: 200, json: { success: true } } })
    assert.equal(out.status, 'locked')
    assert.deepEqual(bodies, [{ payroll_period_id: 'p' }])
    assert.equal(seen.length, 1)
  })

  test('open items: the reason and the SERVER\'S fingerprint are sent back', async () => {
    const bodies: Record<string, unknown>[] = []
    const replies = [{ ok: false, status: 409, json: open }, { ok: true, status: 200, json: { success: true } }]
    const out = await runLockFlow('t', 'p', 'Lock?', ui(['Agreed with accounts']).ui, async b => { bodies.push(b); return replies.shift()! })
    assert.equal(out.status, 'locked')
    assert.deepEqual(bodies[1], { payroll_period_id: 'p', attendance_acknowledgement: { fingerprint: 'fp-1', reason: 'Agreed with accounts' } })
  })

  test('no reason → nothing is locked', async () => {
    let calls = 0
    const out = await runLockFlow('t', 'p', 'Lock?', ui(['  ']).ui, async () => { calls++; return { ok: false, status: 409, json: open } })
    assert.equal(out.status, 'cancelled')
    assert.equal(calls, 1)
  })

  test('stale acknowledgement: the fresh state is shown and re-acknowledged with the NEW fingerprint', async () => {
    const bodies: Record<string, unknown>[] = []
    const replies = [
      { ok: false, status: 409, json: open },
      { ok: false, status: 409, json: { ...open, code: 'attendance_ack_stale', fingerprint: 'fp-2', unresolved: 4 } },
      { ok: true, status: 200, json: { success: true } },
    ]
    const { ui: u, seen } = ui(['first', 'second'])
    const out = await runLockFlow('t', 'p', 'Lock?', u, async b => { bodies.push(b); return replies.shift()! })
    assert.equal(out.status, 'locked')
    assert.match(seen[2], /THE REVIEW CHANGED/)
    assert.deepEqual((bodies[2].attendance_acknowledgement as { fingerprint: string }).fingerprint, 'fp-2')
  })

  test('both Lock buttons use the server-checked flow', () => {
    for (const p of ['src/app/payroll/page.tsx', 'src/app/payroll/results/[periodId]/page.tsx']) {
      const src = read(p)
      assert.ok(src.includes('runLockFlow('), p)
      assert.equal(src.includes("fetch('/api/payroll/lock'"), false, `${p} must not call the lock API around the acknowledgement`)
    }
    assert.ok(read('src/app/api/payroll/lock/route.ts').includes('lockPayrollPeriod('))
  })
})
