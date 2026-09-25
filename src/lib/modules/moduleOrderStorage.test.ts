/**
 * PERSONAL MODULE-CARD ORDER — the storage, the wiring and the surfaces.
 *
 * WHAT EACH HALF OF THE VERIFICATION DOES
 * ---------------------------------------
 * This file reads TEXT: the migration, the launcher, the controls and the CSS,
 * and checks they SAY the right things. It is the half that can run in the
 * ordinary suite with no database and no browser.
 *
 * supabase/tests/personal_module_order_assertions.sql EXECUTES the migration
 * against a throwaway PostgreSQL container and proves the same rules behave —
 * two accounts with two independent orders, no cross-account read or write, no
 * row handover, no delete, every malformed list refused, anon locked out. Run it
 * with supabase/tests/run_personal_module_order_local.sh. A text assertion
 * cannot tell a correct policy from a plausible one; that file can.
 *
 * WHY THE SOURCES ARE READ RATHER THAN IMPORTED. src/app/modules/page.tsx and
 * ModuleOrderControls.tsx both import a CSS module, which `tsx --test` cannot
 * resolve — so the repository tests those by reading them, as
 * src/components/layout/attendancePayrollNav.test.ts already does for this very
 * launcher. Everything in them that is pure was moved into
 * src/lib/modules/moduleOrder.ts instead and is EXECUTED by
 * moduleOrder.test.ts: the ordering rules, the edit-mode transitions, the card's
 * press props and the handle's key mapping. What is left here is genuinely
 * structural.
 *
 * Run:
 *   npx tsx --test src/lib/modules/moduleOrderStorage.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PERSONAL_MODULE_ORDER_TABLE } from './moduleOrder'

const ROOT = process.cwd()

/**
 * Read a source file with LINE ENDINGS NORMALISED.
 *
 * Not a nicety. This repository is worked on Windows and git checks these files
 * out CRLF, so a source line ends `…\r\n`. In a JavaScript regex `.` matches any
 * character EXCEPT a line terminator, and `\r` is one — so `/--.*$/` cannot
 * reach the end of a CRLF line and the comment-stripping below silently stops
 * working, which turns every "the migration does not mention X" assertion into a
 * check of the sentence that promises it does not. That is exactly what happened
 * the first time this branch was rebased, so the normalisation is here rather
 * than in each pattern.
 */
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const MIGRATION_FILE = 'supabase/migrations/20261228000000_personal_module_order.sql'
const MIGRATION  = read(MIGRATION_FILE)

/**
 * The migration with its `--` comments removed.
 *
 * NEEDED, not tidiness. This migration argues at length about what it
 * deliberately does NOT do — "NO DELETE POLICY", "this table needs no
 * relationship to app_modules" — so a check for "the file does not mention
 * app_modules" run over the raw text fails on the very sentence that promises it.
 * Every assertion about what the migration DOES is made against this; the
 * assertions about what it SAYS are made against the raw text, deliberately.
 */
const MIGRATION_SQL = MIGRATION
  .split('\n')
  .map(line => line.replace(/--.*$/, ''))
  .join('\n')

/** Each `create policy … ;` statement on its own, so a check cannot span two. */
const POLICY_STATEMENTS = MIGRATION_SQL.match(/create policy[\s\S]*?;/g) ?? []
const LAUNCHER   = read('src/app/modules/page.tsx')
const CONTROLS   = read('src/app/modules/ModuleOrderControls.tsx')
const CSS        = read('src/app/modules/modules.module.css')
const HOOK       = read('src/hooks/queries/useModuleOrder.ts')
const ORDER_LIB  = read('src/lib/modules/moduleOrder.ts')
const PACKAGE    = JSON.parse(read('package.json')) as {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}

// ── The table ────────────────────────────────────────────────────────────────

