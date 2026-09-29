import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDatesOnlyEdit, UNPRINTED_DATE_KEYS, type PiDiff } from './piEdit'

const diff = (over: Partial<PiDiff>): PiDiff => ({ fields: [], added: [], removed: [], changed: [], grandTotalDelta: null, ...over })
const field = (key: string) => ({ key, label: key, before: 'a', after: 'b' })

describe('a dates-only edit on a confirmed Order (20270122000000)', () => {
  test('the two unprinted dates, alone or together, are dates-only', () => {
    assert.deepEqual([...UNPRINTED_DATE_KEYS].sort(), ['due_date', 'order_confirmation_date'])
    assert.equal(isDatesOnlyEdit(diff({ fields: [field('due_date')] })), true)
    assert.equal(isDatesOnlyEdit(diff({ fields: [field('order_confirmation_date'), field('due_date')] })), true)
  })

  test('anything printed alongside makes it a revision', () => {
    assert.equal(isDatesOnlyEdit(diff({ fields: [field('due_date'), field('dispatch_commitment')] })), false)
    assert.equal(isDatesOnlyEdit(diff({ fields: [field('bill_to_phone')] })), false)
    assert.equal(isDatesOnlyEdit(diff({ fields: [field('due_date')], changed: [{} as PiDiff['changed'][number]] })), false)
    assert.equal(isDatesOnlyEdit(diff({ fields: [field('due_date')], added: [{} as PiDiff['added'][number]] })), false)
    assert.equal(isDatesOnlyEdit(diff({ fields: [field('due_date')], removed: [{} as PiDiff['removed'][number]] })), false)
  })

  test('no change is not a dates-only edit', () => {
    assert.equal(isDatesOnlyEdit(diff({})), false)
  })
})

describe('the Edit PI route diverts a dates-only edit before proposing a version', () => {
  const route = readFileSync(join(process.cwd(), 'src/app/api/orders/pi-edits/route.ts'), 'utf8').replace(/\r/g, '')

  test('it amends through the schedule editor, as the person', () => {
    const at = route.indexOf('if (isDatesOnlyEdit(diff))')
    assert.ok(at > 0, 'the route checks for a dates-only edit')
    assert.ok(at < route.indexOf("service.rpc('propose_order_pi_edit_revision'"), '…before it proposes a version')
    const branch = route.slice(at, route.indexOf("service.rpc('propose_order_pi_edit_revision'"))
    assert.match(branch, /authClient\.rpc\('update_order_submission_schedule_terms'/,
      'as the signed-in person, so the database decides the authority')
    assert.doesNotMatch(branch, /service\.rpc/, 'never as the service role')
    assert.match(branch, /dates_amended: true/)
  })
})
