/**
 * 20270418000000 — "Not received" is final; handovers carry whole payments only.
 * The behaviour is proven on PGlite by
 * supabase/tests/handover_not_received_final_pglite.mjs; this pins the migration
 * text and the screens' wording so neither drifts back.
 *
 * Run: npx tsx --test src/lib/finance/handoverNotReceivedFinal.test.ts
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const SQL = read('supabase/migrations/20270418000000_finance_handover_not_received_final.sql')

describe('the migration', () => {
  test('nothing in it still treats a disputed handover as open', () => {
    assert.doesNotMatch(SQL.slice(SQL.indexOf('-- ── 1.'), SQL.indexOf('-- ── Apply-time assertions')), /'pending', 'disputed'\)/)
  })

  test('the guard closes a disputed handover like accepted and cancelled', () => {
    assert.match(SQL, /\(old\.status = 'pending' and new\.status in \('accepted', 'disputed', 'cancelled'\)\)/)
    assert.match(SQL, /elsif old\.status in \('accepted', 'disputed', 'cancelled'\) then/)
    assert.doesNotMatch(SQL, /old\.status = 'disputed' and new\.status/)
  })

  test('a typed cash amount is refused; the call shape is unchanged', () => {
    assert.match(SQL, /if coalesce\(p_cash_from_hand, 0\) <> 0 or coalesce\(p_cash_new, 0\) <> 0 then\n\s+raise exception 'HANDOVER_FULL_PAYMENTS_ONLY/)
    assert.match(SQL, /create or replace function public\.create_cash_handover\(\n\s+p_recipient\s+uuid,/)
  })

  test('the giver is told plainly that the cash is still theirs', () => {
    assert.match(SQL, /'Cash not received',/)
    assert.match(SQL, /The cash is still with you; hand it over again when you have given it\./)
  })

  test('every restated body is one of the fourteen named, each from its source', () => {
    const sections = SQL.match(/^-- ── \d+\. /gm) ?? []
    assert.equal(sections.length, 14)
    assert.equal((SQL.match(/^-- Restated from 2027041\d{7};/gm) ?? []).length, 14)
  })

  test('it touches no table, column, policy or grant', () => {
    const body = SQL.replace(/^--.*$/gm, '')
    assert.doesNotMatch(body, /\b(alter|create|drop)\s+(table|policy|trigger|index)\b/i)
    assert.doesNotMatch(body, /^\s*(grant|revoke)\b/im)
  })
})

describe('the screens say "Not received"', () => {
  const card = read('src/components/finance/HandoverCard.tsx')
  test('the recipient\'s action and its dialog', () => {
    assert.match(card, />\s*Not received\s*</)
    assert.match(card, /title="Cash not received"/)
    assert.match(card, /The whole handover is refused and the cash stays with the giver\./)
    assert.doesNotMatch(card, /received less/)
  })
  test('history has a Not received tab and counts it as closed', () => {
    const page = read('src/app/finance/handovers/page.tsx')
    assert.match(page, /statuses: \['accepted', 'disputed', 'cancelled'\]/)
    assert.match(page, /label: 'Not received', statuses: \['disputed'\]/)
  })
})