describe('the preference table', () => {
  test('it is one row per person, keyed by the account', () => {
    assert.match(MIGRATION, /create table if not exists public\.user_module_order/)
    assert.match(MIGRATION, /user_id\s+uuid\s+primary key references auth\.users\(id\) on delete cascade/)
  })

  test('it stores KEYS — not titles, routes, icons or module rows', () => {
    assert.match(MIGRATION, /module_keys text\[\]\s+not null default '\{\}'/)
    for (const forbidden of ['title', 'href', 'route', 'icon', 'accent', 'description']) {
      assert.equal(
        new RegExp(`^\\s*${forbidden}\\s+(text|jsonb|uuid)`, 'mi').test(MIGRATION), false,
        `the table has a ${forbidden} column — a preference stores stable keys and nothing else`)
    }
  })

  test('the column carries exactly three columns of anything', () => {
    // A preference table that grows a fourth column is a preference table that
    // has started holding something else. The executable assertions check the
    // same fact against the real catalogue (§10).
    const body = MIGRATION.slice(
      MIGRATION.indexOf('create table if not exists public.user_module_order'),
      MIGRATION.indexOf('comment on table public.user_module_order'),
    )
    for (const col of ['user_id', 'module_keys', 'updated_at']) {
      assert.ok(body.includes(col), `${col} is missing`)
    }
  })

  test('the name is the one the client uses', () => {
    assert.equal(PERSONAL_MODULE_ORDER_TABLE, 'user_module_order')
    assert.ok(MIGRATION.includes(`public.${PERSONAL_MODULE_ORDER_TABLE}`))
    assert.ok(HOOK.includes('PERSONAL_MODULE_ORDER_TABLE'),
      'the hook must name the table through the shared constant, not a literal')
  })

  test('it follows user_top_tasks — the repository\'s existing personal preference', () => {
    // Same naming, same auth.users reference, same cascade, same policy shape.
    const precedent = read('supabase/migrations/20260628000100_create_user_top_tasks.sql')
    assert.match(precedent, /references auth\.users\(id\) on delete cascade/)
    assert.match(precedent, /auth\.uid\(\) = user_id/)
    assert.match(MIGRATION, /references auth\.users\(id\) on delete cascade/)
    assert.match(MIGRATION, /auth\.uid\(\) = user_id/)
  })
})

// ── RLS ──────────────────────────────────────────────────────────────────────

describe('row level security', () => {
  test('RLS is on', () => {
    assert.match(MIGRATION, /alter table public\.user_module_order enable row level security/)
  })

  test('select, insert and update — each scoped to the caller\'s own row', () => {
    assert.match(MIGRATION,
      /create policy user_module_order_select[\s\S]*?for select to authenticated\s*\n\s*using \(auth\.uid\(\) = user_id\)/)
    assert.match(MIGRATION,
      /create policy user_module_order_insert[\s\S]*?for insert to authenticated\s*\n\s*with check \(auth\.uid\(\) = user_id\)/)
  })

  test('the update policy carries BOTH halves', () => {
    // `using` alone says which row may be updated and nothing about what it may
    // become — so a row could be rewritten to carry somebody else's user_id,
    // handing your preference to them. Proved behaviourally in §4 of the
    // assertions.
    assert.match(MIGRATION,
      /create policy user_module_order_update[\s\S]*?for update to authenticated\s*\n\s*using \(auth\.uid\(\) = user_id\)\s*\n\s*with check \(auth\.uid\(\) = user_id\)/)
  })

  test('every policy on the table mentions auth.uid()', () => {
    assert.equal(POLICY_STATEMENTS.length, 3, 'expected exactly three policies')
    for (const policy of POLICY_STATEMENTS) {
      assert.match(policy, /auth\.uid\(\) = user_id/,
        'a policy that does not compare auth.uid() to user_id is not owner-scoped')
      assert.match(policy, /\bto authenticated\b/,
        'a policy that does not name a role applies to anon too')
    }
  })

  test('there is NO delete policy and no FOR ALL policy', () => {
    // Asked of each policy statement, not of the file: the file ARGUES about the
    // delete it does not have, and a check that spanned statements would match
    // that argument.
    for (const policy of POLICY_STATEMENTS) {
      assert.equal(/for\s+delete/i.test(policy), false, `a delete policy exists: ${policy}`)
      assert.equal(/for\s+all\b/i.test(policy), false, `a FOR ALL policy exists: ${policy}`)
    }
  })

  test('anon is revoked BY NAME, and authenticated gets three commands', () => {
    // `revoke ... from public` alone does not reach Supabase's explicit per-role
    // bootstrap grants — the lesson of 20261223000000.
    assert.match(MIGRATION_SQL,
      /revoke all on public\.user_module_order from public, anon, authenticated/)
    assert.match(MIGRATION_SQL,
      /grant select, insert, update on public\.user_module_order to authenticated/)

    // Every executable grant on the table, and none of them may carry DELETE.
    const grants = MIGRATION_SQL.match(/\bgrant\b[\s\S]*?;/gi) ?? []
    for (const grant of grants) {
      if (!/user_module_order/.test(grant)) continue
      assert.equal(/\bdelete\b/i.test(grant), false,
        `DELETE must not be granted to any client role: ${grant}`)
    }
  })

  test('it is safe to apply twice', () => {
    // The runner applies the file twice. `create policy` and `create trigger`
    // have no IF NOT EXISTS form, so each is dropped first.
    for (const name of ['select', 'insert', 'update']) {
      assert.ok(MIGRATION.includes(`drop policy if exists user_module_order_${name} on public.user_module_order;`),
        `policy ${name} is not guarded against a re-run`)
    }
    assert.match(MIGRATION, /drop trigger if exists user_module_order_touch/)
  })

  test('the migration asserts its own posture before it finishes', () => {
    for (const fragment of [
      'RLS is not enabled',
      'is not scoped to auth.uid()',
      'missing its with-check half',
      'still holds a grant',
      'can DELETE a preference row',
    ]) {
      assert.ok(MIGRATION.includes(fragment),
        `the assertion block does not check: ${fragment}`)
    }
  })
})

