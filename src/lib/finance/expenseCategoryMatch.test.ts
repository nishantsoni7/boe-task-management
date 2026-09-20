/**
 * SMART SUGGESTION — the matcher, on its own.
 *
 * Every test here is a pure function call. There is no database, no browser and
 * no network, which is not merely convenient: it is the proof that the feature
 * has no hosted model behind it. A suggestion engine that needed an API key
 * could not be tested like this.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { ExpenseCategory } from './expenses'
import {
  MAX_SUGGESTIONS,
  MIN_SUGGESTION_SCORE,
  learnableHistory,
  normalizeWord,
  payeeKey,
  phraseTerms,
  proposeNewCategoryName,
  suggestCategories,
  suggestionReasonText,
  type ExpenseHistoryEntry,
} from './expenseCategoryMatch'

const CATS: ExpenseCategory[] = [
  { id: 'fuel',      name: 'Fuel',                is_active: true },
  { id: 'transport', name: 'Transport',           is_active: true },
  { id: 'maint',     name: 'Factory Maintenance', is_active: true },
  { id: 'refresh',   name: 'Staff Refreshments',  is_active: true },
  { id: 'travel',    name: 'Travel',              is_active: true },
  { id: 'retired',   name: 'Old Thing',           is_active: false },
]

const h = (
  category_id: string, paid_to: string, remark: string | null,
  deleted_at: string | null = null,
): ExpenseHistoryEntry => ({ category_id, paid_to, remark, deleted_at })

const names = (r: ReturnType<typeof suggestCategories>) => r.suggestions.map(s => s.categoryName)

// ── Normalization ────────────────────────────────────────────────────────────

describe('words are compared after normalization, never as typed', () => {
  test('case and punctuation are ignored', () => {
    assert.equal(normalizeWord('DIESEL'), normalizeWord('diesel.'))
    assert.equal(normalizeWord('Transport,'), normalizeWord('transport'))
  })

  test('common variations of one word meet', () => {
    assert.equal(normalizeWord('repairs'), normalizeWord('repair'))
    assert.equal(normalizeWord('repairing'), normalizeWord('repair'))
    assert.equal(normalizeWord('snacks'), normalizeWord('snack'))
  })

  test('DIFFERENT WORDS FOR ONE THING MEET TOO — the BOE keyword map', () => {
    assert.equal(normalizeWord('petrol'), normalizeWord('diesel'))
    assert.equal(normalizeWord('tempo'), normalizeWord('freight'))
    assert.equal(normalizeWord('welding'), normalizeWord('maintenance'))
    assert.equal(normalizeWord('tea'), normalizeWord('lunch'))
    assert.equal(normalizeWord('hotel'), normalizeWord('taxi'))
  })

  test('words that mean different things stay apart', () => {
    assert.notEqual(normalizeWord('diesel'), normalizeWord('tea'))
    assert.notEqual(normalizeWord('transport'), normalizeWord('stationery'))
  })

  test('a number carries no meaning about a purpose and is dropped', () => {
    // An invoice number, a vehicle number, a year: matching on one would tie two
    // unrelated expenses together because both mention "2024". The WORDS around
    // it are kept — only the bare figure goes.
    assert.equal(phraseTerms('invoice 4471').has('4471'), false)
    assert.ok(phraseTerms('invoice 4471').has('invoice'))
    assert.deepEqual([...phraseTerms('2200')], [])
  })

  test('repetition is one piece of evidence, not three', () => {
    assert.deepEqual([...phraseTerms('diesel diesel diesel')].length, 1)
  })

  test('a payee is reduced to one comparison key', () => {
    assert.equal(payeeKey('  Bharat   Petroleum. '), 'bharat petroleum')
    assert.equal(payeeKey(null), '')
  })
})

// ── Learning from the right rows ─────────────────────────────────────────────

describe('WHAT THE MATCHER IS ALLOWED TO LEARN FROM', () => {
  test('a soft-deleted expense teaches nothing', () => {
    const history = [h('fuel', 'Ramesh', 'diesel', '2026-09-19T00:00:00Z')]
    assert.deepEqual(learnableHistory(history), [])
    const result = suggestCategories({ paidTo: 'Ramesh', purpose: '' }, CATS, history)
    assert.deepEqual(names(result), [],
      'a mistake somebody removed must not keep suggesting itself')
  })

  test('and the filter is re-applied inside, not trusted to the caller', () => {
    // Passed WITHOUT going through learnableHistory: the same answer.
    const result = suggestCategories(
      { paidTo: 'Ramesh', purpose: 'nothing in particular' },
      CATS,
      [h('fuel', 'Ramesh', 'diesel', '2026-09-19T00:00:00Z')])
    assert.deepEqual(names(result), [])
  })

  test('a live expense with the same words does teach', () => {
    const result = suggestCategories(
      { paidTo: 'Ramesh', purpose: '' }, CATS, [h('fuel', 'Ramesh', 'diesel')])
    assert.deepEqual(names(result), ['Fuel'])
  })

  test('DRAFTS CANNOT REACH IT AT ALL — they are not expenses', () => {
    // The type this function takes describes public.expenses. A draft lives in
    // public.expense_drafts, has no category most of the time, and is never
    // read by the query that builds this list. The structural fact is asserted
    // in expenseDrafts.test.ts and in the schema test; here it is enough that
    // an entry with no category contributes nothing even if one were forced in.
    const result = suggestCategories(
      { paidTo: 'Ramesh', purpose: 'diesel' },
      CATS,
      [{ category_id: '', paid_to: 'Ramesh', remark: 'diesel', deleted_at: null }])
    assert.equal(result.suggestions.every(s => s.categoryId !== ''), true)
  })

  test('a retired category is never suggested — the picker would not offer it', () => {
    const result = suggestCategories(
      { paidTo: 'Somebody', purpose: 'old thing' }, CATS, [h('retired', 'Somebody', 'old thing')])
    assert.equal(names(result).includes('Old Thing'), false)
  })
})

// ── The two signals ──────────────────────────────────────────────────────────

describe('suggestions from the payee', () => {
  const history = [
    h('fuel', 'Bharat Petroleum', 'diesel'),
    h('fuel', 'Bharat Petroleum', 'diesel'),
  ]

  test('the category this payee was filed under before comes back', () => {
    const result = suggestCategories({ paidTo: 'Bharat Petroleum', purpose: '' }, CATS, history)
    assert.deepEqual(names(result), ['Fuel'])
    assert.equal(result.suggestions[0].reason, 'payee')
    assert.equal(result.suggestions[0].reasonText, 'Previously used for this payee')
  })

  test('the payee is matched case- and punctuation-insensitively', () => {
    const result = suggestCategories({ paidTo: 'bharat petroleum.', purpose: '' }, CATS, history)
    assert.deepEqual(names(result), ['Fuel'])
  })

  test('ONE SHARED WORD IN A PAYEE IS NOT A SUGGESTION', () => {
    // "Sharma Traders" against "Sharma Ji" is a coincidence of names, and
    // suggesting a category from it would be worse than suggesting nothing.
    const result = suggestCategories(
      { paidTo: 'Sharma Traders', purpose: '' }, CATS, [h('maint', 'Sharma Ji', null)])
    assert.deepEqual(names(result), [])
  })
})

describe('suggestions from the purpose', () => {
  test('the same word used before brings its category back', () => {
    const result = suggestCategories(
      { paidTo: 'Somebody New', purpose: 'diesel for the tempo' },
      CATS,
      [h('fuel', 'A Petrol Pump', 'diesel')])
    assert.ok(names(result).includes('Fuel'))
  })

  test('A DIFFERENT WORD FOR THE SAME THING ALSO MATCHES', () => {
    const result = suggestCategories(
      { paidTo: 'Somebody New', purpose: 'petrol' },
      CATS,
      [h('fuel', 'A Pump', 'diesel')])
    assert.ok(names(result).includes('Fuel'))
  })

  test('the reason names the words, when the words are what matched', () => {
    const result = suggestCategories({ paidTo: '', purpose: 'diesel' }, CATS, [])
    assert.equal(result.suggestions[0].categoryName, 'Fuel')
    assert.equal(result.suggestions[0].reason, 'keyword')
    assert.equal(result.suggestions[0].reasonText, 'Matches “diesel”')
  })

  test('two words are both named', () => {
    assert.equal(suggestionReasonText('keyword', ['diesel', 'petrol']),
      'Matches “diesel” and “petrol”')
  })

  test('history-driven matches say so in the words the requirement uses', () => {
    assert.equal(suggestionReasonText('similar_payments', []), 'Used for similar payments')
  })
})

describe('PURPOSE OUTWEIGHS PAYEE — the rule, tested where it actually bites', () => {
  /**
   * The realistic conflict. A hardware shop this company buys from constantly:
   * every earlier payment to it was Factory Maintenance. Today's payment to that
   * same shop is for tea and biscuits for the staff.
   *
   * The payee says Factory Maintenance, loudly and five times over. The purpose
   * says Staff Refreshments, once. The purpose must win.
   */
  const history = [
    h('maint', 'Gupta Hardware', 'welding rod'),
    h('maint', 'Gupta Hardware', 'repair'),
    h('maint', 'Gupta Hardware', 'machine spare'),
    h('maint', 'Gupta Hardware', 'repair'),
    h('maint', 'Gupta Hardware', 'maintenance'),
    h('refresh', 'A Tea Stall', 'tea and snacks'),
  ]

  test('the purpose wins, however often the payee said otherwise', () => {
    const result = suggestCategories(
      { paidTo: 'Gupta Hardware', purpose: 'tea for the staff' }, CATS, history)
    assert.equal(result.suggestions[0].categoryName, 'Staff Refreshments',
      'what the money was FOR is the question a category answers')
    assert.ok(names(result).includes('Factory Maintenance'),
      'the payee is still evidence — it is just weaker evidence')
    assert.ok(result.suggestions[0].score > result.suggestions[1].score)
  })

  test('with no purpose to go on, the payee leads — as it should', () => {
    const result = suggestCategories({ paidTo: 'Gupta Hardware', purpose: '' }, CATS, history)
    assert.equal(result.suggestions[0].categoryName, 'Factory Maintenance')
  })
})

