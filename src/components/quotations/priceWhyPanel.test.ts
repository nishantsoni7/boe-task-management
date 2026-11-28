// Why this price and the Teach panel (28 Nov 2026): the wiring that a test of one component cannot see.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (f: string) => readFileSync(f, 'utf8')
const classesOf = (css: string) => new Set([...css.matchAll(/\.([A-Za-z][A-Za-z0-9_]*)\b/g)].map(m => m[1]))
const used = (src: string, prefix: string) => [...src.matchAll(new RegExp(`\b${prefix}\.([A-Za-z][A-Za-z0-9_]*)`, 'g'))].map(m => m[1])

describe('style classes exist in the stylesheet each file takes them from (a missing one fails silently)', () => {
  const dir = 'src/components/quotations/'
  const quotations = classesOf(read(dir + 'quotations.module.css'))
  const why = classesOf(read(dir + 'priceWhy.module.css'))
  const panel = classesOf(read(dir + 'teachPanel.module.css'))
  const training = classesOf(read('src/components/pricing/training/training.module.css'))
  test('PriceWhy and the price card', () => {
    const src = read(dir + 'PriceWhy.tsx')
    for (const c of used(src, 'w')) assert.ok(why.has(c), `priceWhy.module.css has no .${c}`)
    for (const c of used(src, 's')) assert.ok(quotations.has(c), `quotations.module.css has no .${c}`)
    for (const c of used(read(dir + 'PricingDesk.tsx'), 's')) assert.ok(quotations.has(c), `quotations.module.css has no .${c}`)
  })
  test('the Teach panel and the case form inside it', () => {
    for (const c of used(read(dir + 'TeachPanel.tsx'), 'w')) assert.ok(panel.has(c), `teachPanel.module.css has no .${c}`)
    for (const c of used(read('src/components/pricing/training/TrainingCase.tsx'), 't')) assert.ok(training.has(c), `training.module.css has no .${c}`)
  })
})

describe('the builder offers Teach only to people who may, on a quotation that can be edited, and refreshes what the estimator learns from', () => {
  const screen = read('src/components/quotations/BuilderScreen.tsx')
  test('who may teach: Pricing, and Create on it (the database asks the same)', () => {
    assert.match(screen, /const mayTeach = seesWhy && !!teachAccessQ\.data\?\.create/)
    assert.match(screen, /onTeach=\{mayTeach && editable \? note => setTeachFor\(\{ key: l\.key, note \}\) : undefined\}/)
  })
  test('once taught, the line picks the case and takes its price, and the estimator, the taught list and the rework are read again at once', () => {
    assert.match(screen, /updLine\(line\.key, \{ internal_note: withPick\(line\.internal_note, r\.caseNo\), unit_price: price \}\)/)
    for (const key of ['trainingKeys.library', "['quotations', 'pool']", "['pricing', 'rework']", "['pricing', 'pool']"]) assert.ok(screen.includes(key), key)
    assert.match(screen, /closeNotesFor\(supabase, id, line\.name, r\.caseNo\)/)
  })
  test('the panel opens over the page: the quotation is not left, and the new tab is gone', () => {
    assert.match(screen, /<TeachPanel /)
    assert.doesNotMatch(read('src/components/quotations/PricingDesk.tsx'), /window\.open|stashPrefill/)
  })
})

describe('the Teach panel is the Training form, not a second copy of it', () => {
  const panel = read('src/components/quotations/TeachPanel.tsx')
  test('it renders TrainingCase embedded and closes with Escape, not with a click outside', () => {
    assert.match(panel, /<TrainingCase embedded=\{\{ prefill, onTaught, onCancel: onClose \}\} \/>/)
    assert.match(panel, /useDialogFocus<HTMLDivElement>\(onClose\)/)
    assert.doesNotMatch(panel, /onClick=\{e => \{ if \(e\.target === e\.currentTarget\)/, 'a case being typed is not lost by a stray click')
  })
  test('embedded, the form is always a new case, saved and submitted in one go, without changing page', () => {
    const form = read('src/components/pricing/training/TrainingCase.tsx')
    assert.match(form, /const routeId = embedded \? 'new' : String\(params\?\.id \?\? 'new'\)/)
    assert.match(form, /embedded\.onTaught\(\{ id, caseNo: made\.case_no, price: build\.total \}\)/)
    assert.ok(form.indexOf('embedded.onTaught') < form.indexOf("router.replace(`/pricing/training/${id}`)"), 'the panel answers before the page would change')
    assert.match(form, /boxes, setBoxes\] = useState<Boxes>\(\(\) => \(origin \? startBoxes\(origin\.name\) : emptyBoxes\(\)\)\)/)
  })
})
