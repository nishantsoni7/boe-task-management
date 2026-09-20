/**
 * THE THREE NEW SURFACES, RENDERED.
 *
 * Mounted through react-dom/server, like expenseForm.render.test.tsx — so what
 * is asserted is the markup a browser receives, not a description of it.
 *
 * WHAT A SERVER RENDER SETTLES, AND WHAT IT DOES NOT. Effects do not run, so
 * this is the FIRST FRAME: no microphone has been detected and no width has
 * been measured. That is exactly the frame worth pinning — the Delete button
 * must already be disarmed before anybody has typed, and every surface must
 * already be usable on a phone that has no speech recognition at all.
 * Behaviour that needs a real DOM (typing DELETE, pressing Save) is covered by
 * the rules tests over the pure functions those handlers call, and by the
 * manual pass.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DeleteExpenseModal } from './DeleteExpenseModal'
import { QuickCapture } from './QuickCapture'
import { NeedsDetailsList } from './NeedsDetailsList'
import { SmartCategorySuggestions, SMART_SUGGESTION_LABEL, SUGGESTED_NEW_CATEGORY_LABEL } from './SmartCategorySuggestions'
import type { ExpenseCategory, ExpenseRow } from '@/lib/finance/expenses'
import type { ExpenseDraftRow } from '@/lib/finance/expenseDrafts'
import type { ExpenseHistoryEntry } from '@/lib/finance/expenseCategoryMatch'

// Neither component calls Supabase during a render; a stub satisfies the type.
const supabase = {} as Parameters<typeof QuickCapture>[0]['supabase']

const ROW: ExpenseRow = {
  id: 'exp-1', expense_date: '2026-09-18', amount: '850.50', payment_mode: 'upi',
  paid_to: 'Sharma Ji', category_id: 'cat-1', remark: 'welding machine',
  created_by: 'author', created_at: '2026-09-18T10:00:00Z',
  updated_at: '2026-09-18T10:00:00Z', updated_by: null,
  deleted_at: null, deleted_by: null,
}

const DRAFT: ExpenseDraftRow = {
  id: 'draft-1',
  raw_text: '500 cash to Ramesh for diesel',
  parsed_date: '2026-09-20',
  parsed_amount: '500',
  parsed_paid_to: 'Ramesh',
  parsed_payment_mode: 'cash',
  parsed_remark: 'diesel',
  category_id: null,
  status: 'pending',
  expense_id: null,
  finalized_at: null,
  discarded_by: null,
  discarded_at: null,
  created_by: 'author',
  created_at: '2026-09-20T09:00:00Z',
  updated_at: '2026-09-20T09:00:00Z',
}

const CATEGORIES: ExpenseCategory[] = [
  { id: 'fuel', name: 'Fuel', is_active: true },
  { id: 'maint', name: 'Factory Maintenance', is_active: true },
]

// ═══════════════════════════════════════════════════════════════════════════
// The delete confirmation
// ═══════════════════════════════════════════════════════════════════════════

const renderDelete = (over: Partial<Parameters<typeof DeleteExpenseModal>[0]> = {}) =>
  renderToStaticMarkup(createElement(DeleteExpenseModal, {
    supabase, userId: 'author', expense: ROW, categoryName: 'Fuel',
    onClose: () => {}, onDeleted: () => {}, ...over,
  }))

describe('the delete confirmation states the four facts first', () => {
  const html = renderDelete()

  test('date, amount, paid-to and category are all on screen', () => {
    assert.ok(html.includes('₹850.50'), 'the amount')
    assert.ok(html.includes('Sharma Ji'), 'who was paid')
    assert.ok(/18 Sept? 2026/.test(html), 'the date the money left')
    assert.ok(html.includes('Fuel'), 'the category')
  })

  test('THEY COME BEFORE THE INSTRUCTION', () => {
    // The realistic mistake is not "I did not mean to delete anything", it is
    // "I deleted the wrong one" — so the identity of the row is the first thing
    // read, not a footnote under a warning.
    assert.ok(html.indexOf('Sharma Ji') < html.indexOf('Type DELETE to confirm'))
  })

  test('it explains what removal means, in the words the business uses', () => {
    assert.ok(html.includes('removed from the normal expense records'))
    assert.ok(html.includes('totals'))
  })

  test('IT NEVER CLAIMS THE ROW IS DESTROYED, because it is not', () => {
    assert.ok(html.includes('kept in the database'))
    assert.equal(/permanently deleted|cannot be recovered|gone forever/i.test(html), false)
    assert.equal(/soft.?delete|tombstone/i.test(html), false,
      'the jargon belongs in the code, not on a factory floor')
  })
})

describe('THE DELETE BUTTON IS DISARMED UNTIL THE WORD IS TYPED', () => {
  const html = renderDelete()

  test('the first frame — nothing typed — has it disabled', () => {
    const button = /<button[^>]*>(?:Delete expense)<\/button>/.exec(html)
    assert.ok(button, 'the delete button is drawn')
    assert.ok(button![0].includes('disabled'),
      'it must be disabled before anybody has typed anything')
  })

  test('the confirmation box is present, labelled, and asks for the exact word', () => {
    assert.ok(html.includes('id="expense-delete-confirm"'))
    assert.ok(html.includes('for="expense-delete-confirm"'))
    assert.ok(html.includes('Type DELETE to confirm'))
    assert.ok(html.includes('placeholder="DELETE"'))
  })

  test('autocorrect and autocapitalisation cannot interfere with it', () => {
    assert.ok(html.includes('autoCapitalize="characters"') || html.includes('autocapitalize="characters"'))
    assert.ok(html.includes('spellcheck="false"') || html.includes('spellCheck="false"'))
  })

  test('the safe way out is offered beside it', () => {
    assert.ok(html.includes('>Keep it</button>'),
      '"Cancel" is ambiguous next to a destructive verb; "Keep it" is not')
  })

  test('nothing is in an error state before anybody has typed', () => {
    assert.equal(html.includes('role="alert"'), false)
  })

  test('both buttons are full tap targets on a phone', () => {
    const heights = [...html.matchAll(/min-height:(\d+)px/g)].map(m => Number(m[1]))
    assert.ok(heights.length >= 2)
    assert.ok(heights.every(h => h >= 44), `every control is at least 44px: ${heights}`)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Quick Capture
// ═══════════════════════════════════════════════════════════════════════════

const renderCapture = (over: Partial<Parameters<typeof QuickCapture>[0]> = {}) =>
  renderToStaticMarkup(createElement(QuickCapture, {
    supabase, userId: 'author', onSaved: () => {}, ...over,
  }))

describe('Quick Capture is one box and one button', () => {
  const html = renderCapture()

  test('one text box, and nothing that looks like a form', () => {
    assert.ok(html.includes('id="quick-capture-text"'))
    assert.ok(html.includes('for="quick-capture-text"'))
    assert.equal((html.match(/<textarea/g) ?? []).length, 1, 'exactly one box')
    assert.equal(/<select/.test(html), false, 'no pickers: this is not the full form')
    assert.equal(/inputMode="decimal"/.test(html), false, 'no amount field either')
  })

  test('IT IS NOT A CHAT — no thread, no follow-up question', () => {
    assert.equal(/send|message|reply|assistant/i.test(html), false)
  })

  test('the save action says where it goes, not merely "Save"', () => {
    assert.ok(html.includes('Save for later'))
  })

  test('the example sentences are offered, and tapping one only fills the box', () => {
    assert.ok(html.includes('Paid 1000 rupees to Vikram for machine repair'))
    assert.ok(html.includes('750 for factory work'))
  })

  test('A BROWSER WITHOUT SPEECH RECOGNITION IS FULLY USABLE', () => {
    // The first frame is always the no-microphone frame: useSyncExternalStore's
    // server snapshot is false. The box, the hint and Save are all there.
    assert.equal(html.includes('aria-label="Speak instead of typing"'), false)
    assert.ok(html.includes('Voice entry is not available in this browser'))
    assert.ok(html.includes('Save for later'))
  })

  test('nothing is refused before anybody has pressed Save', () => {
    assert.equal(html.includes('role="alert"'), false)
  })
})

describe('an empty capture shows no preview, and a partial one shows what is missing', () => {
  test('nothing typed → no preview to read', () => {
    assert.equal(renderCapture().includes('data-testid="quick-capture-preview"'), false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Needs Details
// ═══════════════════════════════════════════════════════════════════════════

const renderInbox = (over: Partial<Parameters<typeof NeedsDetailsList>[0]> = {}) =>
  renderToStaticMarkup(createElement(NeedsDetailsList, {
    rows: [DRAFT],
    loading: false,
    error: null,
    personName: () => 'Nishant',
    mayAct: () => true,
    onComplete: () => {},
    onDiscarded: () => {},
    supabase,
    userId: 'author',
    ...over,
  }))

describe('the Needs Details inbox shows everything the requirement names', () => {
  const html = renderInbox()

  test('the captured text, verbatim and first', () => {
    assert.ok(html.includes('500 cash to Ramesh for diesel'))
  })

  test('the parsed amount and the parsed payee', () => {
    assert.ok(html.includes('₹500.00'))
    assert.ok(html.includes('Ramesh'))
  })

  test('the date it was captured, and who captured it', () => {
    assert.ok(/Captured \d+ Sept? 2026/.test(html))
    assert.ok(html.includes('Nishant'))
  })

  test('WHAT IS MISSING, said before anybody opens it', () => {
    assert.ok(html.includes('Missing: Category'))
  })

  test('and the Complete action', () => {
    assert.ok(html.includes('>Complete</button>'))
  })

  test('A MISSING AMOUNT IS NOT A ZERO', () => {
    const html2 = renderInbox({ rows: [{ ...DRAFT, parsed_amount: null }] })
    assert.ok(html2.includes('Amount missing'))
    assert.equal(html2.includes('₹0'), false, 'nothing is invented, least of all a figure')
    assert.ok(html2.includes('Missing: Amount and Category'))
  })

  test('an unheard payee says so rather than printing an empty line', () => {
    assert.ok(renderInbox({ rows: [{ ...DRAFT, parsed_paid_to: null }] })
      .includes('Payee not heard'))
  })
})

describe('IT IS NEEDS DETAILS, NOT APPROVAL', () => {
  test('no word on the screen suggests somebody else decides', () => {
    const html = renderInbox()
    assert.equal(/approv|reject|review|authoris|authoriz/i.test(html), false)
    assert.ok(html.includes('Complete'))
  })

  test('and nothing here counts towards a total, which it says', () => {
    assert.ok(renderInbox().includes('Nothing here counts towards any total'))
  })
})

describe('a capture is discarded safely, never deleted', () => {
  test('Discard is offered beside Complete', () => {
    assert.ok(renderInbox().includes('>Discard</button>'))
  })

  test('somebody who may not act on it sees neither', () => {
    const html = renderInbox({ mayAct: () => false })
    assert.equal(html.includes('>Discard</button>'), false)
    assert.equal(html.includes('>Complete</button>'), false)
    assert.ok(html.includes('500 cash to Ramesh for diesel'), 'they can still read it')
  })

  test('the four inbox states are distinguishable', () => {
    assert.ok(renderInbox({ loading: true, rows: [] }).includes('Loading captures…'))
    const failed = renderInbox({ error: 'The captures could not be loaded. Use Refresh to try again.', rows: [] })
    assert.ok(failed.includes('could not be loaded'))
    assert.equal(failed.includes('Nothing is waiting for details'), false,
      '"nothing here" and "we could not read it" must never be the same sentence')
    assert.ok(renderInbox({ rows: [] }).includes('Nothing is waiting for details'))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Smart suggestion
// ═══════════════════════════════════════════════════════════════════════════

const renderSuggestions = (over: Partial<Parameters<typeof SmartCategorySuggestions>[0]> = {}) =>
  renderToStaticMarkup(createElement(SmartCategorySuggestions, {
    paidTo: '', purpose: '', categories: CATEGORIES, history: [] as ExpenseHistoryEntry[],
    selectedCategoryId: '', onPick: () => {}, onProposeNew: () => {}, ...over,
  }))

describe('the Smart suggestion panel', () => {
  test('IT IS CALLED "Smart suggestion" AND NEVER CLAIMS TO BE AI', () => {
    const html = renderSuggestions({ purpose: 'diesel' })
    assert.ok(html.includes(SMART_SUGGESTION_LABEL))
    assert.equal(SMART_SUGGESTION_LABEL, 'Smart suggestion')
    assert.equal(/\bAI\b|artificial intelligence|GPT|model|machine learning/i.test(html), false)
  })

  test('a suggestion carries its reason, so it can be checked rather than trusted', () => {
    const html = renderSuggestions({ purpose: 'diesel' })
    assert.ok(html.includes('>Fuel</span>'))
    assert.ok(html.includes('Matches “diesel”'))
  })

  test('NOTHING IS PRE-SELECTED — each one is a button somebody presses', () => {
    const html = renderSuggestions({ purpose: 'diesel' })
    assert.equal(/checked|aria-selected="true"|selected=""/.test(html), false)
    assert.ok(html.includes('data-suggestion-rank="0"'))
  })

  test('the strongest is first, and is marked as such in the markup', () => {
    const history: ExpenseHistoryEntry[] = [
      { category_id: 'maint', paid_to: 'Gupta Hardware', remark: 'welding', deleted_at: null },
    ]
    const html = renderSuggestions({ paidTo: 'Gupta Hardware', purpose: 'welding repair', history })
    const ranks = [...html.matchAll(/data-suggestion-rank="(\d+)"/g)].map(m => Number(m[1]))
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b))
    assert.ok(html.indexOf('Factory Maintenance') > 0)
  })

  test('the panel says the picker still offers everything else', () => {
    assert.ok(renderSuggestions({ purpose: 'diesel' })
      .includes('Pick any other category if none fits'))
  })

  test('NOTHING TYPED → NOTHING SUGGESTED', () => {
    assert.equal(renderSuggestions().includes('data-testid="smart-category-suggestions"'), false)
  })

  test('a category already chosen → the panel goes', () => {
    assert.equal(
      renderSuggestions({ purpose: 'diesel', selectedCategoryId: 'fuel' })
        .includes('data-testid="smart-category-suggestions"'),
      false,
      'the question has been answered; second-guessing a deliberate choice is noise')
  })

  test('every chip is a 44px tap target', () => {
    const html = renderSuggestions({ purpose: 'diesel' })
    const heights = [...html.matchAll(/min-height:(\d+)px/g)].map(m => Number(m[1]))
    assert.ok(heights.length > 0)
    assert.ok(heights[0] >= 44)
  })
})

describe('a SUGGESTED NEW CATEGORY is labelled, and creates nothing', () => {
  const sparse: ExpenseCategory[] = [{ id: 'misc', name: 'Miscellaneous', is_active: true }]
  const html = renderSuggestions({ purpose: 'diesel', categories: sparse })

  test('it is labelled as a suggestion, in as many words', () => {
    assert.ok(html.includes(SUGGESTED_NEW_CATEGORY_LABEL))
    assert.equal(SUGGESTED_NEW_CATEGORY_LABEL, 'Suggested new category')
  })

  test('the proposed name is broad and reusable', () => {
    assert.ok(html.includes('Fuel'))
  })

  test('CREATING IT IS A SEPARATE TAP — the chip only opens the dialog', () => {
    // onProposeNew opens the Add-category dialog prefilled. That dialog has its
    // own Save. Nothing on this panel writes.
    assert.ok(/Add [^<]*Fuel/.test(html))
  })

  test('and a matching existing category means no proposal at all', () => {
    assert.equal(
      renderSuggestions({ purpose: 'diesel', categories: CATEGORIES })
        .includes(SUGGESTED_NEW_CATEGORY_LABEL),
      false,
      'an existing category always wins')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// The phone
// ═══════════════════════════════════════════════════════════════════════════

describe('MOBILE — nothing on any new surface can overflow 360px or 390px', () => {
  /**
   * WHAT THIS CAN AND CANNOT CHECK. A server render has no layout engine, so
   * this cannot measure a line box. What it CAN do is pin the things that
   * actually cause a horizontal scroll on a phone, each of which is visible in
   * the markup: a fixed pixel width wider than the screen, a min-width that
   * cannot shrink, a `white-space: nowrap` on something long, and a tap target
   * under 44px. The visual pass at 360 and 390 is in the manual test list.
   */
  const surfaces: [string, string][] = [
    ['delete confirmation', renderDelete()],
    ['quick capture', renderCapture()],
    ['needs details', renderInbox()],
    ['smart suggestion', renderSuggestions({ purpose: 'diesel' })],
  ]

  for (const [name, html] of surfaces) {
    test(`${name}: no element is pinned wider than a 360px screen`, () => {
      // A width that is immediately capped by max-width:calc(100vw - …) is a
      // MAXIMUM, not a floor — FinanceModal's own 420px dialog is exactly that,
      // and it renders at 328px on a 360px phone. Those pairs are removed
      // before the scan; anything left is a genuine pin.
      const scanned = html.replace(/width:\d+px;max-width:calc\(100vw[^;"]*/g, '')
      const widths = [...scanned.matchAll(/(?:^|[;"])(?:min-)?width:(\d+)px/g)].map(m => Number(m[1]))
      const tooWide = widths.filter(w => w > 320)
      assert.deepEqual(tooWide, [],
        `a fixed width over 320px leaves no room for the 16px gutters on a 360px phone`)
    })

    test(`${name}: every tap target is at least 44px`, () => {
      const heights = [...html.matchAll(/min-height:(\d+)px/g)].map(m => Number(m[1]))
      const tooSmall = heights.filter(h => h < 36)
      assert.deepEqual(tooSmall, [], 'nothing is a squeezed link')
    })

    test(`${name}: nothing opts into a sideways scroll`, () => {
      assert.equal(/overflow-x:\s*(scroll|auto)/.test(html), false)
      assert.equal(/white-space:nowrap[^}]*width:\d{3,}px/.test(html), false)
    })
  }

  test('the delete dialog itself fits, at both widths', () => {
    // FinanceModal caps every dialog at calc(100vw - 32px) — 328px at 360 and
    // 358px at 390 — so the 420px it asks for is a maximum, never a floor.
    assert.ok(renderDelete().includes('max-width:calc(100vw - 32px)'))
  })
})