describe('FREQUENCY IS A TIE-BREAK, NEVER A REASON', () => {
  /** One category used for almost everything, and one used once. */
  const history = [
    ...Array.from({ length: 12 }, () => h('maint', 'Various', 'repair')),
    h('travel', 'IRCTC', 'train ticket'),
  ]

  test('the most-used category is NOT suggested for an unrelated expense', () => {
    const result = suggestCategories(
      { paidTo: 'IRCTC', purpose: 'train ticket to Delhi' }, CATS, history)
    assert.equal(result.suggestions[0].categoryName, 'Travel')
    assert.equal(names(result).includes('Factory Maintenance'), false,
      'popularity must not drag an unrelated category into the list')
  })

  test('and an empty form suggests nothing at all', () => {
    const result = suggestCategories({ paidTo: '', purpose: '' }, CATS, history)
    assert.deepEqual(result.suggestions, [])
    assert.equal(result.newCategory, null,
      'offering the three most-used categories to somebody who has typed nothing is exactly the failure this avoids')
  })

  test('frequency cannot, on its own, lift anything over the threshold', () => {
    // Asserted as arithmetic rather than as a scenario, so it holds for every
    // scenario: the frequency ceiling is below the suggestion threshold.
    const result = suggestCategories(
      { paidTo: 'Nobody Seen Before', purpose: '' }, CATS, history)
    assert.deepEqual(names(result), [])
    assert.ok(MIN_SUGGESTION_SCORE > 0.9)
  })
})

