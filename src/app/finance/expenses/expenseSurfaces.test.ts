/**
 * WHERE EXPENSES APPEAR, AND WHAT THEY LEFT ALONE.
 *
 * Source-level assertions, in the style of paymentSurfaces.test.ts: the things
 * that must be true about the WIRING — which routes exist, which nav entry is
 * lit, what the launcher offers and to whom — plus a regression suite over the
 * existing Finance and Orders surfaces this work must not have touched.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { activeFinanceNav, pendingModuleTitle } from '@/lib/navigation/moduleNav'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
/** The file with its comments removed, for "is this actually in the code?". */
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

const LAYOUT = 'src/components/layout/FinanceLayout.tsx'
const FORM = 'src/app/finance/expenses/ExpenseForm.tsx'
const VIEW = 'src/app/finance/expenses/ExpensesView.tsx'
const QUICK = 'src/app/finance/expenses/new/page.tsx'
const MODULES = 'src/app/modules/page.tsx'
// The one definition list behind Quick Add Expense, rendered by the desktop
// sidebar and by the launcher page. The label, the icon and the route live
// there now, so neither surface can restate them and drift.
const QUICK_ACTIONS = 'src/components/layout/QuickActions.tsx'
const OS_LAYOUT = 'src/components/layout/BoeOsLayout.tsx'
const OS_CSS = 'src/app/globals.css'
// ── Phase 2 ──
const DELETE_MODAL = 'src/app/finance/expenses/DeleteExpenseModal.tsx'
const DRAFTS = 'src/app/finance/expenses/NeedsDetailsList.tsx'
const CAPTURE = 'src/app/finance/expenses/QuickCapture.tsx'
const SUGGESTIONS = 'src/app/finance/expenses/SmartCategorySuggestions.tsx'
const SPEECH = 'src/app/finance/expenses/useExpenseSpeech.ts'
const MIGRATION = 'supabase/migrations/20261222000000_expense_lifecycle.sql'

// ── The routes ───────────────────────────────────────────────────────────────

describe('the two expense routes exist and sit inside the Finance guard', () => {
  test('the list and the quick-entry route are both present', () => {
    assert.ok(existsSync(join(process.cwd(), 'src/app/finance/expenses/page.tsx')))
    assert.ok(existsSync(join(process.cwd(), 'src/app/finance/expenses/new/page.tsx')))
  })

  test('THE DEDICATED URL IS /finance/expenses/new', () => {
    // The manifest shortcut, the launcher action and the Android home-screen
    // instructions all name this path. It is a promise to somebody's phone.
    assert.ok(code(QUICK_ACTIONS).includes("href: '/finance/expenses/new'"))
    assert.equal(
      JSON.parse(read('public/manifest.json')).shortcuts[0].url,
      '/finance/expenses/new')
  })

  test('both routes are UNDER src/app/finance, so ModuleGuard already gates them', () => {
    // src/app/finance/layout.tsx wraps everything below it in
    // <ModuleGuard moduleKey="finance">. Direct URL access is refused by the
    // guard, not merely hidden — and again by RLS, which the migration test
    // covers. Neither expense page may re-declare a looser guard of its own.
    const financeLayout = code('src/app/finance/layout.tsx')
    assert.ok(financeLayout.includes('<ModuleGuard moduleKey="finance">'))
    for (const page of ['src/app/finance/expenses/page.tsx', QUICK]) {
      assert.equal(code(page).includes('ModuleGuard'), false,
        `${page} must not introduce a second, weaker gate`)
    }
  })

  test('the quick route opens straight into an entry surface and waits for no list', () => {
    const quick = code(QUICK)
    assert.ok(quick.includes('<ExpenseForm'))
    assert.ok(quick.includes('<QuickCapture'))
    assert.ok(quick.includes("from('expense_categories')"), 'the picker still needs its categories')

    // THE BOOTSTRAP STILL READS NO EXPENSES. Phase 2 added one read of the
    // Smart suggestion's training set — three columns, capped — and it is
    // deliberately OUTSIDE the gating Promise.all and never awaited before
    // setLoading(false). The promise to somebody's home screen is that this URL
    // opens instantly; a suggestion that arrives a moment later is fine, a form
    // that arrives a moment later is not.
    const bootstrap = quick.slice(quick.indexOf('const [{ data: me }'), quick.indexOf('setLoading(false)'))
    assert.equal(bootstrap.includes("from('expenses')"), false,
      'the first paint must not wait on an expenses read')
    // And where it does read them, it excludes the deleted ones.
    assert.ok(quick.includes(".is('deleted_at', null)"))
  })

  test('the quick route offers both onward moves after a save', () => {
    const quick = read(QUICK)
    assert.ok(quick.includes('Add another expense'))
    assert.ok(quick.includes('View expenses'))
    assert.ok(quick.includes('Expense saved'))
  })
})

// ── Navigation ───────────────────────────────────────────────────────────────

describe('Finance navigation', () => {
  test('Expenses is a sidebar entry, beside the two payment sections', () => {
    const nav = read(LAYOUT)
    assert.ok(/label: 'Expenses',\s*path: EXPENSES_PATH/.test(nav))
    assert.ok(nav.includes("export const EXPENSES_PATH = '/finance/expenses'"))
    assert.ok(nav.includes("export const ADD_EXPENSE_PATH = '/finance/expenses/new'"))
  })

  test('THE TWO PAYMENT SECTIONS ARE UNTOUCHED', () => {
    // The requirement that Finance keeps exactly two PAYMENT sections is not
    // weakened by this work: an expense is not a payment section. Both entries
    // are still there, unchanged, and no third payment view was added.
    const nav = read(LAYOUT)
    assert.ok(/label: 'Payment Requests',\s*path: '\/finance'/.test(nav))
    assert.ok(nav.includes("label: 'Confirmed Payments'"))
    assert.equal(code(nav ? LAYOUT : LAYOUT).includes("'Payments to Verify'"), false,
      'the retired entry stays retired')
  })

  test('both expense paths light the Expenses entry', () => {
    assert.equal(activeFinanceNav('/finance/expenses'), 'expenses')
    // Somebody arriving from a home-screen shortcut still sees where they are.
    assert.equal(activeFinanceNav('/finance/expenses/new'), 'expenses')
  })

  test('adding it changed nothing about the other entries', () => {
    assert.equal(activeFinanceNav('/finance'), 'requests')
    assert.equal(activeFinanceNav('/finance/payments-to-verify'), 'requests')
    assert.equal(activeFinanceNav('/finance/received'), 'confirmed')
    assert.equal(activeFinanceNav('/finance/received/linked'), 'confirmed')
    assert.equal(activeFinanceNav('/finance/notifications'), null)
    assert.equal(activeFinanceNav('/orders'), null)
  })

  test('the loading header says what the page will say', () => {
    assert.equal(pendingModuleTitle('/finance/expenses'), 'Expenses')
    assert.equal(pendingModuleTitle('/finance/expenses/new'), 'Add Expense')
    // Unchanged:
    assert.equal(pendingModuleTitle('/finance'), 'Payment Requests')
    assert.equal(pendingModuleTitle('/finance/received'), 'Confirmed Payments')
  })
})

// ── The launcher shortcut ────────────────────────────────────────────────────

describe('Quick Add Expense on the launcher', () => {
  const modules = code(MODULES)
  const quickActions = code(QUICK_ACTIONS)
  const osLayout = code(OS_LAYOUT)

  test('it is drawn, and it is a real action rather than a module card', () => {
    assert.ok(quickActions.includes('Quick Add Expense'))
    assert.ok(quickActions.includes('Quick Actions'))
  })

  test('IT IS GATED ON THE SAME AUTHORITY THE ROUTE AND THE DATABASE USE', () => {
    // deriveFinanceCapabilities is the module's own derivation, and
    // canCreatePaymentRecord is Finance entry AND finance.create — exactly what
    // expenses_create_insert requires in the database. UNCHANGED by the move:
    // the launcher still computes the gate, the shared list only draws it.
    assert.ok(modules.includes('deriveFinanceCapabilities('))
    assert.ok(modules.includes('financeCaps.canCreatePaymentRecord'))
    assert.ok(/buildQuickActions\(\{ canQuickAddExpense \}\)/.test(modules),
      'the list is built from the gate and from nothing else')
    assert.ok(/if \(gates\.canQuickAddExpense\)/.test(quickActions),
      'the definition enters the list only when its gate is true')
    assert.ok(/actions\.length === 0\) return null/.test(quickActions),
      'no authorized action means no heading and no container, on either surface')
  })

  test('it reads the DISPLAY SUBJECT, so View As previews the employee\'s screen', () => {
    assert.ok(/deriveFinanceCapabilities\(\s*subjectRole,\s*subjectPermissions\.get\('finance'\)/.test(modules))
  })

  // ── WHERE it is drawn, and that it is drawn exactly once ──

  test('ONE definition list feeds both placements', () => {
    assert.ok(osLayout.includes('<QuickActionList actions={quickActions} variant="sidebar" />'))
    assert.ok(modules.includes('<QuickActionList actions={quickActions} variant="page" />'))
    // Neither surface may restate the label or the route.
    for (const [file, src] of [[MODULES, modules], [OS_LAYOUT, osLayout]] as const) {
      assert.equal(src.includes('Quick Add Expense'), false,
        `${file} must take the label from QuickActions.tsx, not repeat it`)
      assert.equal(src.includes('/finance/expenses/new'), false,
        `${file} must take the route from QuickActions.tsx, not repeat it`)
    }
  })

  test('THE SIDEBAR COPY AND THE PAGE COPY ARE NEVER BOTH ON SCREEN', () => {
    // CSS decides, at the sidebar’s own 767px breakpoint — the one that turns
    // .boe-sidebar into a drawer — so there is no media query in JavaScript to
    // disagree with it and no width at which the action appears twice.
    const css = read(OS_CSS)
    assert.ok(/\.boe-quick-actions-page \{[^}]*display: none;/.test(css),
      'the page copy is hidden by default, which is to say on desktop')
    assert.ok(/@media \(max-width: 767px\) \{\s*\.boe-quick-actions-sidebar \{ display: none; \}\s*\.boe-quick-actions-page\s+\{ display: block; \}\s*\}/.test(css),
      'below the sidebar breakpoint the sidebar copy goes and the page copy arrives')
  })

  test('it sits below Home in the sidebar and above Modules in the page', () => {
    // Below the Home nav block…
    assert.ok(osLayout.indexOf('label="Home"') < osLayout.indexOf('variant="sidebar"'))
    // …and above the identity block, so Switch User and the profile controls
    // keep the foot of the sidebar to themselves.
    assert.ok(osLayout.indexOf('variant="sidebar"') < osLayout.indexOf('<ViewModeSidebarSection'))
    // In the page it precedes the module grid. It used to be anchored on the
    // launcher's in-body heading; that heading is gone — the page's title now
    // lives in the app header — so this anchors on the grid itself, which is
    // the thing the quick actions have to come before.
    assert.ok(modules.indexOf('variant="page"') < modules.indexOf('styles.grid'))
  })

  test('the touch target clears 44px wherever a finger can reach it', () => {
    const css = read(OS_CSS)
    assert.ok(/\.boe-quick-action \{[^}]*min-height: 46px;/.test(css), 'the base button')
    // The page copy is the one a phone shows, so it keeps a full touch target.
    const page = css.match(/\.boe-quick-actions-page \.boe-quick-action \{[^}]*min-height: (\d+)px;/)
    assert.ok(page && Number(page[1]) >= 44, 'the phone copy is at least 44px tall')
    // The sidebar copy is displayed only while the sidebar is permanent
    // (>= 768px, a pointer), where it is a nav row like Home above it.
    assert.ok(/\.boe-quick-actions-sidebar \.boe-quick-action \{[^}]*min-height: 34px;/.test(css))
  })
})

