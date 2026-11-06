// "Quick range" (components/ui/QuickRangeSelect.tsx): what it shows is worked
// out from the list's own From / To, so it never disagrees with the date boxes.
//
// Run:
//   npx tsx --import ./scripts/testing/screen-source-preload.mjs --test src/components/ui/QuickRangeSelect.render.test.tsx

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { QuickRangeSelect } from './QuickRangeSelect'
import { MONTH_RANGE_PRESETS, resolveMonthRange } from '@/lib/monthRangePresets'

const noop = () => {}
const render = (from: string, to: string) =>
  renderToStaticMarkup(<QuickRangeSelect from={from} to={to} onPick={noop} id="q" className="x" />)

test('it offers Any date and the five month presets, named "Quick range"', () => {
  const html = render('', '')
  assert.match(html, /aria-label="Quick range"/)
  assert.deepEqual(
    [...html.matchAll(/<option [^>]*>([^<]*)<\/option>/g)].map(m => m[1]),
    ['Any date', ...MONTH_RANGE_PRESETS.map(p => p.label)],
  )
  assert.match(html, /<option value="" selected="">Any date<\/option>/)
})

test('a range equal to a preset shows that preset, with no "Custom dates" entry', () => {
  const { from, to } = resolveMonthRange('last_month')
  const html = render(from, to)
  assert.match(html, /<option value="last_month" selected="">Last month<\/option>/)
  assert.doesNotMatch(html, /Custom dates/)
})

test('any other range, or one date alone, shows "Custom dates"', () => {
  for (const [from, to] of [['2026-10-02', '2026-10-30'], ['2026-10-01', ''], ['', '2026-10-31']]) {
    assert.match(render(from, to), /<option value="custom" disabled="" selected="">Custom dates<\/option>/)
  }
})