describe('the shape of the answer', () => {
  const history = [
    h('fuel', 'Pump A', 'diesel'),
    h('transport', 'Tempo Wala', 'diesel delivery'),
    h('maint', 'Gupta', 'diesel generator repair'),
    h('travel', 'Cab Co', 'diesel taxi'),
  ]

  test('never more than three', () => {
    const result = suggestCategories({ paidTo: '', purpose: 'diesel' }, CATS, history)
    assert.ok(result.suggestions.length <= MAX_SUGGESTIONS)
    assert.equal(MAX_SUGGESTIONS, 3)
  })

  test('strongest first', () => {
    const result = suggestCategories({ paidTo: 'Pump A', purpose: 'diesel' }, CATS, history)
    const scores = result.suggestions.map(s => s.score)
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a))
  })

  test('the order is stable between identical calls', () => {
    const a = suggestCategories({ paidTo: 'X', purpose: 'diesel' }, CATS, history)
    const b = suggestCategories({ paidTo: 'X', purpose: 'diesel' }, CATS, history)
    assert.deepEqual(names(a), names(b))
  })

  test('NOTHING IS SELECTED — a suggestion is a suggestion', () => {
    const result = suggestCategories({ paidTo: 'Pump A', purpose: 'diesel' }, CATS, history)
    // The result type carries no "selected" field and no side effect. If one is
    // ever added, this fails and somebody has to justify it.
    assert.deepEqual(Object.keys(result).sort(), ['newCategory', 'suggestions'])
  })
})

