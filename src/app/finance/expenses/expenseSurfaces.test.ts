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

// ── The routes ───────────────────────────────────────────────────────────────

describe('the two expense routes exist and sit inside the Finance guard', () => {
  test('the list and the quick-entry route are both present', () => {
    assert.ok(existsSync(join(process.cwd(), 'src/app/finance/expenses/page.tsx')))
    assert.ok(existsSync(join(process.cwd(), 'src/app/finance/expenses/new/page.tsx')))
  })

  test('THE DEDICATED URL IS /finance/expenses/new', () => {
    // The manifest shortcut, the launcher action and the Android home-screen
    // instructions all name this path. It is a promise to somebody's phone.
    assert.ok(code(MODULES).includes("router.push('/finance/expenses/new')"))
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

  test('the quick route opens straight into the form and reads no list', () => {
    const quick = code(QUICK)
    assert.ok(quick.includes('<ExpenseForm'))
    assert.equal(quick.includes("from('expenses')"), false,
      'no expense list is read: the point of this route is that it is instant')
    assert.ok(quick.includes("from('expense_categories')"), 'the picker still needs its categories')
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

  test('it is drawn, and it is a real action rather than a module card', () => {
    assert.ok(modules.includes('Quick Add Expense'))
    assert.ok(modules.includes('Quick actions'))
  })

  test('IT IS GATED ON THE SAME AUTHORITY THE ROUTE AND THE DATABASE USE', () => {
    // deriveFinanceCapabilities is the module's own derivation, and
    // canCreatePaymentRecord is Finance entry AND finance.create — exactly what
    // expenses_create_insert requires in the database.
    assert.ok(modules.includes('deriveFinanceCapabilities('))
    assert.ok(modules.includes('financeCaps.canCreatePaymentRecord'))
    assert.ok(/canQuickAddExpense && \(/.test(modules),
      'the action is not rendered at all when it is not authorized')
  })

  test('it reads the DISPLAY SUBJECT, so View As previews the employee\'s screen', () => {
    assert.ok(/deriveFinanceCapabilities\(\s*subjectRole,\s*subjectPermissions\.get\('finance'\)/.test(modules))
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

  test('IT IS FEATURE-DETECTED, and no paid service is involved', () => {
    assert.ok(form.includes('webkitSpeechRecognition'))
    assert.ok(form.includes('useVoiceSupported'))
    assert.ok(form.includes('{voiceSupported && ('), 'no microphone where it cannot work')
    assert.ok(form.includes('{!voiceSupported && ('), 'and one quiet line where it cannot')
    for (const forbidden = 'fetch(' ; ; ) {
      assert.equal(form.includes(forbidden), false, 'no network call: recognition is the browser\'s')
      break
    }
    assert.equal(/api[Kk]ey|openai|whisper|FAL_KEY/.test(form), false)
  })

  test('NO AUDIO IS RETAINED — the recogniser is aborted on unmount', () => {
    assert.ok(form.includes('recognitionRef.current?.abort()'))
    assert.equal(/MediaRecorder|getUserMedia|new Blob|upload/.test(form), false,
      'nothing here records, stores or uploads audio')
  })

  test('A REFUSED MICROPHONE IS HANDLED, and the form stays fully usable', () => {
    assert.ok(form.includes("e.error === 'not-allowed'"))
    assert.ok(form.includes('VOICE_DENIED_MESSAGE'))
    assert.ok(form.includes('VOICE_UNSUPPORTED_MESSAGE'))
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
    assert.ok(form.includes("recognition.lang = 'en-IN'"))
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

  test('Edit is offered on exactly the rows the database would accept', () => {
    assert.ok(/caps\.canManageFinance \|\| \(userId !== null && row\.created_by === userId\)/.test(view))
  })

  test('PHASE 1 OFFERS NO DELETE ANYWHERE', () => {
    // Finance has no soft-delete pattern to reuse, so removal is omitted rather
    // than built unsafely. Correction is the whole answer.
    for (const file of [VIEW, FORM, QUICK]) {
      assert.equal(/\.delete\(\)/.test(code(file)), false, `${file} must not delete`)
      assert.equal(/>Delete</.test(read(file)), false, `${file} must not offer a Delete control`)
    }
  })
})

// ── Regression: what this work must not have touched ────────────────────────

describe('REGRESSION — the existing Finance and Orders surfaces are unchanged', () => {
  /** The files this branch changed, against the base it started from. */
  const changed = execFileSync('git', ['diff', '--name-only', 'origin/main...HEAD'],
    { cwd: process.cwd(), encoding: 'utf8' })
    .split('\n').map(s => s.trim()).filter(Boolean)
  const staged = execFileSync('git', ['status', '--porcelain'],
    { cwd: process.cwd(), encoding: 'utf8' })
    .split('\n').map(s => s.slice(3).trim()).filter(Boolean)
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

  test('NO PRODUCTION CODE WAS CHANGED EXCEPT THE SIX WIRING POINTS', () => {
    const production = [...touched].filter(f =>
      /\.(ts|tsx|css|json|sql)$/.test(f) && !/\.test\.tsx?$/.test(f))
    const unexpected = production.filter(f =>
      !f.startsWith('src/app/finance/expenses/') &&
      !f.startsWith('src/lib/finance/expense') &&
      !f.startsWith('supabase/migrations/20261220000000') &&
      !f.startsWith('docs/') &&
      !ALLOWED_EXISTING.has(f))
    assert.deepEqual(unexpected, [])
  })

  test('every EXISTING test this branch edited is a migration inventory', () => {
    const editedTests = [...touched].filter(f =>
      /\.test\.tsx?$/.test(f) &&
      !f.startsWith('src/app/finance/expenses/') &&
      !f.startsWith('src/lib/finance/expense'))
    for (const file of editedTests) {
      assert.ok(ALLOWED_TESTS.has(file),
        `${file} was edited and is not an accounted-for migration inventory`)
    }
  })

  test('NO EXISTING FINANCE OR ORDERS SCREEN WAS EDITED', () => {
    const unexpected = [...touched].filter(f =>
      !f.startsWith('src/app/finance/expenses/') &&
      !f.startsWith('src/lib/finance/expense') &&
      !f.startsWith('supabase/migrations/20261220000000') &&
      !f.startsWith('docs/') &&
      !ALLOWED_EXISTING.has(f) &&
      !ALLOWED_TESTS.has(f))
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