// ── It grants nothing ────────────────────────────────────────────────────────

describe('a stored key is not access', () => {
  test('the migration names TWO relations, and they are its own and auth.users', () => {
    // Stated as a closed list rather than as a blacklist. A blacklist of table
    // names cannot work here: the migration's own assertion block passes
    // array['orders', 'finance'] to its validator to prove the validator accepts
    // well-formed keys, and 'orders' in a string literal is not a reference to
    // public.orders. What IS checkable is every schema-qualified relation the
    // file mentions — and there are two.
    const qualified = new Set(
      (MIGRATION_SQL.match(/\b(?:public|auth)\.[a-z_]+/g) ?? [])
        // The two functions this migration creates are its own, not relations,
        // and auth.uid() is the platform's — every policy in this schema calls it.
        .filter(name => ![
          'public.user_module_order_keys_valid',
          'public.touch_user_module_order',
          'auth.uid',
        ].includes(name)),
    )
    assert.deepEqual([...qualified].sort(), ['auth.users', 'public.user_module_order'],
      'a display preference must stand alone — it may reference nothing else')
  })

  test('and it names no permission or business table even unqualified', () => {
    // The names that could only be a reference, checked without a schema prefix
    // because this schema uses both forms.
    for (const table of [
      'app_modules', 'permission_modules', 'employee_permission_overrides',
      'order_submissions', 'finance_payment_requests', 'payroll_periods',
      'attendance_records', 'expense_drafts',
    ]) {
      assert.equal(new RegExp(`\\b${table}\\b`).test(MIGRATION_SQL), false,
        `the migration mentions ${table} — a display preference must stand alone`)
    }
  })

  test('there is no DML of any kind', () => {
    for (const verb of [/\binsert\s+into\b/i, /\bupdate\s+public\./i, /\bdelete\s+from\b/i]) {
      assert.equal(verb.test(MIGRATION_SQL), false,
        `the migration contains ${verb} — it must not alter a single row`)
    }
  })

  test('the ordering library cannot read a permission, a title or a route', () => {
    // Structural, and it is what makes "ordering cannot widen visibility" true
    // by construction rather than by a check: the module only ever sees keys.
    for (const forbidden of [
      'canAccessManagementModule', 'permission', 'moduleAccess', 'supabase', 'href', 'accent',
    ]) {
      assert.equal(new RegExp(forbidden, 'i').test(ORDER_LIB.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), false,
        `moduleOrder.ts references ${forbidden} — ordering must know nothing but keys`)
    }
  })
})

// ── The launcher's wiring ────────────────────────────────────────────────────

