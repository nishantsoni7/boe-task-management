/**
 * The presentation-only rule used by the branch-scope guards (expenseSurfaces.test.ts and friends) must pass
 * recolouring and nothing else. These are its negative controls: every behavioural change below has to FAIL.
 *
 * Colour values are written without their leading `#` and joined at run time (`c('111318')`), so that no
 * palette sweep can ever rewrite this file's fixtures and quietly turn "old colour → new colour" into
 * "same colour → same colour".
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { isPresentationOnlyDiff, styleBlind } from './presentationDiff'

const c = (hex: string) => '#' + hex
const diff = (removed: string[], added: string[]) =>
  ['--- a/x', '+++ b/x', '@@ -1 +1 @@', ...removed.map((l) => '-' + l), ...added.map((l) => '+' + l)].join('\n')

describe('what the rule accepts: a change of how it looks', () => {
  const ok = (removed: string, added: string, css = false) => {
    assert.notEqual(removed, added, 'a control that changes nothing proves nothing')
    assert.equal(isPresentationOnlyDiff(diff([removed], [added]), css), true, `${removed}  →  ${added}`)
  }

  test('colours', () => {
    ok(`  <div style={{ color: '${c('111318')}', background: '${c('F4F5F7')}' }}>`, `  <div style={{ color: '${c('303536')}', background: '${c('F7F5F1')}' }}>`)
    ok("  border: '1px solid rgba(0,0,0,0.08)',", `  border: '1px solid ${c('E4DED7')}',`)
    ok('  color: colors.blue,', '  color: colors.brand,')
    ok(`  .x { color: ${c('5585E8')}; }`, `  .x { color: ${c('335A86')}; }`, true)
    ok(`  const tone = isLate ? '${c('D94F4F')}' : '${c('45A870')}'`, `  const tone = isLate ? '${c('B42332')}' : '${c('2F7A52')}'`)
  })
  test('sizes, radii, weights and font families', () => {
    ok("  fontSize: '11px', borderRadius: '10px',", "  fontSize: '12px', borderRadius: '8px',")
    ok('  font-size: 10.5px;', '  font-size: 12px;', true)
    ok('  fontFamily: font.mono,', '  fontFamily: font.body,')
    ok("  fontFamily: 'var(--font-mono)',", "  fontFamily: 'var(--font-body)',")
  })
})

describe('what the rule refuses: anything that is not only appearance', () => {
  const no = (removed: string[], added: string[], css = false) =>
    assert.equal(isPresentationOnlyDiff(diff(removed, added), css), false, `${removed.join(' / ')}  →  ${added.join(' / ')}`)

  test('a changed condition, number or comparison', () => {
    no(['  if (amount > 100) return true'], ['  if (amount > 200) return true'])
    no(['  const retries = 3'], ['  const retries = 5'])
    no([`  if (code === '${c('FF0000')}') block()`], [`  if (code === '${c('00FF00')}') block()`])
    no([`  if (['${c('FF0000')}'].includes(code)) block()`], [`  if (['${c('00FF00')}'].includes(code)) block()`])
    no(['  const padding = 5 // rows per page'], ['  const padding = 6 // rows per page'])
  })
  test('a different identifier that merely looks like a token', () => {
    no(['  const next = status.completed'], ['  const next = status.cancelled'])
    no(['  return radius.small'], ['  return radius.large'])
  })
  test('a line added, removed or rewritten', () => {
    no([], ["  await supabase.from('finance_payment_requests').delete().eq('id', id)"])
    no(['  await save(id)'], [])
    no(['  <button onClick={approve}>Approve</button>'], ['  <button onClick={reject}>Approve</button>'])
    no(['  <button>Approve</button>'], ['  <button>Reject</button>'])
  })
  test('a colour change that also changes behaviour on the same line', () => {
    no([`  style={{ color: '${c('111318')}' }} onClick={approve}`], [`  style={{ color: '${c('303536')}' }} onClick={reject}`])
  })
  test('an empty diff is not "presentation-only"', () => {
    assert.equal(isPresentationOnlyDiff('', false), false)
  })
})

describe('styleBlind', () => {
  test('equal up to presentation, different when structure differs', () => {
    assert.equal(styleBlind(`<a style={{ color: '${c('111')}' }}>x</a>`), styleBlind(`<a style={{ color: '${c('222')}' }}>x</a>`))
    assert.notEqual(styleBlind(`<a style={{ color: '${c('111')}' }}>x</a>`), styleBlind(`<a style={{ color: '${c('111')}' }}>y</a>`))
  })
})
