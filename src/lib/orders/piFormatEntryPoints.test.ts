// THE PI FORMAT HAS TWO ENTRY POINTS, AND ONE ACTION (#258).
//
// Orders' left navigation (under PI Drafts) and the PI Drafts heading render the same component,
// which points at the existing route and the existing file name. The dashboard no longer carries it.
//
// Run with: npx tsx --test "src/lib/orders/piFormatEntryPoints.test.ts"

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PI_FORMAT_ACTION, PI_FORMAT_FILENAME } from './piFormat'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const link = read('src/components/orders/PiFormatLink.tsx')
const layout = read('src/components/layout/OrdersLayout.tsx')
const drafts = read('src/app/orders/drafts/page.tsx')
const dashboard = read('src/app/orders/page.tsx')

describe('the PI format entry points', () => {
  test('both variants are plain download links to the one existing route and file name', () => {
    assert.equal((link.match(/href=\{PI_FORMAT_ACTION\.href\}/g) ?? []).length, 2)
    assert.equal((link.match(/download=\{PI_FORMAT_FILENAME\}/g) ?? []).length, 2)
    assert.equal((link.match(/<a\b/g) ?? []).length, 2)
    assert.equal(PI_FORMAT_ACTION.href, '/api/orders/pi-format')
    assert.equal(PI_FORMAT_FILENAME, 'BOE-PI-Format.xlsx')
    assert.doesNotMatch(link, /fetch\(|Blob|createObjectURL|\.xlsx|storage/, 'no second template, no client-built file')
  })
  test('the left navigation shows it directly after PI Drafts, never lit', () => {
    assert.match(layout, /item\.key === 'drafts' \? <PiFormatNavLink/)
    assert.doesNotMatch(link.slice(link.indexOf('PiFormatNavLink')), /aria-current/)
  })
  test('the PI Drafts heading shows it to everyone, not only holders of orders.create', () => {
    const actions = drafts.slice(drafts.indexOf('actions={('))
    assert.ok(actions.indexOf('<PiFormatButton />') > 0)
    assert.ok(actions.indexOf('canCreate ?') < actions.indexOf('<PiFormatButton />'))
    assert.match(actions.slice(0, actions.indexOf('<PiFormatButton />')), /\) : null\}/, 'the button is outside the canCreate condition')
  })
  test('the dashboard no longer carries it', () => {
    assert.doesNotMatch(dashboard, /PI_FORMAT|Download PI Format|pi-format/)
  })
  test('permission rules are untouched: the route still asks orders.view, not a new rule', () => {
    const route = read('src/app/api/orders/pi-format/route.ts')
    assert.match(route, /hasPermission\(service, user\.id, 'orders', 'view'\)/)
  })
})