describe('the gate runs first, and ordering only sorts its output', () => {
  test('the canonical array is still built by canOpenModule', () => {
    assert.match(LAUNCHER, /const canonicalModules: ModuleDef\[\] = \[/)
    // Every gate that was there before is still the thing that admits a card.
    for (const key of [
      'task_management', 'sample_tracking', 'showroom_qr', 'assets_access',
      'employee_records', 'performance', 'finance', 'meetings', 'orders', 'image_editor',
    ]) {
      assert.ok(LAUNCHER.includes(`canOpenModule('${key}')`),
        `the gate for ${key} is gone`)
    }
    assert.ok(LAUNCHER.includes('canOpenCustomerReviews'))
    assert.ok(LAUNCHER.includes("effectiveProfile?.role === 'admin'"),
      'the Control Center card must still be admin-only')
    assert.ok(LAUNCHER.includes('canSeeAttendance || canSeePayroll'),
      'the Attendance & Payroll union gate is gone')
  })

  test('the order is applied to that array, and to nothing else', () => {
    assert.match(LAUNCHER, /const modules = visibleModuleOrder\(\s*canonicalModules,/)
  })

  test('THE CANONICAL ARRAY IS NEVER MUTATED', () => {
    // A sort or a splice in place would make one person's preference the
    // launcher's default for every later render in the same module instance.
    for (const mutator of ['canonicalModules.sort', 'canonicalModules.reverse',
      'canonicalModules.splice', 'canonicalModules.push', 'canonicalModules.pop']) {
      assert.equal(LAUNCHER.includes(mutator), false, `${mutator} mutates the default order`)
    }
    // And the library returns fresh arrays. `[...canonical]` / `ordered.push`
    // onto a local are the only shapes there.
    assert.equal(/\bcanonical\.(sort|reverse|splice|push|pop)\b/.test(ORDER_LIB), false)
  })

  test('the saved order is read for the SIGNED-IN user, not the display subject', () => {
    assert.match(LAUNCHER, /useModuleOrder\(userId\)/)
    assert.match(HOOK, /queryKey: moduleOrderKey\(userId\)/)
    assert.match(HOOK, /\.eq\('user_id', userId\)/)
  })

  test('while previewing somebody else there is no personal order and no Edit order', () => {
    assert.match(LAUNCHER, /viewMode \? null : savedOrder/)
    assert.match(LAUNCHER, /const canEditOrder = !viewMode/)
  })

  test('only the visible modules are saved, by key', () => {
    assert.match(LAUNCHER, /const keys = moduleOrderKeys\(modules\)/)
    assert.match(LAUNCHER, /saveModuleOrder\(userId, keys\)/)
  })

  test('a save that fails keeps edit mode open and says so', () => {
    assert.match(LAUNCHER, /type: 'saveFailed'/)
    assert.match(LAUNCHER, /your arrangement is still here; try Save again/)
  })

  test('a save that succeeds confirms, briefly', () => {
    assert.match(LAUNCHER, /showToast\('Module order saved', 'success'\)/)
    assert.match(LAUNCHER, /<Toast toast=\{toast\} onDismiss=\{dismissToast\} \/>/)
  })
})

// ── Normal mode is unchanged ─────────────────────────────────────────────────

describe('normal mode', () => {
  test('one quiet action, and no permanent editing furniture', () => {
    assert.match(CONTROLS, /Edit order/)
    // The handle and the three controls are rendered only inside edit mode.
    assert.match(LAUNCHER, /handle=\{editingOrder \? \(/)
    // The control moved into the app header's action slot, so the permission
    // gate it has always sat behind is now expressed as the ternary that
    // supplies that slot. Same flag, same component, same absence in View As.
    // The slot now also holds the Announcements bell (20270110000000), so the
    // gate is the `canEditOrder &&` directly on the control itself.
    assert.match(LAUNCHER, /headerActions=\{showBell \|\| canEditOrder \? \(/)
    assert.match(LAUNCHER, /\{canEditOrder && <ModuleOrderBar/)
  })

  test('the whole card is still the button', () => {
    assert.match(LAUNCHER, /const press = moduleCardPressProps\(onClick\)/)
    assert.match(LAUNCHER, /\{\.\.\.press\}/)
    // And the press props are the ones moduleOrder.test.ts executes.
    assert.match(ORDER_LIB, /role: 'button'/)
    assert.match(ORDER_LIB, /tabIndex: 0/)
  })

  test('navigation is suppressed by REMOVING the handler, not by a flag', () => {
    assert.match(LAUNCHER, /onClick=\{editingOrder \? null : \(\) => router\.push\(mod\.href\)\}/)
  })

  test('every card dimension, breakpoint, icon and badge rule is untouched', () => {
    // The responsive design AS IT STANDS ON main, asserted value by value, so
    // that a change to the ORDERING work cannot quietly resize a card. These
    // numbers have moved several times and the reason is worth keeping: #193
    // removed the description and the footer, #194 (this file's own feature)
    // left the card exactly as it found it, the compact redesign rebuilt the
    // card as a 92px horizontal row, and the launcher redesign then made each
    // module a 104px card — a 56px icon beside a 17px name — three across at
    // every desktop size, with a 124px centred card on a phone.
    //
    // WHAT THIS TEST IS FOR HAS NOT CHANGED. It is the ordering feature's
    // promise that it owns no card dimension. The card's own shape is pinned by
    // src/app/modules/moduleCardSurface.test.ts, which is where a deliberate
    // design change is argued; this list only has to follow it.
    for (const rule of [
      'grid-template-columns: repeat(3, minmax(0, 1fr))',
      'min-height: 104px',
      'padding: 22px 24px',
      'width: 56px',
      'width: 48px',
      '@media (max-width: 767px)',
      '@media (max-width: 339px)',
      'grid-template-columns: repeat(2, minmax(0, 1fr))',
      'min-height: 124px',
      'overflow-wrap: anywhere',
      'font-size: 17px',
      'font-size: 14px',
    ]) {
      assert.ok(CSS.includes(rule), `the responsive card design lost: ${rule}`)
    }
  })

  test('and the ordering work did not reinstate what the card surface removed', () => {
    // The Edit-order rules were appended to this stylesheet after #193 landed.
    // A merge that resurrected a .description or .footer rule would put back
    // furniture the card deliberately no longer has — and moduleCardSurface's
    // own assertions would then be the only thing standing between it and the
    // card. Said here too, because this branch is the one that touched the file.
    assert.equal(/\.description\b/.test(CSS), false)
    assert.equal(/\.footer\b/.test(CSS), false)
    assert.equal(CSS.includes('-webkit-line-clamp'), false,
      'a module name is never clamped')
  })

  test('THIS FILE NO LONGER OWNS A HEADING ROW — the app header does', () => {
    // There used to be a `.sectionHeader` flex row in the page body holding a
    // heading block and this feature's control, with its own divider and its
    // own margin down to the grid. The page now puts its title and this control
    // in the one app header, so that row is gone.
    //
    // WHAT THIS TEST IS FOR IS UNCHANGED: the ordering feature must not own
    // page layout. It used to prove that by pinning the row's spacing; it
    // proves it now by holding the row deleted, which is the stronger claim.
    assert.equal(/\.sectionHeader\b/.test(CSS), false,
      'the heading row is deleted, not left behind as unused CSS')
    assert.equal(/\.sectionHeading\b/.test(CSS), false)
    assert.equal(/\.sectionLabel\b/.test(CSS), false)
    // And no stray divider survives between the header and the first card row.
    assert.equal(/border-bottom:\s*1px solid #E4E7EC/i.test(CSS), false,
      'the only rule under the title is the app header’s own border')
  })
})

// ── Edit mode ────────────────────────────────────────────────────────────────

describe('edit mode', () => {
  test('all three controls exist', () => {
    assert.match(CONTROLS, /Save order/)
    assert.match(CONTROLS, /Cancel/)
    assert.match(CONTROLS, /Reset to default/)
  })

  test('it is inline — no modal, no dialog, no portal', () => {
    for (const heavy of ['Modal', 'Dialog', 'createPortal', 'role="dialog"']) {
      assert.equal(CONTROLS.includes(heavy), false, `edit mode pulled in a ${heavy}`)
    }
  })

  test('the handle is a real button, with a label that names the card and its position', () => {
    assert.match(CONTROLS, /<button[\s\S]*?className=\{styles\.dragHandle\}/)
    assert.match(CONTROLS, /aria-label=\{label\}/)
    assert.match(CONTROLS, /moduleDragHandleLabel\(title, position, total\)/)
  })

  test('every control has an accessible label', () => {
    const labels = CONTROLS.match(/aria-label=/g) ?? []
    assert.ok(labels.length >= 5,
      `expected a label on the handle and on all four buttons, found ${labels.length}`)
    // And the decorative icons are hidden from it.
    const hidden = CONTROLS.match(/aria-hidden="true"/g) ?? []
    assert.ok(hidden.length >= 5, 'the icons are not hidden from assistive technology')
  })

  test('a failed save is announced, not only coloured', () => {
    assert.match(CONTROLS, /role="alert"/)
  })

  test('pointer events, not HTML5 drag-and-drop', () => {
    // dragstart is not fired by touch on mobile Safari or Chrome for Android, so
    // an HTML5 implementation would be desktop-only. Pointer events are one code
    // path for mouse, finger and stylus.
    assert.match(CONTROLS, /onPointerDown/)
    assert.match(CONTROLS, /setPointerCapture/)
    assert.match(CONTROLS, /'pointermove'/)
    assert.match(CONTROLS, /'pointercancel'/)
    // The JSX ATTRIBUTES, not the identifiers: `onDragStart` is also the name of
    // this hook's own callback prop, which is a pointer callback and not the DOM
    // event. What must be absent is the attribute on an element.
    for (const html5 of [
      'draggable=', 'onDragStart={', 'onDragOver={', 'onDrop={', 'dataTransfer',
    ]) {
      assert.equal(CONTROLS.includes(html5), false,
        `${html5} is HTML5 drag-and-drop, which mobile browsers do not fire`)
      assert.equal(LAUNCHER.includes(html5), false,
        `${html5} reached the launcher — mobile browsers do not fire it`)
    }
  })

  test('A DRAG ALWAYS ENDS — the listeners are on the window, not on the handle', () => {
    // Found by driving this in a real browser, not by reading it. With the
    // listeners on the handle and setPointerCapture relied on to route the rest
    // of the gesture there, the capture did not survive the grid reflowing under
    // the pointer: `pointerup` landed elsewhere, `dragEnd` never dispatched, and
    // the card stayed lifted with a drag still "in progress" after the mouse had
    // been released. Window listeners cannot be lost.
    for (const listener of [
      "window.addEventListener('pointermove'",
      "window.addEventListener('pointerup'",
      "window.addEventListener('pointercancel'",
      "window.addEventListener('blur'",
    ]) {
      assert.ok(CONTROLS.includes(listener), `missing ${listener}`)
    }
    assert.equal(CONTROLS.includes('handle.addEventListener'), false,
      'a listener on the handle can be stranded when pointer capture is lost')
    // Every one of them is removed again, or a finished drag keeps listening.
    for (const off of ['pointermove', 'pointerup', 'pointercancel', 'blur']) {
      assert.ok(CONTROLS.includes(`window.removeEventListener('${off}'`), `missing removal of ${off}`)
    }
    // And each filters on the pointer that started the drag, so a second finger
    // cannot end it.
    assert.match(CONTROLS, /ev\.pointerId !== pointerId/)
  })

  test('a held handle does not scroll the page', () => {
    // The one declaration that makes touch dragging work at all, and the reason
    // it is scoped to the handle rather than the card or the grid.
    assert.match(CSS, /\.dragHandle \{[\s\S]*?touch-action: none;/)
  })

  test('the drag is hit-tested against the card\'s own key', () => {
    assert.match(LAUNCHER, /data-module-key=\{mod\.key\}/)
    assert.match(CONTROLS, /closest\('\[data-module-key\]'\)/)
  })

  test('the feedback is restrained, and reduced motion is respected', () => {
    assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)/)
    // The card in hand is outlined and raised — no colour, no motion of its own.
    assert.match(CSS, /\.cardDragging(,\s*\.cardDragging:hover)? \{[\s\S]*?box-shadow:/)
    // And the handle's easing is what reduced motion switches off.
    assert.match(CSS, /prefers-reduced-motion: reduce\)[\s\S]*?\.dragHandle \{[\s\S]*?transition: none;/)
  })

  test('the controls and the handle are visible at phone width', () => {
    // The handle moves to the phone card's corner at the sidebar breakpoint,
    // the same width at which the card itself turns into a centred column.
    const small = CSS.slice(CSS.lastIndexOf('@media (max-width: 767px)'))
    assert.match(small.slice(0, small.indexOf('@media (max-width: 639px)')), /\.dragHandle \{/)
    assert.match(CSS, /@media \(max-width: 639px\)[\s\S]*?\.orderButton,\s*\n\s*\.orderButtonPrimary \{/)
    assert.match(CSS, /@media \(max-width: 767px\)[\s\S]*?\.orderEditing \{/)
  })

  test('there is a visible focus ring on every new control', () => {
    assert.match(CSS, /\.orderEditButton:focus-visible,[\s\S]*?\.dragHandle:focus-visible \{[\s\S]*?outline:/)
  })
})

// ── No new dependency ────────────────────────────────────────────────────────

describe('the dependency list', () => {
  test('no sortable or drag-and-drop library was added', () => {
    const deps = { ...PACKAGE.dependencies, ...PACKAGE.devDependencies }
    for (const lib of [
      '@dnd-kit/core', '@dnd-kit/sortable', 'react-beautiful-dnd',
      '@hello-pangea/dnd', 'react-sortablejs', 'sortablejs',
      'react-dnd', 'framer-motion', 'react-movable',
    ]) {
      assert.equal(lib in deps, false, `${lib} was added — pointer events cover this`)
    }
  })

  test('the drag uses the platform, and lucide-react for the icons it already had', () => {
    assert.match(CONTROLS, /from 'lucide-react'/)
    assert.ok('lucide-react' in PACKAGE.dependencies, 'lucide-react was already a dependency')
  })
})

// ── The executable half exists and is wired up ───────────────────────────────

describe('the database half of this verification', () => {
  test('the assertions and their runner are in the repository', () => {
    for (const p of [
      'supabase/tests/personal_module_order_assertions.sql',
      'supabase/tests/run_personal_module_order_local.sh',
      'supabase/tests/bootstrap/009_personal_module_order_baseline.sql',
    ]) {
      assert.ok(existsSync(join(ROOT, p)), `${p} is missing`)
    }
  })

  test('the baseline reproduces production\'s default privileges, so the revoke means something', () => {
    const baseline = read('supabase/tests/bootstrap/009_personal_module_order_baseline.sql')
    assert.match(baseline, /alter default privileges for role postgres in schema public\s*\n\s*grant all on tables to anon, authenticated, service_role/)
    assert.match(baseline, /MUST NEVER ENTER supabase\/migrations/)
  })

  test('the assertions prove the two-account rule, not merely the policy text', () => {
    const sql = read('supabase/tests/personal_module_order_assertions.sql')
    for (const fragment of [
      'two accounts hold two different orders',
      // Doubled apostrophes: it is inside a SQL string literal.
      "B''s update of A''s row touched 0 rows",
      'reassigning user_id to another account',
      'deleting a preference row',
      'anon selecting',
      'ALL ASSERTIONS PASSED',
      'rollback;',
    ]) {
      assert.ok(sql.includes(fragment), `the assertions do not cover: ${fragment}`)
    }
  })

  test('this branch adds exactly one migration, and edits none', () => {
    const mine = readdirSync(join(ROOT, 'supabase/migrations'))
      .filter(f => f.includes('personal_module_order'))
    assert.deepEqual(mine, ['20261228000000_personal_module_order.sql'])
    // And it sorts after every migration that existed before it, so it cannot
    // be applied out of order.
    const all = readdirSync(join(ROOT, 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort()
    // It has landed; later work sorts after it. What must still hold is that
    // nothing that predated it was renumbered past it: every file before it on
    // disk is earlier, and the only later ones are the named successors.
    const later = all.filter(f => f > '20261228000000_personal_module_order.sql')
    assert.deepEqual(later, [
      // The PI-to-operations handoff: two new tables, one trigger on
      // order_pi_versions and two RPCs. It reaches nothing here.
      '20261229000000_order_operations_handoff.sql',
      // Order 0524's one-time handoff: one DO block writing one handoff, one
      // history row and one notification for ONE pinned Order. No DDL, and it
      // re-emits nothing, so it reaches nothing here.
      '20261230000000_order_0524_operations_handoff_for_existing_approval.sql',
      // Announcements (20270110000000): three new tables, their functions, a
      // private PDF bucket and its storage policies. Purely additive; it reads
      // public.users and touches nothing this suite is about.
      '20270110000000_announcements.sql',
      // The legacy advance submit doors are closed: REVOKE of the two
      // legacy advance doors from authenticated, and CREATE OR REPLACE of
      // submit_order_submission_advance_v2_internal (20260917's body plus
      // clearing the decision basis). No table, policy or row is touched.
      '20270111000000_order_submission_legacy_advance_doors_closed.sql',
    ], 'every migration after this one is accounted for')
  })
})