// ── Proposing a new category ─────────────────────────────────────────────────

describe('a NEW category is proposed only when nothing existing fits', () => {
  test('an existing match means no proposal, ever', () => {
    const result = suggestCategories(
      { paidTo: 'Pump', purpose: 'diesel' }, CATS, [h('fuel', 'Pump', 'diesel')])
    assert.ok(result.suggestions.length > 0)
    assert.equal(result.newCategory, null)
  })

  test('with no matching category, a broad name is proposed', () => {
    const sparse: ExpenseCategory[] = [{ id: 'misc', name: 'Miscellaneous', is_active: true }]
    const result = suggestCategories({ paidTo: 'Pump', purpose: 'diesel' }, sparse, [])
    assert.equal(result.newCategory?.name, 'Fuel')
  })

  test('IT IS LABELLED AS A SUGGESTION AND CREATES NOTHING', () => {
    const sparse: ExpenseCategory[] = [{ id: 'misc', name: 'Miscellaneous', is_active: true }]
    const result = suggestCategories({ paidTo: 'Tempo Wala', purpose: 'freight' }, sparse, [])
    assert.equal(result.newCategory?.name, 'Transport')
    // No id: it does not exist, and nothing in this result could select it.
    assert.equal('categoryId' in (result.newCategory ?? {}), false)
  })

  test('BROAD, REUSABLE NAMES — not a fragment of the sentence', () => {
    assert.equal(proposeNewCategoryName({ paidTo: 'x', purpose: 'diesel for the bolero' }), 'Fuel')
    assert.equal(proposeNewCategoryName({ paidTo: 'x', purpose: 'tempo charges' }), 'Transport')
    assert.equal(proposeNewCategoryName({ paidTo: 'x', purpose: 'welding repair' }), 'Factory Maintenance')
    assert.equal(proposeNewCategoryName({ paidTo: 'x', purpose: 'tea and snacks' }), 'Staff Refreshments')
    assert.equal(proposeNewCategoryName({ paidTo: 'x', purpose: 'hotel in Delhi' }), 'Travel')
  })

  test('A PERSON IS NEVER A CATEGORY', () => {
    assert.equal(proposeNewCategoryName({ paidTo: 'Vikram', purpose: 'Vikram' }), null)
    assert.equal(proposeNewCategoryName({ paidTo: 'x', purpose: 'Sharma ji' }), null)
    assert.equal(proposeNewCategoryName({ paidTo: 'x', purpose: 'Mr Mohan' }), null)
  })

  test('AN INVOICE NUMBER OR AN AMOUNT IS NEVER A CATEGORY', () => {
    assert.equal(proposeNewCategoryName({ paidTo: 'x', purpose: 'invoice 4471' }), null)
    assert.equal(proposeNewCategoryName({ paidTo: 'x', purpose: 'bill 22' }), null)
    assert.equal(proposeNewCategoryName({ paidTo: 'x', purpose: '2200' }), null)
  })

  test('A WHOLE SENTENCE IS NEVER A CATEGORY', () => {
    assert.equal(
      proposeNewCategoryName({
        paidTo: 'x',
        purpose: 'replacement of the main gate hinge near the loading bay entrance',
      }),
      null,
      'taking the first two words would invent a bucket nobody would pick again')
  })

  test('two content words are a label, and are accepted', () => {
    assert.equal(proposeNewCategoryName({ paidTo: 'x', purpose: 'security guard' }), 'Security Guard')
  })

  test('DUPLICATES ARE NOT PROPOSED — the name already exists', () => {
    const result = suggestCategories({ paidTo: 'Nobody', purpose: 'diesel' }, CATS, [])
    // Fuel already exists, so it is offered as a SUGGESTION, never as a new one.
    assert.ok(names(result).includes('Fuel'))
    assert.equal(result.newCategory, null)
  })

  test('an existing category sharing a word is a SUGGESTION, not a near miss', () => {
    // The strongest form of "prefer an existing category": if one shares a word
    // with what was typed, it is offered outright and no new one is proposed.
    const cats: ExpenseCategory[] = [{ id: 'sec', name: 'Security', is_active: true }]
    const result = suggestCategories({ paidTo: 'Agency', purpose: 'security guard' }, cats, [])
    assert.deepEqual(names(result), ['Security'])
    assert.equal(result.newCategory, null)
  })

  test('THE NEAR MISSES ARE SHOWN BEFORE A NEW ONE IS OFFERED', () => {
    // The realistic duplicate: a category somebody once typed as "Stationary"
    // (the adjective) when they meant "Stationery" (the paper). It shares no
    // WORD with "printer cartridge", so it is not a suggestion — and creating
    // "Stationery" beside it is exactly the duplicate this list prevents.
    const cats: ExpenseCategory[] = [
      { id: 'stat', name: 'Stationary Items', is_active: true },
    ]
    const result = suggestCategories({ paidTo: 'Office Mart', purpose: 'printer cartridge' }, cats, [])
    assert.equal(result.newCategory?.name, 'Stationery')
    assert.deepEqual(result.newCategory?.similar.map(s => s.categoryName), ['Stationary Items'],
      'the commonest way a log becomes unusable is a new category beside one that would have done')
    assert.ok(result.newCategory!.reasonText.includes('Check the ones below first'))
  })
})

