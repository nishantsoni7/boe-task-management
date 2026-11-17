// The PI draft's sample box (17 Nov 2026, page speed): given the value the page's sales-details read already has, it
// reads nothing itself; not given, it reads its own column as before.
import { mount } from '@/lib/testing/domHarness'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { PiSampleType } from './PiSampleType'

function fakeSupabase(value: string | null) {
  const reads: string[] = []
  const chain = {
    select: (cols: string) => { reads.push(cols); return chain },
    eq: () => chain,
    maybeSingle: async () => ({ data: { sample_type: value }, error: null }),
  }
  return { reads, supabase: { from: () => chain, rpc: async () => ({ error: null }) } as unknown as SupabaseClient }
}
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 10)) })
const base = { submissionId: 's1', canEdit: true, rowVersion: 3, onSaved: () => {} }

describe('PI sample type box', () => {
  test('given the page\'s value, it shows the box and reads nothing', async () => {
    const { reads, supabase } = fakeSupabase('free')
    const ui = mount(createElement(PiSampleType, { ...base, supabase, known: null }))
    await settle()
    assert.equal(reads.length, 0)
    assert.ok(ui.text().length > 0, 'the box is drawn')
    ui.unmount()
  })

  test('not given, it reads its own column as before', async () => {
    const { reads, supabase } = fakeSupabase(null)
    const ui = mount(createElement(PiSampleType, { ...base, supabase }))
    await settle()
    assert.deepEqual(reads, ['sample_type'])
    ui.unmount()
  })

  test('the page passes the value its sales-details read has, and the cost sheet is not re-read for the first version', async () => {
    const { readFileSync } = await import('node:fs')
    const page = readFileSync('src/app/orders/drafts/[submissionId]/page.tsx', 'utf8')
    assert.match(page, /knownSampleType=\{salesDetails\.available \? salesDetails\.sample_type : undefined\}/)
    assert.match(page, /const costsVersion = rowVersion !== null && rowVersion !== firstRowVersion \? rowVersion : ''/)
    assert.match(page, /useProductCosts\(submissionId, `\$\{costsVersion\}:\$\{costSheetSaves\}`\)/)
  })
})
