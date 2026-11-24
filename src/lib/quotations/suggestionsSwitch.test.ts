// Who sees the suggested prices (owner, 18 Nov 2026; 20270731000000): everyone, or only the administrator who switched
// it; the others see NO price hint at all, history included (owner, 24 Nov 2026). The database decides who may change it.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SQL = readFileSync('supabase/migrations/20270731000000_quotation_suggestions_switch.sql', 'utf8')
const BUILDER = readFileSync('src/components/quotations/BuilderScreen.tsx', 'utf8')

describe('price suggestions switch', () => {
  test('a new one-row table that starts as everyone; only an administrator changes it; "only me" keeps the caller', () => {
    assert.match(SQL, /create table public\.quotation_suggestion_settings/)
    assert.doesNotMatch(SQL, /alter table public\.(?!quotation_suggestion_settings)/, 'no existing table changes')
    assert.match(SQL, /if not a\.p_admin then raise exception 'QUOTATIONS_FORBIDDEN/)
    assert.match(SQL, /set shown_to = case when coalesce\(p_everyone, true\) then null else array\[a\.p_uid\] end/)
    assert.match(SQL, /'for_me', s\.shown_to is null or a\.p_uid = any\(s\.shown_to\)/)
    assert.match(SQL, /revoke all on function public\.quotation_suggestions_set\(boolean\) from public, anon/)
    assert.match(SQL, /must start as everyone/)
  })

  test('someone who does not see suggestions gets no hint at all: no history (last ordered / quoted), and no hints read', () => {
    assert.match(BUILDER, /hint=\{suggestOn \? hintFor\.get\(l\.name\.trim\(\)\) : undefined\}/)
    assert.match(BUILDER, /enabled: accessLoaded && !notSetUp && suggestOn && hintNames !== ''/)
    assert.doesNotMatch(BUILDER, /historyOnly/)
  })

  test('the builder asks once, and off means no model, no taught-price picker and no pool read', () => {
    assert.match(BUILDER, /const suggestOn = suggQ\.isError \? true : !!suggQ\.data\?\.for_me/)
    assert.match(BUILDER, /enabled: accessLoaded && !notSetUp && suggestOn && typeWords !== ''/)
    assert.match(BUILDER, /fetchLibrary\(supabase\), enabled: accessLoaded && !notSetUp && suggestOn/)
    assert.match(BUILDER, /model=\{suggestOn \? modelFor\.get\(l\.key\) : null\} taught=\{suggestOn \? taught : undefined\}/)
  })
})