// ── It improves on its own ───────────────────────────────────────────────────

describe('IT GETS MORE USEFUL AS MORE EXPENSES ARE FINALIZED', () => {
  // A CATEGORY THE KEYWORD MAP KNOWS NOTHING ABOUT, deliberately: this suite is
  // about learning from history, so the cold-start map must not answer for it.
  const ask = (history: ExpenseHistoryEntry[]) =>
    suggestCategories({ paidTo: 'Naya Vendor', purpose: 'cartons' },
      [...CATS, { id: 'pack', name: 'Godown Supplies', is_active: true }], history)

  test('nothing known yet → nothing claimed', () => {
    assert.deepEqual(names(ask([])), [])
  })

  test('one earlier expense is already enough', () => {
    assert.deepEqual(names(ask([h('pack', 'Someone Else', 'cartons')])), ['Godown Supplies'])
  })

  test('more of them make it more confident, not merely louder', () => {
    const one = ask([h('pack', 'Someone Else', 'cartons')])
    const five = ask(Array.from({ length: 5 }, () => h('pack', 'Someone Else', 'cartons')))
    assert.ok(five.suggestions[0].score > one.suggestions[0].score)
  })

  test('THE COLD START STILL WORKS — a company with no history at all', () => {
    // The keyword map carries the first few weeks. It never overrides history:
    // a company that files fuel under "Vehicle Running" keeps being offered
    // Vehicle Running as soon as it has filed one.
    const cold = suggestCategories({ paidTo: 'A Pump', purpose: 'diesel' }, CATS, [])
    assert.deepEqual(names(cold), ['Fuel'])

    const theirs: ExpenseCategory[] = [
      { id: 'vr', name: 'Vehicle Running', is_active: true },
      { id: 'fuel', name: 'Fuel', is_active: true },
    ]
    const warm = suggestCategories(
      { paidTo: 'A Pump', purpose: 'diesel' }, theirs,
      Array.from({ length: 4 }, () => h('vr', 'A Pump', 'diesel')))
    assert.equal(warm.suggestions[0].categoryName, 'Vehicle Running',
      'history outvotes the map as soon as history exists')
  })
})