// ── The form is one form ─────────────────────────────────────────────────────

describe('one form, both surfaces', () => {
  test('the list modal and the quick route mount the SAME component', () => {
    assert.ok(code(VIEW).includes('<ExpenseForm'))
    assert.ok(code(QUICK).includes('<ExpenseForm'))
    assert.ok(code(QUICK).includes("from '../ExpenseForm'"))
  })

  test('Add and Edit are distinguished, and Edit reuses the same fields', () => {
    const view = read(VIEW)
    assert.ok(view.includes('title="Add Expense"'))
    assert.ok(view.includes('title="Correct Expense"'))
    assert.ok(view.includes('mode="add"'))
    assert.ok(view.includes('mode="edit"'))
  })

  test('the form holds no rule of its own — they are all in the library', () => {
    const form = code(FORM)
    assert.ok(form.includes("from '@/lib/finance/expenses'"))
    assert.ok(form.includes("from '@/lib/finance/expenseVoice'"))
    // The two things a form must never re-implement:
    assert.equal(/payment_mode in \(|'cash', 'upi'/.test(form), false,
      'the mode list is imported, never restated')
    assert.equal(form.includes('parseFloat') || form.includes('Number(form.amount'), false,
      'an amount never becomes a double in the form')
  })

  test('IT REUSES THE SHARED FINANCE AMOUNT INPUT', () => {
    assert.ok(code(FORM).includes("from '@/app/finance/components/AmountInput'"))
    assert.ok(code(FORM).includes('<AmountInput'))
  })

  test('it reuses the shared Finance modal shell, toast and tokens', () => {
    assert.ok(code(FORM).includes("from '@/app/finance/components/FinanceModalShell'"))
    assert.ok(code(VIEW).includes("from '@/components/ui/toast'"))
    assert.ok(code(VIEW).includes("from '@/lib/tokens'"))
    assert.ok(code(FORM).includes("from '@/lib/tokens'"))
  })
})

// ── Double submission, and what a failed save keeps ─────────────────────────

describe('saving', () => {
  const form = code(FORM)

  test('DOUBLE SUBMISSION IS STOPPED BY A SYNCHRONOUS REF, not only by disabled', () => {
    // Two taps inside one frame both see a `saving` state that has not rendered
    // yet. The ref is what actually stops the second.
    assert.ok(form.includes('const inFlight = useRef(false)'))
    assert.ok(form.includes('if (inFlight.current) return'))
    assert.ok(form.includes('inFlight.current = true'))
    assert.ok(form.includes('disabled={saving}'))
  })

  test('the inline category modal is protected the same way', () => {
    assert.equal((form.match(/inFlight\.current = true/g) ?? []).length, 2,
      'both writes — the expense and the category — are guarded')
  })

  test('A FAILED SAVE KEEPS EVERY ENTERED VALUE', () => {
    // setSaveError, never a reset: nothing in the failure path clears the form.
    assert.ok(form.includes('setSaveError(friendlyWriteError(error))'))
    assert.ok(/if \(error\) \{[\s\S]{0,400}setSaveError[\s\S]{0,80}return/.test(form))
    // The only reset is the deliberate one, after a SUCCESSFUL "add another".
    const resets = form.match(/setForm\(emptyExpenseForm\(todayIso\)\)/g) ?? []
    assert.equal(resets.length, 1)
    assert.ok(/if \(andAnother\) \{\s*setForm\(emptyExpenseForm/.test(form))
  })

  test('a correction always names its author, and never rewrites who recorded it', () => {
    assert.ok(form.includes('updated_by: userId'))
    assert.equal(/\.update\(\{[^}]*created_by/.test(form), false,
      'created_by is never sent on an update — a trigger refuses it anyway')
    assert.ok(/\.insert\(\{ \.\.\.payload, created_by: userId \}\)/.test(form))
  })

  test('permission refusals are reported in words somebody can act on', () => {
    assert.ok(form.includes("error.code === '42501'"))
    assert.ok(form.includes('Ask an administrator for Finance access'))
  })
})

// ── Voice, at the component boundary ─────────────────────────────────────────

describe('voice entry, as the component wires it', () => {
  const form = code(FORM)

  // THE RECOGNISER MOVED INTO ONE SHARED HOOK when Quick Capture became a
  // second surface that listens. Two copies would drift, and the copy that
  // drifted would be the one that quietly gained an auto-submit — so these
  // assertions now read the hook, and assert that BOTH surfaces use it rather
  // than rolling their own.
  const speech = code(SPEECH)

  test('THERE IS EXACTLY ONE RECOGNISER, and both surfaces use it', () => {
    assert.ok(speech.includes('webkitSpeechRecognition'))
    for (const file of [FORM, CAPTURE]) {
      assert.ok(code(file).includes('useExpenseSpeech'), `${file} must use the shared hook`)
      assert.equal(/webkitSpeechRecognition|new Ctor\(\)/.test(code(file)), false,
        `${file} must not construct its own recogniser`)
    }
  })

  test('IT IS FEATURE-DETECTED, and no paid service is involved', () => {
    assert.ok(speech.includes('useVoiceSupported'))
    assert.ok(form.includes('{voice.supported && ('), 'no microphone where it cannot work')
    assert.ok(form.includes('{!voice.supported && ('), 'and one quiet line where it cannot')
    assert.ok(code(CAPTURE).includes('{voice.supported && ('))
    for (const file of [FORM, CAPTURE, SPEECH]) {
      assert.equal(code(file).includes('fetch('), false,
        'no network call: recognition is the browser\'s')
      assert.equal(/api[Kk]ey|openai|anthropic|huggingface|whisper|FAL_KEY/i.test(code(file)), false)
    }
  })

  test('NO AUDIO IS RETAINED — the recogniser is aborted on unmount', () => {
    assert.ok(speech.includes('recognitionRef.current?.abort()'))
    assert.equal(/MediaRecorder|getUserMedia|new Blob|upload/.test(speech), false,
      'nothing here records, stores or uploads audio')
  })

  test('A REFUSED MICROPHONE IS HANDLED, and both surfaces stay fully usable', () => {
    assert.ok(speech.includes("e.error === 'not-allowed'"))
    assert.ok(speech.includes('VOICE_DENIED_MESSAGE'))
    assert.ok(form.includes('VOICE_UNSUPPORTED_MESSAGE'))
    assert.ok(code(CAPTURE).includes('VOICE_UNSUPPORTED_MESSAGE'))
  })

  test('VOICE NEVER SAVES — there is no path from a transcript to a write', () => {
    // applyTranscript sets form state and nothing else. The only calls to
    // submit() are the two buttons a person presses.
    assert.equal(/applyTranscript[\s\S]{0,900}?submit\(/.test(form), false)
    const submitCalls = form.match(/submit\((true|false)\)/g) ?? []
    assert.deepEqual(submitCalls.sort(), ['submit(false)', 'submit(true)'],
      'exactly the two buttons, and nothing automatic')
  })

  test('the transcript is shown, and an unresolved field is highlighted', () => {
    assert.ok(form.includes('Heard: '))
    assert.ok(form.includes('voiceNotes.map'))
  })

  test('a suggested category needs a press before it exists', () => {
    assert.ok(form.includes('suggestedCategory &&'))
    assert.ok(form.includes('openAddCategory(suggestedCategory)'))
    assert.ok(form.includes('as a category'))
  })

  test('it asks for Indian English', () => {
    assert.ok(speech.includes("recognition.lang = 'en-IN'"))
  })
})

// ── The list ─────────────────────────────────────────────────────────────────

describe('the expense list', () => {
  const view = code(VIEW)

  test('newest first, by the date the money left', () => {
    assert.ok(view.includes(".order('expense_date', { ascending: false })"))
    assert.ok(view.includes(".order('id', { ascending: false })"))
  })

  test('every required column is declared', () => {
    // The headers are drawn from EXPENSE_TABLE_COLUMNS — the same list the
    // table's width threshold is computed from — so this reads the declaration
    // rather than the markup. The rendered header row is asserted against the
    // same list in expenseForm.render.test.tsx.
    const rendered = read(VIEW)
    for (const header of ['Date', 'Amount', 'Paid to', 'Category', 'Mode', 'Remark', 'Recorded by', 'Actions']) {
      assert.ok(rendered.includes(`label: '${header}'`), `${header} is missing from the column list`)
    }
  })

  test('the five filters and Clear are all there', () => {
    assert.ok(view.includes('dateFrom'))
    assert.ok(view.includes('dateTo'))
    assert.ok(view.includes('categoryId: e.target.value'))
    assert.ok(view.includes('paymentMode: e.target.value'))
    assert.ok(view.includes('setSearchTerm'))
    assert.ok(read(VIEW).includes('Clear filters'))
  })

  test('the search is debounced, because it is a database query', () => {
    assert.ok(/setTimeout\(\(\) => setFilters\(prev => \(\{ \.\.\.prev, search: searchTerm \}\)\), 300\)/.test(view))
  })

  test('THE TOTAL IS EXACT, and says which rows it describes', () => {
    assert.ok(view.includes('expenseTotal(rows)'))
    assert.ok(read(VIEW).includes('Total of the'), 'a capped list never presents a partial total as the whole')
    assert.ok(view.includes('const capped = total > rows.length'))
  })

  test('a failed read and an empty list are different states', () => {
    assert.ok(view.includes('setListError('))
    assert.ok(read(VIEW).includes('No expenses recorded yet.'))
    assert.ok(read(VIEW).includes('No expenses match these filters.'))
    assert.ok(read(VIEW).includes('could not be loaded'))
  })

  test('NO HORIZONTAL SCROLLING — cards replace the table when it would not fit', () => {
    assert.ok(view.includes('ResizeObserver'))
    assert.ok(view.includes('EXPENSE_TABLE_MIN_CONTAINER_PX'))
    assert.ok(view.includes('<ExpenseCards'))
    assert.equal(/overflowX:\s*'auto'|overflow-x:\s*auto/.test(view), false,
      'nothing here opts into a sideways scroll')
  })

  test('Edit and Delete are offered on exactly the rows the database would accept', () => {
    // The rule now lives in ONE place — expenseDeletion.ts — and the view uses
    // it rather than restating it, so a control drawn here and a policy in the
    // database cannot drift apart.
    assert.ok(view.includes('mayEditExpense(row, actor)'))
    assert.ok(view.includes('mayDeleteExpense(row, actor)'))
    assert.ok(view.includes('canManageFinance: caps.canManageFinance'))
  })

  test('NO SURFACE EVER ISSUES A HARD DELETE', () => {
    // PHASE 1 ASSERTED "no delete anywhere". Phase 2 adds removal deliberately,
    // and the guarantee that survives is the stronger, more precise one:
    // deletion is a TOMBSTONE, and no browser code path issues a DELETE against
    // any expense table. It could not succeed if it did — the migration grants
    // no DELETE policy and revokes the DELETE privilege from every client role.
    for (const file of [VIEW, FORM, QUICK, DELETE_MODAL, DRAFTS, CAPTURE]) {
      assert.equal(/\.delete\(\)/.test(code(file)), false, `${file} must not hard-delete`)
    }
    // The one write that removes an expense sets two columns and nothing else.
    assert.ok(code(DELETE_MODAL).includes('expenseSoftDeletePayload(userId)'))
  })
})

// ── Regression: what this work must not have touched ────────────────────────

// ── Phase 2 wiring ───────────────────────────────────────────────────────────

describe('THE EXPENSE LIST EXCLUDES DELETED EXPENSES FROM EVERY FIGURE', () => {
  const view = code(VIEW)

  test('the list query asks the DATABASE for live rows', () => {
    // Asked of the database rather than filtered in the browser, so the `count`
    // beside the rows counts live expenses and the total describes the same set.
    assert.ok(/from\('expenses'\)[\s\S]{0,400}?\.is\('deleted_at', null\)/.test(view))
  })

  test('so does the Smart suggestion\'s training set', () => {
    assert.ok(/select\('category_id, paid_to, remark, deleted_at'\)[\s\S]{0,120}?\.is\('deleted_at', null\)/.test(view),
      'a removed expense must not keep teaching the matcher')
  })

  test('and the total re-applies the rule a second time', () => {
    assert.ok(read('src/lib/finance/expenses.ts').includes('r.deleted_at == null'))
  })

  test('deleting refreshes the list, the total AND the training set', () => {
    const onDeleted = view.slice(view.indexOf('onDeleted={row =>'), view.indexOf('onDeleted={row =>') + 600)
    assert.ok(onDeleted.includes('loadExpenses()'))
    assert.ok(onDeleted.includes('loadHistory()'))
    assert.ok(onDeleted.includes('setRows(prev => prev.filter'),
      'the figure changes in the same frame as the toast, not a round trip later')
  })
})

describe('the Needs Details tab', () => {
  const view = code(VIEW)

  test('it is a prominent tab on the Expenses page, with a pending count', () => {
    assert.ok(view.includes('data-testid="expense-tabs"'))
    assert.ok(view.includes('label={NEEDS_DETAILS_LABEL}'))
    assert.ok(view.includes('badge={pendingCount}'))
    assert.ok(view.includes('pendingDraftCount(drafts)'))
  })

  test('IT READS ONLY PENDING CAPTURES', () => {
    assert.ok(/from\('expense_drafts'\)[\s\S]{0,200}?\.eq\('status', 'pending'\)/.test(view))
  })

  test('the badge is hidden at a real zero', () => {
    assert.ok(view.includes('badge > 0 &&'),
      'a badge showing 0 is a thing to read and dismiss, every time, forever')
  })

  test('A DRAFT NEVER REACHES THE EXPENSE TOTAL — the query cannot see one', () => {
    // Structural, not a filter: the expense query reads public.expenses and the
    // draft query reads public.expense_drafts, and the total is computed from
    // `rows`, which only the former fills.
    assert.ok(view.includes('const shownTotal = expenseTotal(rows)'))
    const listQuery = view.slice(view.indexOf('const loadExpenses'), view.indexOf('const loadExpenses') + 1400)
    assert.equal(listQuery.includes('expense_drafts'), false)
  })

  test('completing one goes through the ONE safe transaction', () => {
    assert.ok(code(FORM).includes("supabase.rpc('finalize_expense_draft'"))
    // And nowhere else writes an expense on a draft's behalf.
    assert.equal(/from\('expenses'\)\s*\.insert/.test(code(DRAFTS)), false)
  })
})

describe('SMART SUGGESTION IS LOCAL, DETERMINISTIC AND FREE', () => {
  const matcher = code('src/lib/finance/expenseCategoryMatch.ts')

  test('NO HOSTED MODEL, NO API KEY, NO NETWORK CALL — anywhere in the feature', () => {
    for (const file of [matcher, code(SUGGESTIONS), code(FORM), code(VIEW), code(CAPTURE)]) {
      assert.equal(/openai|anthropic|huggingface|hugging_face|gemini|cohere|replicate|whisper/i.test(file), false,
        'no hosted inference provider is named anywhere')
      assert.equal(/api[_-]?key|API_KEY|process\.env/i.test(file), false,
        'no key, and no environment variable that could hold one')
      assert.equal(/fetch\(|axios|XMLHttpRequest/.test(file), false,
        'no network call: the matcher reads rows already in memory')
    }
  })

  test('and no new dependency was added for it', () => {
    const pkg = JSON.parse(read('package.json'))
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    for (const name of deps) {
      assert.equal(/openai|anthropic|langchain|transformers|onnx|tensorflow/i.test(name), false,
        `${name} must not be a dependency of this repository`)
    }
  })

  test('THE UI CALLS IT "Smart suggestion" AND CLAIMS NOTHING MORE', () => {
    // Read with the comments STRIPPED: the file's header explains at length
    // that there is no model here, and the word it has to use to say so must
    // not be mistaken for a claim on the screen.
    const ui = code(SUGGESTIONS)
    assert.ok(ui.includes("SMART_SUGGESTION_LABEL = 'Smart suggestion'"))
    assert.equal(/\bAI\b|artificial intelligence|machine learning|neural|powered by/i.test(ui), false)
  })

  test('the form feeds it the purpose AND the payee, and weighs neither itself', () => {
    const form = code(FORM)
    assert.ok(form.includes('paidTo={form.paidTo}'))
    assert.ok(form.includes('purpose={form.remark}'))
    assert.ok(form.includes('history={history}'))
    // The weighting lives in the matcher, which is where the tests for it are.
    assert.equal(/PURPOSE_TERM_SCORE|PAYEE_SCORE/.test(form), false)
  })

  test('THE PURPOSE FIELD SITS ABOVE THE CATEGORY, because it feeds the suggestion', () => {
    const form = read(FORM)
    assert.ok(form.indexOf('id="expense-remark"') < form.indexOf('id="expense-category"'))
    assert.ok(form.indexOf('<SmartCategorySuggestions') > form.indexOf('id="expense-remark"'))
    assert.ok(form.indexOf('<SmartCategorySuggestions') < form.indexOf('id="expense-category"'))
  })
})

describe('the mobile shortcut still costs three actions', () => {
  const quick = read(QUICK)

  test('both ways in are visible at once — no chooser screen', () => {
    assert.ok(quick.includes('data-testid="entry-mode-choice"'))
    assert.ok(quick.includes('QUICK_CAPTURE_LABEL'))
    assert.ok(quick.includes("FULL_ENTRY_LABEL = 'Full Expense Entry'"))
  })

  test('QUICK CAPTURE IS SELECTED ON ARRIVAL', () => {
    assert.ok(code(QUICK).includes("useState<EntryMode>('capture')"),
      'a chooser screen would make the fast path four taps instead of three')
  })

  test('after a capture it says where it went, and offers both onward moves', () => {
    assert.ok(quick.includes('QUICK_CAPTURE_SAVED_MESSAGE'))
    assert.ok(quick.includes("CAPTURE_ANOTHER_LABEL = 'Capture another'"))
    assert.ok(quick.includes("COMPLETE_NOW_LABEL = 'Complete now'"))
  })

  test('"Complete now" opens the ordinary form in place, adding no screen', () => {
    assert.ok(code(QUICK).includes('mode="complete"'))
    assert.equal(code(QUICK).includes("router.push('/finance/expenses?"), false,
      'completing a capture does not bounce through the list')
  })

  test('the shortcut URL is unchanged — it is a promise to somebody\'s phone', () => {
    assert.equal(
      JSON.parse(read('public/manifest.json')).shortcuts[0].url,
      '/finance/expenses/new')
  })
})

describe('the migration is the one this work adds, and it is additive', () => {
  const sql = read(MIGRATION)

  test('it exists, and names its dependencies rather than assuming them', () => {
    assert.ok(existsSync(join(process.cwd(), MIGRATION)))
    assert.ok(sql.includes('DEPENDENCY MISSING: 20261220000000'))
    assert.ok(sql.includes('DEPENDENCY MISSING: 20260901000000'))
    assert.ok(sql.includes('DEPENDENCY MISSING: 20260905000000'))
  })

  test('EVERY MIGRATION THIS BRANCH ADDS BELONGS TO THIS FEATURE, and none is edited', () => {
    // Stated as a rule, not a fixed name: this feature lands over more than one
    // branch. What must hold on all of them is that a branch adds only expense
    // migrations, and EDITS none — an applied migration is immutable, and a
    // forward-only correction is a new file.
    //
    // A BRANCH MAY ADD NONE AT ALL. This assertion used to demand at least one,
    // which was a fair description of the two branches that existed when it was
    // written and a wrong one the moment a CODE-ONLY fix arrived: the Edit-crash
    // fix is a mapping bug in the browser and touches no schema. "Adds only
    // expense migrations" is the rule; "adds a migration" never was.
    const added = execFileSync('git', ['diff', '--name-only', '--diff-filter=A', 'origin/main...HEAD'],
      { cwd: process.cwd(), encoding: 'utf8' })
      .split('\n').map(s => s.trim()).filter(f => f.startsWith('supabase/migrations/'))
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', 'supabase/migrations'],
      { cwd: process.cwd(), encoding: 'utf8' })
      .split('\n').map(s => s.trim()).filter(Boolean)
    const all = [...new Set([...added, ...untracked])]
    for (const f of all) {
      // Order 0524's one-time handoff (20261230000000) is the one named
      // exception: a data fix for one Order, held by its own suites.
      if (f === 'supabase/migrations/20261230000000_order_0524_operations_handoff_for_existing_approval.sql') continue
      // And the Order/Finance write guards running as their owner
      // (20270105000000): ALTER FUNCTION only, held by its own suite.
      if (f === 'supabase/migrations/20270105000000_order_finance_guards_run_as_owner.sql') continue
      assert.ok(/^supabase\/migrations\/2026122[0-9]{7}_/.test(f),
        `${f} is not an expense-feature migration`)
    }

    const edited = execFileSync('git', ['diff', '--name-only', '--diff-filter=M', 'origin/main...HEAD'],
      { cwd: process.cwd(), encoding: 'utf8' })
      .split('\n').map(s => s.trim()).filter(f => f.startsWith('supabase/migrations/'))
    assert.deepEqual(edited, [], 'an applied migration is never edited')
  })
})

describe('REGRESSION — the existing Finance and Orders surfaces are unchanged', () => {
  /** The files this branch changed, against the base it started from. */
  // git QUOTES a path holding a space ("docs/Module Docs/…"), so the quotes
  // are stripped or the docs/ exclusion below would never match such a file.
  const unquote = (s: string) => s.replace(/^"(.*)"$/, '$1')
  const changed = execFileSync('git', ['diff', '--name-only', 'origin/main...HEAD'],
    { cwd: process.cwd(), encoding: 'utf8' })
    .split('\n').map(s => unquote(s.trim())).filter(Boolean)
  const staged = execFileSync('git', ['status', '--porcelain'],
    { cwd: process.cwd(), encoding: 'utf8' })
    .split('\n').map(s => unquote(s.slice(3).trim())).filter(Boolean)
  const touched = new Set([...changed, ...staged])

  /** The six production files this feature touches, and why each one. */
  const ALLOWED_EXISTING = new Set([
    'src/components/layout/FinanceLayout.tsx',   // one nav entry
    'src/lib/navigation/moduleNav.ts',           // one key, one title
    'src/app/modules/page.tsx',                  // the quick action
    'src/app/globals.css',                       // two appended, prefixed rules
    'public/manifest.json',                      // the shortcut
  ])

  /**
   * TEST FILES THAT HOLD A MIGRATION INVENTORY.
   *
   * This repository pins, in ten separate suites, the exact list of migrations
   * that sit after the one each suite is about — so that a new migration cannot
   * land unnoticed behind an older piece of work. Adding one therefore MEANS
   * adding a line to each of them; that is the convention working, not a
   * violation of it. Each entry below gained exactly that line and nothing else.
   *
   * imageEditor.test.ts is the one exception: its assertion pinned the launcher's
   * whole lucide-react import statement, which now also names the Quick Add
   * Expense icon. The assertion was widened to its actual intent and no further.
   */
  const ALLOWED_TESTS = new Set([
    'src/lib/navigation/moduleNav.test.ts',
    'src/lib/tasks/topTasksApproval.test.ts',
    'src/lib/boeCredits/reviewReward.test.ts',
    'src/lib/customerReviews/migration.test.ts',
    'src/lib/finance/participantAndOrderTotalSecurity.test.ts',
    'src/lib/notifications/activityLinkMigration.test.ts',
    'src/lib/notifications/groupMutations.test.ts',
    'src/lib/orders/orderFinanceTestReset.test.ts',
    'src/lib/orders/orderReservedPiGateAndBoeItemCodes.test.ts',
    'src/lib/tasks/assignmentWriteAuthority.test.ts',
    'src/lib/tasks/healthCheckMigrationAudit.test.ts',
    'src/lib/permissions/imageEditor.test.ts',
  ])

  /**
   * THE AUTHORIZED PI PREVIEW REFINEMENT (branch feat/pi-preview-refinement).
   *
   * WHY A SECOND LIST RATHER THAN A WIDER FILTER. These guards are written as
   * "this branch changed nothing but expenses", and they run against whatever
   * branch is checked out — so a later, unrelated, ALSO-authorized branch makes
   * them fail for a reason that has nothing to do with expenses. The property
   * worth keeping is the specific one: no Finance surface, no payment module,
   * no permission file and no Orders file OTHER than the named ones moved.
   *
   * So the names are spelled out, one by one, with no prefix match and no
   * wildcard. `src/app/orders/` as a pattern would let the Order detail page,
   * the approval controls or the drafts list through; these ten entries cannot.
   * A visual pass over the Upload PI screen is exactly:
   *
   *   the screen itself, the components it shares with the saved-draft screen,
   *   the view layer that decides what a field SAYS, and the six suites that
   *   hold all three to their promises.
   *
   * src/app/globals.css is already an accounted-for wiring point above; the
   * refinement's edit to it is a comment on a rule that already existed.
   */
  const ALLOWED_PI_PREVIEW_REFINEMENT = new Set([
    // Production — the Upload PI screen and what it renders with.
    'src/app/orders/import/page.tsx',
    'src/components/orders/piPreview.tsx',
    'src/lib/pi/previewView.ts',
    // The suites that guard them.
    'src/app/orders/import/importAccess.test.ts',
    'src/app/orders/piSectionOrder.test.ts',
    'src/app/orders/drafts/[submissionId]/piDetail.render.test.tsx',
    'src/lib/pi/previewView.test.ts',
    'src/lib/orders/finalApprovalScope.test.ts',
    'src/lib/orders/orderStartupShape.test.ts',
  ])

  /**
   * THE AUTHORIZED DRAFT PI BUSINESS RULES (branch feat/pi-upload-required-fields).
   *
   * Owner decision 2026-09-21: a Draft PI must state its date of creation, its
   * salesperson and their contact number, the client's name and city, who
   * provides the fabric, and the commercial terms — and may not be finalized
   * until it does. Same discipline as the list above: every name spelled out,
   * no prefix, no wildcard.
   *
   * THIS ONE LEGITIMATELY TOUCHES FILES THE LIST ABOVE CALLS UNTOUCHABLE, and
   * that is not a contradiction. A VISUAL PASS over the Upload PI screen has no
   * business in the saved-draft page or the parser; a change to what a PI must
   * SAY necessarily reaches both — the parser reads the new cells, the draft
   * page collects what the workbook did not carry, and the submission door
   * refuses what is still missing. The two lists are kept separate precisely so
   * that each branch's reach is readable on its own.
   *
   * Still excluded, and asserted below: every Order screen, permission file and
   * Finance surface this work has no reason to enter.
   */
  const ALLOWED_PI_DRAFT_BUSINESS_RULES = new Set([
    // Production — what a PI says, where it is said, and what refuses it.
    'src/lib/pi/masterSheetParser.ts',
    'src/lib/pi/types.ts',
    'src/lib/pi/previewView.ts',
    'src/lib/orders/piTerms.ts',
    'src/lib/orders/piReadiness.ts',
    'src/lib/orders/draftsView.ts',
    'src/lib/orders/orderPiHandoff.ts',
    'src/lib/orders/submissionPayload.ts',
    'src/lib/orders/confirmedPdf.ts',
    'src/lib/orders/confirmedPdfRender.ts',
    'src/app/api/orders/import/process-draft/route.ts',
    'src/app/orders/drafts/[submissionId]/page.tsx',
    'src/app/orders/drafts/[submissionId]/piDetailView.ts',
    'src/app/orders/drafts/[submissionId]/piDetailSections.tsx',
    'src/app/orders/drafts/page.tsx',
    'src/components/orders/piReviewModals.tsx',
    'src/components/ui/MultilineText.tsx',
    // The suites that hold them to it.
    'src/lib/pi/masterSheetParser.test.ts',
    'src/lib/pi/realWorkbook.test.ts',
    'src/lib/orders/piTerms.test.ts',
    'src/lib/orders/piFinalizationGate.test.ts',
    'src/lib/orders/confirmedPdf.test.ts',
    'src/lib/orders/orderPiHandoff.test.ts',
    'src/lib/orders/submissionPayload.test.ts',
    'src/lib/orders/finalApprovalScope.test.ts',
    'src/lib/orders/orderStartupShape.test.ts',
    'src/app/orders/drafts/[submissionId]/piDetail.render.test.tsx',
    'src/app/orders/drafts/draftsAccess.test.ts',
    'src/app/orders/import/importAccess.test.ts',
    'src/app/api/orders/import/salespersonContact.test.ts',
  ])

  test('the Draft PI allowance names files, never a directory', () => {
    for (const file of ALLOWED_PI_DRAFT_BUSINESS_RULES) {
      assert.ok(/\.(ts|tsx)$/.test(file), `${file} must be one file, not a directory`)
      assert.ok(!file.includes('*'), `${file} must not be a pattern`)
    }
    // What a change to what a PI SAYS still has no business in.
    for (const untouchable of [
      'src/app/orders/[id]/page.tsx',
      'src/app/orders/all/page.tsx',
      'src/lib/orders/submissionWorkflow.ts',
      'src/lib/orders/advanceRequirement.ts',
      'src/lib/orders/saveDraftFlow.ts',
      'src/lib/permissions/orders.ts',
      'src/lib/permissions/orderApproval.ts',
      'src/lib/finance/paymentEntry.ts',
    ]) {
      assert.equal(ALLOWED_PI_DRAFT_BUSINESS_RULES.has(untouchable), false,
        `${untouchable} is outside what a PI's own content reaches`)
      // AND UNCHANGED, unless another authorized branch legitimately reaches it.
      if (!ALLOWED_CONFIRMED_ORDER_DETAIL_REDESIGN.has(untouchable) && !ALLOWED_OPERATIONS_HANDOFF.has(untouchable)) {
        assert.equal(touched.has(untouchable), false, `${untouchable} must not change`)
      }
    }
  })

  /**
   * THE AUTHORIZED QUICK-ACTION PLACEMENT PASS
   * (branch feat/home-quick-actions-responsive).
   *
   * Same reasoning as ALLOWED_PI_PREVIEW_REFINEMENT above: these guards say
   * "this branch changed nothing but expenses", and they run against whatever
   * branch is checked out, so a later authorized branch trips them for a
   * reason that has nothing to do with expenses.
   *
   * This pass MOVED Quick Add Expense rather than changing it. The route, the
   * label, the icon and the permission gate are byte-for-byte what they were;
   * what changed is which of two containers draws them at a given width. That
   * needs exactly three files beyond the launcher page and globals.css, which
   * are already accounted for above:
   */
  /**
   * THE AUTHORIZED PI FINANCE-VERIFICATION REMOVAL
   * (branch fix/pi-finance-verification-duplicate).
   *
   * Same reasoning as the lists around it: these guards say "this branch
   * changed nothing but expenses", they run against whatever branch is checked
   * out, and a later authorized branch trips them for a reason that has nothing
   * to do with expenses.
   *
   * WHAT THIS BRANCH IS. The PI required TWO finance approvals for one
   * question — a document-level sign-off (verify_pi_finance_check) and
   * Finance's decision on each payment. The first is removed. Removing it
   * uncovered a real hole, which is also closed here: a PI that met 40% in
   * verified money could be approved while a further payment against it was
   * still undecided, because the payment position resolves 'standard_met'
   * before it looks at unverified money.
   *
   * WHY IT REACHES THESE FILES AND NOT MORE. The rule lives in finalApproval.ts
   * and is enforced in the migration; the three draft-page files render it; the
   * rest are the suites that held the removed behaviour and now hold its
   * absence. NOTHING in Finance's own payment surfaces is touched — who may
   * verify a payment, and how, is exactly what it was.
   */
  const ALLOWED_PI_FINANCE_VERIFICATION_REMOVAL = new Set([
    // Production — the rule, and the three surfaces that read it.
    'src/lib/orders/finalApproval.ts',
    'src/app/orders/drafts/[submissionId]/page.tsx',
    'src/app/orders/drafts/[submissionId]/piDetailView.ts',
    'src/app/orders/drafts/[submissionId]/piDetailSections.tsx',
    // The suites that held the removed step, and now hold its absence.
    'src/lib/orders/finalApproval.test.ts',
    'src/lib/orders/finalApprovalScope.test.ts',
    'src/lib/orders/reviewDecision.test.ts',
    'src/lib/orders/piReadinessWiring.test.ts',
    'src/lib/orders/piReadinessWiring.test.tsx',
    'src/lib/orders/piFinanceVerificationRemoval.test.ts',
    'src/lib/orders/orderReservedPiGateAndBoeItemCodes.test.ts',
    'src/app/orders/drafts/[submissionId]/piDetail.render.test.tsx',
    'src/app/orders/drafts/draftsAccess.test.ts',
    'src/components/orders/piApprovalModals.render.test.tsx',
  ])

  test('the finance-verification removal names files, never a directory', () => {
    for (const file of ALLOWED_PI_FINANCE_VERIFICATION_REMOVAL) {
      assert.ok(/\.(ts|tsx)$/.test(file), `${file} must be one file, not a directory`)
      assert.ok(!file.includes('*'), `${file} must not be a pattern`)
    }
    // WHAT REMOVING A DUPLICATE APPROVAL HAS NO BUSINESS IN. Finance's own
    // payment machinery above all: this branch changes WHETHER a PI-level
    // sign-off is required, never who may decide a payment or how.
    for (const untouchable of [
      'src/lib/permissions/finance.ts',
      'src/lib/permissions/orders.ts',
      'src/lib/permissions/orderApproval.ts',
      'src/lib/finance/paymentEntry.ts',
      'src/lib/finance/paymentDecision.ts',
      'src/lib/orders/paymentGate.ts',
      'src/lib/pi/masterSheetParser.ts',
      'src/lib/orders/piTerms.ts',
      'src/lib/orders/confirmedPdf.ts',
    ]) {
      assert.equal(ALLOWED_PI_FINANCE_VERIFICATION_REMOVAL.has(untouchable), false,
        `${untouchable} is outside what removing the duplicate approval reaches`)
      assert.equal(touched.has(untouchable), false, `${untouchable} must not change`)
    }
  })

  const ALLOWED_QUICK_ACTION_PLACEMENT = new Set([
    // The one definition list, and the one component that renders it.
    'src/components/layout/QuickActions.tsx',
    // The BOE OS shell, which now offers the sidebar placement. One prop,
    // one element, nothing below the Home nav block disturbed.
    'src/components/layout/BoeOsLayout.tsx',
    // Launcher card layout on small screens. No Finance surface uses it.
    'src/app/modules/modules.module.css',
  ])

  /**
   * THE GUARD ITSELF, as one function.
   *
   * The two assertions below used to spell this predicate out twice. It is
   * named once here so that the NEGATIVE test further down exercises the
   * very expression the guard runs on, rather than a copy of it that could
   * quietly drift and start proving nothing.
   *
   * Behaviour is unchanged from the two inline copies it replaces.
   * ALLOWED_TESTS was in one of them and not the other; every entry in it
   * ends in .test.ts, and the production caller filters test files out
   * before it ever gets here, so the sets cannot meet.
   */
  /**
   * THE CONFIRMED-ORDER DIALOG follow-up: preselect the salesperson the PI
   * already names, and cut the verification summary from nine repeated rows to
   * three.
   *
   * WHY IT REACHES THIS FILE AND NOT MORE. src/lib/orders/orderConfirmation.ts
   * is the module that already owns the four fields a Confirmed Order is built
   * from, so the "which saved salesperson does this PI mean" resolver belongs
   * beside validateOrderConfirmation rather than in a new module. It adds ONE
   * pure function and changes nothing that existed: not the four fields, not
   * the validation, not the labels, not the messages.
   *
   * NOTHING ABOUT AUTHORITY, MONEY OR THE RPC MOVES. approve_order_submission
   * still takes the same four parameters, still re-derives every one of them
   * under its own lock, and the page still sends the VALIDATED draft value —
   * preselection only ever seeds a control the person can still change.
   */
  const ALLOWED_PI_CONFIRMATION_DIALOG = new Set([
    // Production — the resolver, the summary it feeds, and the dialog.
    'src/lib/orders/orderConfirmation.ts',
    'src/app/orders/drafts/[submissionId]/page.tsx',
    'src/app/orders/drafts/[submissionId]/piDetailView.ts',
    'src/components/orders/piReviewModals.tsx',
    // The suites that hold them to it.
    'src/components/orders/piApprovalModals.render.test.tsx',
    'src/lib/orders/reviewDecision.test.ts',
  ])

  test('the confirmation-dialog allowance names files, never a directory', () => {
    for (const file of ALLOWED_PI_CONFIRMATION_DIALOG) {
      assert.ok(/\.(tsx?)$/.test(file), `${file} must be one file, not a directory`)
      assert.equal(file.endsWith('/'), false, `${file} must not be a folder`)
      assert.equal(file.includes('*'), false, `${file} must not be a pattern`)
      assert.equal(file.includes('..'), false, `${file} must not escape upwards`)
    }
    // It admits no Finance surface, no permission file and no migration.
    for (const untouchable of [
      'src/app/finance/page.tsx',
      'src/app/finance/received/ReceivedPaymentsView.tsx',
      'src/lib/finance/paymentEntry.ts',
      'src/lib/permissions/finance.ts',
      'src/lib/permissions/orders.ts',
      'src/lib/orders/finalApproval.ts',
    ]) {
      assert.equal(ALLOWED_PI_CONFIRMATION_DIALOG.has(untouchable), false,
        `${untouchable} must not ride in on the confirmation-dialog allowance`)
    }
  })

  /**
   * MODULE CARDS + ADMIN QUOTATION CREATION. Two small presentation changes
   * that share a branch and touch nothing this guard protects.
   *
   * The launcher card drops its description and its "Open →" footer at every
   * width, leaving an icon, its notification badge and the module name, and
   * gains Space alongside Enter on the card's existing role="button". Both of
   * those land in src/app/modules/, which ALLOWED_QUICK_ACTION_PLACEMENT
   * already names — so the launcher contributes no entry here.
   *
   * The three below are the quotation half. An admin no longer sees the offer
   * to RAISE a quotation request: the New Request header button, the sidebar's
   * New Quotation Request item, and the empty state that points at them.
   *
   * IT IS ONE NEW BOOLEAN ON AN EXISTING HELPER, not a second role system.
   * deriveQuotationCapabilities already took `role` and already short-circuited
   * on admin; canCreateQuotations narrows canManageQuotations and never widens
   * it. canViewQuotations and canManageQuotations are unchanged for every role,
   * so an admin keeps reviewing, responding, approving and rejecting, and every
   * non-admin that could raise a request still can.
   *
   * NOTHING BELOW THE INTERFACE MOVES. No RLS, no RPC, no policy, no migration,
   * no route handler — the quotation actions have no RLS backing at all (see
   * the enforcement note in src/lib/permissions/quotations.ts), so there was
   * nothing to keep in step even if this had wanted to.
   */
  const ALLOWED_MODULE_CARD_AND_QUOTATION_CREATE = new Set([
    'src/lib/permissions/quotations.ts',          // the new canCreateQuotations
    'src/components/layout/DashboardLayout.tsx',  // sidebar New Quotation Request
    'src/app/tasks/quotation-requests/page.tsx',  // header button + empty state
    // The suites that hold both halves to it. notificationCountCache is an
    // EXISTING suite and had to move: three of its assertions read the card's
    // footer for "No notifications" and the loading placeholder, and that
    // footer no longer exists. Its subject — what the cache stores and returns
    // — is unchanged and still asserted.
    'src/lib/notificationCountCache.test.ts',
    // Two more EXISTING suites that read the card's footer or deep-equal the
    // capability object, and had to follow the change for the same reason.
    'src/lib/permissions/moduleParentGate.test.ts',
    'src/lib/permissions/protectedVisibility.test.ts',
    'src/app/modules/moduleCardSurface.test.ts',
    'src/lib/permissions/quotationCreateVisibility.test.ts',
  ])

  test('the module-card and quotation allowance names files, never a directory', () => {
    for (const file of ALLOWED_MODULE_CARD_AND_QUOTATION_CREATE) {
      assert.ok(/\.(tsx?)$/.test(file), `${file} must be one file, not a directory`)
      assert.equal(file.endsWith('/'), false, `${file} must not be a folder`)
      assert.equal(file.includes('*'), false, `${file} must not be a pattern`)
      assert.equal(file.includes('..'), false, `${file} must not escape upwards`)
    }
    // It admits no Finance or Orders surface, and no permission file other than
    // the quotation one it exists for.
    for (const untouchable of [
      'src/app/finance/page.tsx',
      'src/app/finance/received/ReceivedPaymentsView.tsx',
      'src/lib/finance/paymentEntry.ts',
      'src/lib/permissions/finance.ts',
      'src/lib/permissions/orders.ts',
      'src/lib/orders/finalApproval.ts',
    ]) {
      assert.equal(ALLOWED_MODULE_CARD_AND_QUOTATION_CREATE.has(untouchable), false,
        `${untouchable} must not ride in on the module-card and quotation allowance`)
    }
  })

  /**
   * THE PERSONAL MODULE ORDER (branch feat/personal-module-order).
   *
   * Each signed-in person can arrange their own /modules launcher cards. Five
   * NEW files, and not one of them is an edit to anything that already existed:
   * the launcher itself and its stylesheet are already accounted for above
   * (ALLOWED_EXISTING and ALLOWED_QUICK_ACTION_PLACEMENT), the migration is
   * covered by the supabase/migrations/2026122 prefix, and the executable SQL
   * checks by the supabase/tests/ prefix.
   *
   * WHY IT REACHES NO FINANCE OR ORDERS SURFACE. The feature sorts an array the
   * permission engine has already built, and the ordering module is written so
   * it cannot do anything else: it takes a list of `{ key }` and returns a
   * permutation of it. A stored key naming a module somebody may not open
   * selects no card, because there is no card for it to select. It reads no
   * permission, no route and no title, and public.user_module_order references
   * nothing but auth.users.
   *
   * NOTHING BELOW THE INTERFACE MOVES for Finance or Orders: no existing table,
   * column, policy, function, trigger or grant is altered by the migration, and
   * it contains no DML of any kind.
   */
  const ALLOWED_PERSONAL_MODULE_ORDER = new Set([
    // The ordering decision, with no React and no Supabase in it.
    'src/lib/modules/moduleOrder.ts',
    // The read and the one upsert, keyed by the signed-in user.
    'src/hooks/queries/useModuleOrder.ts',
    // Edit mode: the controls beside the heading, the drag handle, the pointer
    // drag. Rendered only while somebody is rearranging.
    'src/app/modules/ModuleOrderControls.tsx',
    // The two suites that hold all of it to its promises.
    'src/lib/modules/moduleOrder.test.ts',
    'src/lib/modules/moduleOrderStorage.test.ts',
  ])

  test('the personal module-order allowance names files, never a directory', () => {
    for (const file of ALLOWED_PERSONAL_MODULE_ORDER) {
      assert.ok(/\.(tsx?)$/.test(file), `${file} must be one file, not a directory`)
      assert.equal(file.endsWith('/'), false, `${file} must not be a folder`)
      assert.equal(file.includes('*'), false, `${file} must not be a pattern`)
      assert.equal(file.includes('..'), false, `${file} must not escape upwards`)
      // No Finance, Orders, payment, PI or permission file may ride in on a
      // launcher-ordering allowance.
      assert.equal(
        /^src\/(app\/finance|app\/orders|lib\/finance|lib\/orders|lib\/pi|lib\/permissions)\//.test(file),
        false, `${file} is not a launcher-ordering file`)
    }
    // Every entry is NEW on this branch. An allowance for a display preference
    // has no business admitting an edit to something that already shipped.
    for (const untouchable of [
      'src/app/finance/page.tsx',
      'src/lib/finance/paymentEntry.ts',
      'src/lib/permissions/finance.ts',
      'src/lib/permissions/orders.ts',
      'src/lib/permissions/moduleVisibility.ts',
      'src/lib/orders/finalApproval.ts',
      'src/components/layout/ModuleGuard.tsx',
    ]) {
      assert.equal(ALLOWED_PERSONAL_MODULE_ORDER.has(untouchable), false,
        `${untouchable} must not ride in on the personal module-order allowance`)
    }
    // And it may not shadow anything an earlier list already accounts for.
    for (const file of ALLOWED_PERSONAL_MODULE_ORDER) {
      assert.equal(ALLOWED_EXISTING.has(file), false)
      assert.equal(ALLOWED_QUICK_ACTION_PLACEMENT.has(file), false)
      assert.equal(ALLOWED_MODULE_CARD_AND_QUOTATION_CREATE.has(file), false)
    }
  })

  /**
   * THE AUTHORIZED CONFIRMED ORDER DETAIL REDESIGN
   * (branch feat/confirmed-order-detail-redesign).
   *
   * Same reasoning as the allowances above. A presentation pass over
   * /orders/[id]: no migration, no RPC, no permission module and no money
   * calculator is in it, which the assertion below proves rather than asserts.
   */
  const ALLOWED_CONFIRMED_ORDER_DETAIL_REDESIGN = new Set([
    'src/app/orders/[id]/page.tsx',
    'src/app/orders/[id]/OrderWorkspace.tsx',
    'src/app/orders/[id]/OrderStatusWorkspace.tsx',
    'src/lib/orders/orderWorkspace.ts',
    'src/lib/orders/orderPaymentLists.ts',
    'src/lib/orders/orderDocumentsPanel.ts',
    'src/app/globals.css',
    // The one shared file it reaches: a per-page opt-out for the Finance
    // switch, defaulted so every other Orders screen keeps it.
    'src/components/layout/OrdersLayout.tsx',
    // The suites that hold it to its promises.
    'src/lib/orders/orderPaymentLists.test.ts',
    'src/app/orders/[id]/orderDetailArchitecture.test.ts',
    'src/app/orders/[id]/orderFinanceSwitchAndDetailGate.test.ts',
    'src/app/orders/[id]/orderWorkspace.render.test.tsx',
    'src/app/orders/[id]/orderStatusWorkspace.render.test.tsx',
    'src/app/orders/[id]/orderCurrentStatus.render.test.tsx',
    'src/app/orders/[id]/orderPiHandoff.render.test.tsx',
    'src/lib/finance/crossModuleLinks.test.ts',
    'src/lib/finance/orderFinancePosition.test.ts',
    'src/lib/finance/paymentEntry.test.ts',
    'src/lib/orders/orderPayments.test.ts',
  ])

  test('the Confirmed Order redesign allowance names files, never a directory', () => {
    for (const file of ALLOWED_CONFIRMED_ORDER_DETAIL_REDESIGN) {
      assert.ok(/\.(tsx?|css)$/.test(file), `${file} must be one file, not a directory`)
      assert.equal(file.endsWith('/'), false, `${file} must not be a folder`)
      assert.equal(file.includes('*'), false, `${file} must not be a pattern`)
      assert.equal(file.includes('..'), false, `${file} must not escape upwards`)
    }
    // A PRESENTATION PASS REACHES NO RULE.
    for (const untouchable of [
      'src/lib/finance/orderFinancePosition.ts',
      'src/lib/finance/exactMoney.ts',
      'src/lib/finance/paymentEntry.ts',
      'src/lib/finance/allocation.ts',
      'src/lib/orders/orderPayments.ts',
      'src/lib/orders/orderCurrentStatus.ts',
      'src/lib/orders/orderAdvance.ts',
      'src/lib/orders/productionAlignment.ts',
      'src/lib/orders/orderApprovals.ts',
      'src/lib/orders/orderPiHandoff.ts',
      'src/lib/permissions/finance.ts',
      'src/lib/permissions/orders.ts',
      'src/app/finance/received/RecordSplitPaymentModal.tsx',
    ]) {
      assert.equal(ALLOWED_CONFIRMED_ORDER_DETAIL_REDESIGN.has(untouchable), false,
        `${untouchable} must not ride in on a presentation allowance`)
      assert.equal(touched.has(untouchable), false, `${untouchable} must not change`)
    }
  })

  /**
   * THE AUTHORIZED PI-TO-OPERATIONS HANDOFF (20261229000000).
   *
   * Phase 1 of the handoff: one migration (two new tables, one trigger on
   * order_pi_versions, two RPCs), the rules module the page reads from, the
   * Operations review card and its dialog on the Order, the notification types
   * and their link, the dashboard card and the Action Queue row, the Control
   * Center assignment, and the history words. Every file is named, one by
   * one. It reaches NO payment, allocation, balance, dispatch or order-data
   * editing file: the untouchable lists below still hold.
   */
  const ALLOWED_OPERATIONS_HANDOFF = new Set([
    'src/lib/orders/operationsHandoff.ts',
    'src/lib/orders/orderHistory.ts',
    'src/lib/orders/orderWorkspace.ts',
    'src/lib/orders/orderDashboard.ts',
    'src/lib/notifications.ts',
    'src/lib/notificationMeta.ts',
    'src/app/orders/[id]/page.tsx',
    'src/app/orders/[id]/OrderStatusWorkspace.tsx',
    'src/app/orders/[id]/OrderRevisionModals.tsx',
    'src/app/orders/page.tsx',
    'src/app/orders/all/page.tsx',
    'src/app/admin/control-center/page.tsx',
    'src/app/admin/control-center/action-queue/page.tsx',
    'src/components/layout/ControlCenterLayout.tsx',
    'src/app/globals.css',
    // The suites that hold it to its promises, and the pins it moved.
    'src/lib/orders/operationsHandoff.test.ts',
    'src/lib/orders/operationsHandoffSchema.test.ts',
    'src/app/orders/[id]/orderOperationsReview.render.test.tsx',
    'src/lib/notificationSystemActivity.test.ts',
    'src/lib/modules/moduleOrderStorage.test.ts',
  ])

  /**
   * ORDER 0524's ONE-TIME HANDOFF (20261230000000).
   *
   * One data migration sending one pre-existing approval to operations review,
   * one extra detail on the history line that migration writes, and the suites
   * that hold it — plus the one-line inventory pins it moved. No screen, no
   * rule, no money.
   */
  const ALLOWED_ORDER_0524_HANDOFF = new Set([
    'src/lib/orders/operationsHandoff.ts',
    'src/lib/orders/operationsHandoff.test.ts',
    'src/lib/orders/order0524OperationsHandoffMigration.test.ts',
    'src/app/orders/[id]/orderOperationsReview.render.test.tsx',
    // migration inventories: one line each
    'src/lib/boeCredits/reviewReward.test.ts',
    'src/lib/finance/participantAndOrderTotalSecurity.test.ts',
    'src/lib/modules/moduleOrderStorage.test.ts',
    'src/lib/notifications/activityLinkMigration.test.ts',
    'src/lib/notifications/groupMutations.test.ts',
    'src/lib/notificationSystemActivity.test.ts',
    'src/lib/orders/orderFinanceTestReset.test.ts',
    'src/lib/orders/orderReservedPiGateAndBoeItemCodes.test.ts',
    'src/lib/orders/piFinanceVerificationRemoval.test.ts',
    'src/lib/tasks/assignmentWriteAuthority.test.ts',
    'src/lib/tasks/healthCheckMigrationAudit.test.ts',
    'src/lib/tasks/topTasksApproval.test.ts',
  ])
  /**
   * THE PI FORMAT DOWNLOAD. One link on the Orders dashboard, open to every
   * reader who can enter Orders, and the route that serves the approved workbook
   * from private storage. No screen besides the dashboard, no rule, no money.
   */
  const ALLOWED_PI_FORMAT_DOWNLOAD = new Set([
    'src/lib/orders/piFormat.ts',
    'src/app/api/orders/pi-format/route.ts',
    'src/app/api/orders/pi-format/route.test.ts',
    'src/app/orders/page.tsx',
  ])
  const ORDER_0524_HANDOFF_MIGRATION = 'supabase/migrations/20261230000000_order_0524_operations_handoff_for_existing_approval.sql'

  /**
   * THE ORDER AND FINANCE WRITE GUARDS RUN AS THEIR OWNER (20270105000000).
   *
   * One migration of ALTER FUNCTION statements — no screen, no rule, no
   * money — its own suite, and the one-line inventory pins it moved.
   */
  const ALLOWED_GUARDS_RUN_AS_OWNER = new Set([
    'src/lib/orders/orderFinanceGuardsRunAsOwner.test.ts',
    // migration inventories: one line each
    'src/lib/boeCredits/reviewReward.test.ts',
    'src/lib/finance/participantAndOrderTotalSecurity.test.ts',
    'src/lib/modules/moduleOrderStorage.test.ts',
    'src/lib/notifications/activityLinkMigration.test.ts',
    'src/lib/notifications/groupMutations.test.ts',
    'src/lib/orders/orderFinanceTestReset.test.ts',
    'src/lib/orders/orderReservedPiGateAndBoeItemCodes.test.ts',
    'src/lib/orders/piFinanceVerificationRemoval.test.ts',
    'src/lib/tasks/assignmentWriteAuthority.test.ts',
    'src/lib/tasks/healthCheckMigrationAudit.test.ts',
    'src/lib/tasks/topTasksApproval.test.ts',
  ])
  const GUARDS_RUN_AS_OWNER_MIGRATION = 'supabase/migrations/20270105000000_order_finance_guards_run_as_owner.sql'

  /**
   * THE OPERATIONS REVIEW DECISION MOVES ONTO THE ATTENTION STRIP.
   *
   * A UI relocation on the Confirmed Order: the Operations review card is
   * gone, its Cannot accept / Accept for production sit on the strip, and
   * Withdraw acceptance joins the header overflow. Same RPC, same dialog, same
   * rule. Every file is named; no migration, no permission, no money.
   */
  const ALLOWED_OPERATIONS_REVIEW_ON_STRIP = new Set([
    'src/app/orders/[id]/page.tsx',
    'src/app/orders/[id]/OrderWorkspace.tsx',
    'src/app/orders/[id]/OrderStatusWorkspace.tsx',
    'src/lib/orders/orderWorkspace.ts',
    'src/app/globals.css',
    'src/app/orders/[id]/orderOperationsReview.render.test.tsx',
    'src/lib/orders/operationsHandoffSchema.test.ts',
    'src/lib/orders/orderWorkspace.test.ts',
    'src/lib/orders/operationsHandoff.test.ts',
  ])

  /**
   * Account Settings moves into the shared BoeOsLayout shell. The page itself,
   * the identity menu that now marks it as the current destination, and the
   * Back-button pin that becomes "returnTo is no longer followed". No Finance
   * or Orders file, no migration, no permission.
   */
  const ALLOWED_ACCOUNT_SETTINGS_LAYOUT = new Set([
    'src/app/account/page.tsx',
    'src/components/layout/AdminViewModeControls.tsx',
    'src/lib/safeReturnPath.test.ts',
  ])

  const isUnexpectedFile = (f: string) =>
    !f.startsWith('src/app/finance/expenses/') &&
    !f.startsWith('src/lib/finance/expense') &&
    !f.startsWith('supabase/migrations/2026122') &&
    // supabase/tests IS NOT PRODUCTION. Every file there builds and drops a
    // disposable local database and, by the header of each runner, never
    // talks to a linked project.
    !f.startsWith('supabase/tests/') &&
    !f.startsWith('docs/') &&
    !ALLOWED_EXISTING.has(f) &&
    !ALLOWED_TESTS.has(f) &&
    !ALLOWED_PI_PREVIEW_REFINEMENT.has(f) &&
    !ALLOWED_QUICK_ACTION_PLACEMENT.has(f) &&
    !ALLOWED_PI_DRAFT_BUSINESS_RULES.has(f) &&
    !ALLOWED_PI_FINANCE_VERIFICATION_REMOVAL.has(f) &&
    !ALLOWED_PI_CONFIRMATION_DIALOG.has(f) &&
    !ALLOWED_MODULE_CARD_AND_QUOTATION_CREATE.has(f) &&
    !ALLOWED_PERSONAL_MODULE_ORDER.has(f) &&
    !ALLOWED_CONFIRMED_ORDER_DETAIL_REDESIGN.has(f) &&
    !ALLOWED_OPERATIONS_HANDOFF.has(f) &&
    !ALLOWED_ORDER_0524_HANDOFF.has(f) &&
    !ALLOWED_OPERATIONS_REVIEW_ON_STRIP.has(f) &&
    !ALLOWED_PI_FORMAT_DOWNLOAD.has(f) &&
    !ALLOWED_ACCOUNT_SETTINGS_LAYOUT.has(f) &&
    !ALLOWED_GUARDS_RUN_AS_OWNER.has(f) &&
    f !== ORDER_0524_HANDOFF_MIGRATION &&
    f !== GUARDS_RUN_AS_OWNER_MIGRATION

  test('the operations-handoff allowance names files, never a directory, and reaches no money', () => {
    for (const file of ALLOWED_OPERATIONS_HANDOFF) {
      assert.ok(/\.(tsx?|css)$/.test(file), `${file} must be one file, not a directory`)
      assert.equal(file.endsWith('/'), false, `${file} must not be a folder`)
      assert.equal(file.includes('*'), false, `${file} must not be a pattern`)
      assert.equal(file.includes('..'), false, `${file} must not escape upwards`)
      assert.equal(/^src\/(app|lib)\/finance\//.test(file), false, `${file} is a Finance file`)
    }
    // A HANDOFF REACHES NO ORDER DATA. Nothing that edits a PI's figures, a
    // payment, an allocation, alignment or dispatch rides in on it.
    for (const untouchable of [
      'src/lib/orders/productionAlignment.ts',
      'src/lib/orders/orderPiVersions.ts',
      'src/lib/orders/orderPiHandoff.ts',
      'src/lib/orders/amendments.ts',
      'src/lib/orders/orderPayments.ts',
      'src/lib/permissions/orders.ts',
      'src/lib/permissions/finance.ts',
      'src/app/api/orders/pi-revisions/approve/route.ts',
      'src/app/api/orders/import/process-draft/route.ts',
      'src/app/orders/[id]/OrderAmendmentModals.tsx',
    ]) {
      assert.equal(ALLOWED_OPERATIONS_HANDOFF.has(untouchable), false, `${untouchable} must not ride in on the handoff`)
      assert.equal(touched.has(untouchable), false, `${untouchable} must not change`)
    }
  })

  test('the operations-review-on-strip allowance is EXACTLY its nine named files, and the guard still bites beside them', () => {
    // Pinned by value: growing it has to be a deliberate edit here.
    assert.deepEqual([...ALLOWED_OPERATIONS_REVIEW_ON_STRIP].sort(), [
      'src/app/globals.css',
      'src/app/orders/[id]/OrderStatusWorkspace.tsx',
      'src/app/orders/[id]/OrderWorkspace.tsx',
      'src/app/orders/[id]/orderOperationsReview.render.test.tsx',
      'src/app/orders/[id]/page.tsx',
      'src/lib/orders/operationsHandoff.test.ts',
      'src/lib/orders/operationsHandoffSchema.test.ts',
      'src/lib/orders/orderWorkspace.test.ts',
      'src/lib/orders/orderWorkspace.ts',
    ])
    for (const file of ALLOWED_OPERATIONS_REVIEW_ON_STRIP) {
      assert.ok(/\.(tsx?|css)$/.test(file), `${file} must be one file, not a directory`)
      assert.equal(file.includes('*'), false, `${file} must not be a pattern`)
      assert.equal(/^src\/(app|lib)\/finance\//.test(file), false, `${file} is a Finance file`)
      assert.equal(/^src\/lib\/permissions\//.test(file), false, `${file} is a permission file`)
      assert.equal(file.startsWith('supabase/'), false, `${file} is a migration`)
    }
    // Siblings of the named files are still intruders: no prefix leak.
    for (const neighbour of [
      'src/app/orders/[id]/OrderPiSections.tsx',
      'src/app/orders/[id]/OrderAmendmentModals.tsx',
      'src/lib/orders/orderPayments.ts',
      'src/lib/permissions/orders.ts',
    ]) {
      assert.ok(isUnexpectedFile(neighbour), `${neighbour} must still trip the guard`)
    }
  })

  test('the quick-action allowance is EXACTLY three named files', () => {
    // Pinned by value, not by shape. Growing the allowance has to be a
    // deliberate edit to this assertion, which is the point of it.
    assert.deepEqual([...ALLOWED_QUICK_ACTION_PLACEMENT].sort(), [
      'src/app/modules/modules.module.css',
      'src/components/layout/BoeOsLayout.tsx',
      'src/components/layout/QuickActions.tsx',
    ])
  })

  test('it names files, never a directory, a pattern or a Finance surface', () => {
    for (const file of ALLOWED_QUICK_ACTION_PLACEMENT) {
      assert.ok(/\.(tsx?|css)$/.test(file), `${file} must be one file, not a directory`)
      assert.equal(file.endsWith('/'), false, `${file} must not be a folder`)
      assert.equal(file.includes('*'), false, `${file} must not be a pattern`)
      assert.equal(file.includes('..'), false, `${file} must not escape upwards`)
      // No Finance, Orders, payment or permission file may ride in on a
      // layout allowance.
      assert.equal(
        /^src\/(app\/finance|app\/orders|lib\/finance|lib\/orders|lib\/pi|lib\/permissions)\//.test(file),
        false, `${file} is not a layout file`)
    }
    // And it may not shadow anything the PI list already accounts for.
    for (const file of ALLOWED_QUICK_ACTION_PLACEMENT) {
      assert.equal(ALLOWED_PI_PREVIEW_REFINEMENT.has(file), false)
    }
  })

  test('THE GUARD STILL BITES \u2014 an unrelated changed file fails it', () => {
    // The negative half of the allowance. Adding a list of permitted files
    // is only safe if the guard still rejects everything else, so this runs
    // the REAL predicate (isUnexpectedFile, the one both assertions above
    // call) over files this branch has no business touching.
    for (const intruder of [
      // Finance and payment surfaces the expense guard exists to protect.
      'src/app/finance/page.tsx',
      'src/app/finance/received/ReceivedPaymentsView.tsx',
      'src/lib/finance/paymentEntry.ts',
      'src/lib/finance/allocation.ts',
      // Permission files — the gate this work deliberately did not touch.
      'src/lib/permissions/finance.ts',
      'src/lib/permissions/orders.ts',
      // Orders screens. The Confirmed Order's own page.tsx and OrdersLayout.tsx
      // left this list when the redesign named them, as drafts/page.tsx did
      // before them, and all/page.tsx when the operations handoff named it
      // (its ?ops=awaiting queue); their siblings below keep the prefix leak
      // probed.
      'src/app/orders/notifications/page.tsx',
      'src/app/orders/[id]/OrderAmendmentModals.tsx',
      'src/app/orders/[id]/OrderPiSections.tsx',
      // src/app/orders/drafts/page.tsx WAS on this list and is not any more.
      // It is not that the guard got weaker: the Draft PI business rules branch
      // legitimately renames that screen's "Created by" column to "Salesperson",
      // so the file is now a NAMED entry in ALLOWED_PI_DRAFT_BUSINESS_RULES and
      // can no longer serve as an intruder. Another Orders screen takes its
      // place above, so the category is still probed.
      // NEAR MISSES. Each one probes for a prefix leak: a sibling in the
      // same folder as an allowed file must NOT be admitted by it.
      'src/components/layout/QuickActionsExtra.tsx',
      'src/components/layout/RecordBackLink.tsx',
      'src/app/modules/somethingElse.module.css',
      'src/app/modules/layout.tsx',
      // And something entirely unrelated.
      'src/app/tasks/page.tsx',
    ]) {
      assert.ok(isUnexpectedFile(intruder),
        `${intruder} must still trip the guard — the allowance is too wide`)
    }

    // The three that ARE allowed pass, so the check above is not vacuous.
    for (const allowed of ALLOWED_QUICK_ACTION_PLACEMENT) {
      assert.equal(isUnexpectedFile(allowed), false, `${allowed} should be allowed`)
    }

    // End to end: an intruder in the touched set makes the guard FAIL, not
    // merely register. This is the assertion 'NO EXISTING FINANCE OR ORDERS
    // SCREEN WAS EDITED' runs, with one extra file in the input.
    const withIntruder = [...touched, 'src/app/finance/page.tsx'].filter(isUnexpectedFile)
    assert.deepEqual(withIntruder, ['src/app/finance/page.tsx'])
  })

  test('the PI refinement allowance names files, never a directory', () => {
    // The guard above is only as good as this: a future edit that turns one of
    // these into a prefix would silently readmit every Orders screen.
    for (const file of ALLOWED_PI_PREVIEW_REFINEMENT) {
      assert.ok(/\.(ts|tsx)$/.test(file), `${file} must be one file, not a directory`)
      assert.ok(!file.includes('*'), `${file} must not be a pattern`)
    }
    for (const untouchable of [
      'src/app/orders/[id]/page.tsx',
      'src/app/orders/[id]/OrderPiSections.tsx',
      'src/app/orders/drafts/[submissionId]/page.tsx',
      'src/app/orders/drafts/page.tsx',
      'src/lib/orders/submissionWorkflow.ts',
      'src/lib/orders/advanceRequirement.ts',
      'src/lib/orders/saveDraftFlow.ts',
      'src/lib/pi/masterSheetParser.ts',
      'src/lib/permissions/orders.ts',
      'src/lib/permissions/orderApproval.ts',
    ]) {
      assert.equal(ALLOWED_PI_PREVIEW_REFINEMENT.has(untouchable), false,
        `${untouchable} is an Orders file the visual pass has no business in`)
      // AND UNCHANGED, unless another authorized branch legitimately reaches
      // it. The property this test owns is that the VISUAL PASS did not, which
      // the membership assertion above is what actually proves; a second
      // authorized branch changing the file says nothing about this one.
      if (!ALLOWED_PI_DRAFT_BUSINESS_RULES.has(untouchable)
          && !ALLOWED_CONFIRMED_ORDER_DETAIL_REDESIGN.has(untouchable)) {
        assert.equal(touched.has(untouchable), false, `${untouchable} must not change`)
      }
    }
  })

  test('NO PRODUCTION CODE WAS CHANGED EXCEPT THE SIX WIRING POINTS', () => {
    const production = [...touched].filter(f =>
      /\.(ts|tsx|css|json|sql|sh)$/.test(f) && !/\.test\.tsx?$/.test(f))
    const unexpected = production.filter(isUnexpectedFile)
    assert.deepEqual(unexpected, [])
  })

  test('anything it adds under supabase/tests belongs to the expense suite', () => {
    // Written as a RULE rather than a fixed list, because this feature lands
    // over more than one branch: the phase that adds the suite and any
    // follow-up that does not. Either way, nothing unrelated may appear here.
    const added = [...touched].filter(f => f.startsWith('supabase/tests/'))
    for (const f of added) {
      assert.ok(/expense_lifecycle|personal_module_order|order_operations_handoff|order_0524_operations_handoff/.test(f),
        `${f} does not belong to this feature`)
    }
    // Order 0524's runner is held to the same rule as the handoff's.
    if (added.some(f => /order_0524_operations_handoff/.test(f))) {
      const runner = read('supabase/tests/run_order_0524_operations_handoff_local.sh')
      assert.equal(/--linked|project-ref|supabase db push|\.env/.test(runner), false,
        'the Order 0524 runner must not be able to reach a linked project')
      assert.ok(runner.includes('BOE_DB_CONTAINER'), 'it targets a named local container')
      assert.ok(runner.includes('is not disposable'), 'and refuses a database holding real Orders')
      const assertions = read('supabase/tests/order_0524_operations_handoff_assertions.sql')
      assert.ok(assertions.trimEnd().endsWith('rollback;'), 'its assertions discard every fixture')
    }
    // The operations-handoff files are held to the same rule: a disposable
    // local stack named by the caller, nothing linked, assertions that roll
    // back.
    if (added.some(f => /order_operations_handoff/.test(f))) {
      const ooh = read('supabase/tests/run_order_operations_handoff_local.sh')
      assert.equal(/--linked|project-ref|supabase db push|\.env/.test(ooh), false,
        'the handoff runner must not be able to reach a linked project')
      assert.ok(ooh.includes('BOE_DB_CONTAINER'), 'it targets a named local container')
      assert.ok(ooh.includes('is not disposable'), 'and refuses a database holding real Orders')
      const assertions = read('supabase/tests/order_operations_handoff_assertions.sql')
      assert.ok(assertions.trimEnd().endsWith('rollback;'), 'its assertions discard every fixture')
    }
    // The personal module-order files are held to the SAME rule the expense
    // runner is held to below: a throwaway local database and nothing that can
    // reach a real project. Asserted here rather than taken on trust, because
    // that is the property this whole block exists to protect.
    if (added.some(f => /personal_module_order/.test(f))) {
      const pmo = read('supabase/tests/run_personal_module_order_local.sh')
      assert.equal(/--linked|project-ref|supabase db push/.test(pmo), false,
        'the personal module-order runner must not be able to reach a linked project')
      assert.ok(pmo.includes('BOE_DB_CONTAINER'), 'it targets a named throwaway container')
      assert.ok(pmo.includes('boe-disposable-personal-module-order'),
        'and refuses a database nobody has marked disposable')
      const assertions = read('supabase/tests/personal_module_order_assertions.sql')
      assert.ok(assertions.trimEnd().endsWith('rollback;'),
        'its assertions discard every fixture')
    }
    // AND THE RUNNER CANNOT REACH A REAL PROJECT. It takes a psql host, creates
    // its own database and drops it; nothing in it reads .env, a project ref or
    // a linked connection.
    const runner = read('supabase/tests/run_expense_lifecycle_suite.sh')
    assert.equal(/--linked|project-ref|SUPABASE_|supabase db push/.test(runner), false)
    assert.ok(runner.includes('drop database if exists'))
  })

  test('every EXISTING test this branch edited is a migration inventory', () => {
    const editedTests = [...touched].filter(f =>
      /\.test\.tsx?$/.test(f) &&
      !f.startsWith('src/app/finance/expenses/') &&
      !f.startsWith('src/lib/finance/expense'))
    for (const file of editedTests) {
      assert.ok(ALLOWED_TESTS.has(file) || ALLOWED_PI_PREVIEW_REFINEMENT.has(file)
        || ALLOWED_PI_DRAFT_BUSINESS_RULES.has(file)
        || ALLOWED_PI_FINANCE_VERIFICATION_REMOVAL.has(file)
        || ALLOWED_PI_CONFIRMATION_DIALOG.has(file)
        || ALLOWED_MODULE_CARD_AND_QUOTATION_CREATE.has(file)
        || ALLOWED_PERSONAL_MODULE_ORDER.has(file)
        || ALLOWED_CONFIRMED_ORDER_DETAIL_REDESIGN.has(file)
        || ALLOWED_OPERATIONS_HANDOFF.has(file)
        || ALLOWED_ORDER_0524_HANDOFF.has(file)
        || ALLOWED_OPERATIONS_REVIEW_ON_STRIP.has(file)
        || ALLOWED_PI_FORMAT_DOWNLOAD.has(file)
        || ALLOWED_ACCOUNT_SETTINGS_LAYOUT.has(file)
        || ALLOWED_GUARDS_RUN_AS_OWNER.has(file),
        `${file} was edited and is neither an accounted-for migration inventory `
        + 'nor one of the named PI preview suites')
    }
  })

  test('NO EXISTING FINANCE OR ORDERS SCREEN WAS EDITED', () => {
    const unexpected = [...touched].filter(isUnexpectedFile)
    assert.deepEqual(unexpected, [],
      'every other file in the repository is untouched by this branch')
  })

  test('the payment entry, allocation and balance modules are not among them', () => {
    for (const untouchable of [
      'src/app/finance/page.tsx',
      'src/app/finance/received/ReceivedPaymentsView.tsx',
      'src/lib/finance/paymentEntry.ts',
      'src/lib/finance/paymentAllocations.ts',
      'src/lib/finance/orderFinancePosition.ts',
      'src/lib/finance/exactMoney.ts',
      'src/lib/currency.ts',
      'src/lib/permissions/finance.ts',
      'src/components/layout/ModuleGuard.tsx',
      'src/app/finance/layout.tsx',
    ]) {
      assert.equal(touched.has(untouchable), false, `${untouchable} must not change`)
    }
  })

  test('the Finance permission model gained no action and lost none', () => {
    const perms = read('src/lib/permissions/finance.ts')
    for (const action of ['view', 'view_all', 'create', 'edit', 'approve',
                          'export', 'manage', 'delete', 'allocate', 'allocate_correct']) {
      assert.ok(perms.includes(`'${action}'`), `finance.${action} is still derived`)
    }
    assert.equal(/expense/i.test(perms), false,
      'expenses introduce no Finance capability of their own — they reuse view, create and manage')
  })

  test('the expense tables are referenced by nothing outside the expense feature', () => {
    const offenders = [...touched].filter(f => {
      if (!f.startsWith('src/') || !/\.tsx?$/.test(f)) return false
      if (f.startsWith('src/app/finance/expenses/') || f.startsWith('src/lib/finance/expense')) return false
      if (!existsSync(join(process.cwd(), f))) return false
      return /from\('expenses'\)|from\('expense_categories'\)/.test(read(f))
    })
    assert.deepEqual(offenders, [])
  })
})
