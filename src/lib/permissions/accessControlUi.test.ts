/**
 * The Access Control workspace, as one administrator workflow.
 *
 * Source-shape assertions over the real page, plus behavioural assertions on
 * the shared level model that the page delegates to. They pin the four things
 * finished in Prompt 6 — the module on/off toggle, the combined Attendance &
 * Payroll row, unsaved-change protection, and the system-Admin lockout — and
 * the boundaries V1 must not cross.
 *
 * Repository files only. No DB, no browser.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/accessControlUi.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ACCESS_LEVELS,
  PRESET_LEVELS,
  presetAllowedActions,
  enableModuleEntry,
  detectAccessLevel,
  protectedActionsClearedByPreset,
  isProtectedAction,
  normalizeGrantedActions,
} from './levels'
import { moduleEnforcement } from './enforcement'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const page = read('src/app/admin/control-center/permissions/page.tsx')

const ASSETS = ['view', 'create', 'edit', 'delete', 'manage', 'assign']
const FINANCE = ['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage']
const granted = (m: Record<string, boolean>) => Object.keys(m).filter(k => m[k]).sort()

// ── PART 1: the module on/off toggle ────────────────────────────────────────

describe('module access is one control, not two', () => {
  test('Off maps to No Access', () => {
    assert.deepEqual(granted(presetAllowedActions('no_access', ASSETS)), [])
    assert.ok(page.includes("applyAccessLevel(mod, 'no_access')"))
  })

  test('On grants entry and PRESERVES every child action', () => {
    // Was "On from No Access maps to Viewer", and the page really did apply the
    // Viewer preset — which wrote an explicit deny over every child action the
    // employee held. That erased Aditya's Sample Tracking dispatch, receive and
    // mark_lost in production on 2026-08-15, with no warning, because the
    // destructive-action confirmation only ever ran on the OFF path.
    //
    // The ON path had been unreachable for anyone holding a child action, since
    // a module counted as "on" whenever ANY action was allowed. Once module
    // entry correctly became `view` alone, that same employee rendered as OFF
    // and the path went live.
    assert.ok(
      page.includes('applyDesiredActions(mod, current => enableModuleEntry(actionKeys, current))'),
      'enabling a module must preserve child actions, not apply a preset',
    )
    assert.equal(
      page.includes("applyAccessLevel(mod, 'viewer')"),
      false,
      'the Viewer preset must never be applied by the checkbox again',
    )
    // Behavioural counterpart in levels.test.ts; asserted here too so the two
    // halves of the fix cannot drift apart.
    assert.deepEqual(
      enableModuleEntry(ASSETS, { view: false, manage: true, assign: true }),
      { view: true, create: false, edit: false, delete: false, manage: true, assign: true },
    )
  })

  test('enabling a module needs no confirmation, because it removes nothing', () => {
    const toggle = page.slice(
      page.indexOf('function toggleModuleAccess'),
      page.indexOf('// A plain computation, not useMemo'),
    )
    const onBranch = toggle.slice(toggle.indexOf('// Entry only.'))
    assert.ok(onBranch.includes('applyDesiredActions'))
    assert.equal(onBranch.includes('window.confirm'), false, 'the ON path must not prompt')
    // The OFF path still does.
    assert.ok(toggle.includes('window.confirm(message)'))
    assert.ok(toggle.includes("protectedActionsClearedByPreset('no_access', actionKeys, effective)"))
  })

  test('picking a level explicitly still replaces the whole module state', () => {
    // The distinction the fix turns on: a preset is a complete statement, the
    // checkbox is not. Both still flow through one write path.
    assert.ok(page.includes('function applyAccessLevel'))
    assert.ok(page.includes('applyDesiredActions(mod, () => presetAllowedActions(level, actionKeys))'))
    assert.ok(page.includes('onApplyLevel={level => applyAccessLevel(changeModalModule, level)}'))
    assert.deepEqual(granted(presetAllowedActions('viewer', ASSETS)), ['view'])
  })

  test('the toggle writes the same per-action state the level selector does', () => {
    // Both go through applyDesiredActions; there is no separate visibility field.
    assert.ok(page.includes('function toggleModuleAccess'))
    assert.ok(page.includes('function applyDesiredActions'))
    assert.equal(/setVisible|visibilityBoolean|moduleVisible/.test(page), false)
    assert.equal(
      /visibility_type|allowed_user_ids/.test(page),
      false,
      'the page must not write app_modules visibility',
    )
  })

  test('toggle and level can never diverge — the level is derived from the state', () => {
    // On is defined as "at least view", which is exactly what makes a module
    // accessible, and the level is read back out of the same map.
    //
    // The screen now says that literally. It used to define On as "any action
    // of this module is allowed", which agreed with the sentence above for
    // every PRESET — a preset always includes view when it grants anything —
    // but disagreed for a Custom grant that had lost its view. That gap is what
    // let a module read Hidden and still count as accessible; see
    // moduleParentGate.test.ts.
    for (const level of PRESET_LEVELS) {
      const map = presetAllowedActions(level, ASSETS)
      const accessible = map['view'] === true
      const detected = detectAccessLevel(ASSETS, map)
      assert.equal(
        accessible,
        detected !== 'no_access',
        `${level}: accessible=${accessible} but level=${detected}`,
      )
    }
    assert.ok(page.includes('const accessible = moduleIsAccessible(mod, overrides)'))
    assert.ok(page.includes("const MODULE_ENTRY_ACTION = 'view'"))
  })

  test('turning Off protected Custom access asks first and names what goes', () => {
    const aditya = { view: true, create: true, edit: true, manage: true, assign: true, delete: false }
    assert.deepEqual(
      protectedActionsClearedByPreset('no_access', ASSETS, aditya).sort(),
      ['assign', 'manage'],
    )
    assert.ok(page.includes("protectedActionsClearedByPreset('no_access', actionKeys, effective)"))
    assert.ok(page.includes('will remove:'))
    assert.ok(page.includes('window.confirm(message)'))
    // The pending change is applied only after confirmation.
    assert.ok(page.includes('if (!window.confirm(message)) return'))
  })

  test('the wording is plain', () => {
    assert.ok(page.includes('Module access'))
    assert.ok(page.includes("{accessible ? 'Visible' : 'Hidden'}"))
    assert.equal(page.includes('Module Visibility'), false, 'no second setting by that name')
  })
})

// ── PART 2: Attendance & Payroll ────────────────────────────────────────────

describe('Attendance & Payroll is one self-service row', () => {
  test('the two modules are separated out and rendered once', () => {
    assert.ok(page.includes('const SELF_SERVICE_MODULE_KEYS = [\'attendance\', \'payroll\'] as const'))
    assert.ok(page.includes('selfServiceModules.length > 0 && (\n                  <AttendancePayrollCard'))
    assert.ok(page.includes('editableModules.map(mod =>'))
    assert.ok(page.includes("const COMBINED_ATTENDANCE_PAYROLL_LABEL = 'Attendance & Payroll'"))
  })

  test('it carries no editable management controls', () => {
    const start = page.indexOf('function AttendancePayrollCard')
    const end = page.indexOf('// ── Page ──', start)
    const card = page.slice(start, end > start ? end : undefined)
    assert.equal(card.includes('onToggle'), false)
    assert.equal(card.includes('AccessLevelBadge'), false)
    assert.equal(card.includes('onOpen'), false)
    assert.equal(/Viewer|Contributor|Manager|Custom/.test(card), false)
  })

  test('the self-service wording is present and accurate', () => {
    assert.ok(page.includes('Self-service'))
    assert.ok(page.includes('Employees can view their own attendance and payroll and raise issues.'))
    assert.ok(page.includes('Management access is restricted to system administrators.'))
  })

  test('inert Attendance/Payroll overrides are surfaced, not activated', () => {
    assert.ok(page.includes('Unused permissions on record'))
    assert.ok(page.includes('left exactly as they are'))
  })

  test('the enforcement label does not call them Enforced', () => {
    assert.equal(moduleEnforcement('attendance').state, 'role_only')
    assert.equal(moduleEnforcement('payroll').state, 'role_only')
  })
})

// ── PART 3: unsaved-change protection ───────────────────────────────────────

describe('unsaved changes are protected', () => {
  test('switching employee with pending edits asks first', () => {
    assert.ok(page.includes("const UNSAVED_PROMPT = 'You have unsaved access changes. Leave without saving?'"))
    assert.ok(page.includes('if (dirty && !window.confirm(UNSAVED_PROMPT)) return'))
  })

  test('Stay keeps the employee and the pending changes', () => {
    // The guard returns BEFORE setSelectedEmployeeId / loadTree, so nothing
    // about the current selection or the override map is touched.
    const start = page.indexOf('async function selectEmployee')
    const body = page.slice(start, page.indexOf('async function loadTree', start))
    const guardAt = body.indexOf('window.confirm(UNSAVED_PROMPT)')
    assert.ok(guardAt > -1)
    assert.ok(guardAt < body.indexOf('setSelectedEmployeeId(id)'))
    assert.ok(guardAt < body.indexOf('loadTree(id)'))
  })

  test('discarding sends no request', () => {
    const start = page.indexOf('async function selectEmployee')
    const body = page.slice(start, page.indexOf('async function loadTree', start))
    assert.equal(body.includes('method: \'PUT\''), false)
    assert.equal(body.includes('fetch('), false)
  })

  test('refresh and close are covered, and only while dirty', () => {
    assert.ok(page.includes("window.addEventListener('beforeunload', warn)"))
    assert.ok(page.includes('if (!dirty) return'), 'the listener must not outlive the pending changes')
    assert.ok(page.includes("window.removeEventListener('beforeunload', warn)"))
  })

  test('it uses the browser prompt rather than a bespoke modal', () => {
    assert.equal(/UnsavedChangesModal|LeaveConfirmModal/.test(page), false)
  })

  test('re-selecting the same employee never prompts', () => {
    assert.ok(page.includes('if (id === selectedEmployeeId) return'))
  })
})

// ── PART 4: system Admin protection ─────────────────────────────────────────

describe('a system Administrator cannot be edited here', () => {
  test('it is decided from the SELECTED employee, not the signed-in one', () => {
    assert.ok(page.includes('function isSystemAdmin(tree: EmployeePermissionTree | null)'))
    assert.ok(page.includes("return tree?.employee.role === 'admin'"))
    assert.ok(page.includes('const adminLocked = isSystemAdmin(tree)'))
  })

  test('the explanation is shown', () => {
    assert.ok(page.includes('System Administrator.'))
    assert.ok(page.includes("this person&apos;s system role"))
  })

  test('toggles and level selectors are disabled', () => {
    assert.ok(page.includes('locked={adminLocked}'))
    assert.ok(page.includes('disabled={locked}'))
    assert.ok(page.includes('onOpen={() => { if (!adminLocked) setChangeModalModuleKey(mod.moduleKey) }}'))
  })

  test('no PUT can be issued for a system Admin', () => {
    const start = page.indexOf('async function save()')
    const body = page.slice(start, page.indexOf('// ── Render', start))
    const guardAt = body.indexOf('if (isSystemAdmin(tree)) return')
    assert.ok(guardAt > -1, 'save must refuse a system admin')
    assert.ok(guardAt < body.indexOf('fetch('), 'the refusal must precede the request')
  })

  test('the Control Center itself remains admin-only', () => {
    assert.ok(page.includes("if (p?.role !== 'admin') { router.push('/dashboard'); return }"))
  })
})

// ── PART 7: whole-workflow accuracy ─────────────────────────────────────────

describe('the finished workflow holds its boundaries', () => {
  test('exactly five levels, and none of them is editor or admin', () => {
    assert.deepEqual([...ACCESS_LEVELS], ['no_access', 'viewer', 'contributor', 'manager', 'custom'])
    assert.equal(page.includes("'editor'"), false)
    assert.equal(page.includes("key: 'admin'"), false)
  })

  test('protected actions are reachable only through Custom', () => {
    for (const keys of [ASSETS, FINANCE]) {
      for (const level of PRESET_LEVELS) {
        for (const action of granted(presetAllowedActions(level, keys))) {
          assert.equal(isProtectedAction(action), false, `${level} granted ${action}`)
        }
      }
    }
  })

  test('Custom automatically includes View', () => {
    assert.deepEqual(normalizeGrantedActions(['manage'], FINANCE).sort(), ['manage', 'view'])
    assert.deepEqual(normalizeGrantedActions(['assign'], ASSETS).sort(), ['assign', 'view'])
  })

  test('existing protected grants load as Custom and are not rewritten', () => {
    const dhruvFinance = Object.fromEntries(FINANCE.map(a => [a, true]))
    assert.equal(detectAccessLevel(FINANCE, dhruvFinance), 'custom')
    const aditya = { view: true, create: true, edit: true, manage: true, assign: true, delete: false }
    assert.equal(detectAccessLevel(ASSETS, aditya), 'custom')
    assert.equal(aditya.assign, true, 'detection must not mutate')
  })

  test('Save is disabled when clean and while saving', () => {
    assert.ok(page.includes('disabled={!dirty || saving}'))
  })

  test('a failed save keeps the pending state', () => {
    const start = page.indexOf('async function save()')
    const body = page.slice(start, page.indexOf('// ── Render', start))
    assert.ok(body.includes("setSaveError(json.error ?? 'Save failed'); return"))
    // No reload and no override reset on the failure path.
    const failAt = body.indexOf("setSaveError(json.error ?? 'Save failed')")
    const reloadAt = body.indexOf('await loadTree(selectedEmployeeId)')
    assert.ok(failAt < reloadAt, 'the failure path must return before reloading')
  })

  test('a successful save reloads the effective state', () => {
    assert.ok(page.includes('await loadTree(selectedEmployeeId)'))
  })

  test('loading fails closed', () => {
    assert.ok(page.includes('treeLoading && <LoadingScreen'))
    assert.ok(page.includes('!treeLoading && tree && ('))
  })

  test('no separate Module Visibility workflow remains', () => {
    const layout = read('src/components/layout/ControlCenterLayout.tsx')
    assert.equal(layout.includes('label="Module Visibility"'), false)
  })

  test('no V2 feature was introduced', () => {
    for (const forbidden of [
      'RoleTemplate', 'roleTemplate', 'bulkCopy', 'copyAccessFrom',
      'DepartmentPermission', 'scopeEditor', 'AccessHistory', 'exportPermissions',
    ]) {
      assert.equal(page.includes(forbidden), false, `V1 must not contain ${forbidden}`)
    }
  })
})

// ── PART 6: the employee directory shows everybody ──────────────────────────
//
// THE DEFECT THIS PART EXISTS TO PIN. A real, active Sales account that could
// sign in was absent from Access Control, so nobody could grant it anything.
// The account was fine; the panel was showing the first twenty people by name
// and silently dropping the rest — no counter, no "and 40 more", nothing. An
// administrator scanning for a name late in the alphabet concluded the account
// did not exist.
//
// A directory that hides people is worse than a long one. These assertions are
// about ABSENCE of a cap, which is exactly the kind of thing that gets quietly
// reintroduced by somebody optimising a list render.

describe('the Access Control employee directory', () => {
  const picker = read('src/app/admin/control-center/ModuleMemberPicker.tsx')

  test('the search results are never silently truncated', () => {
    const block = page.slice(page.indexOf('const searchResults = useMemo'))
      .slice(0, page.slice(page.indexOf('const searchResults = useMemo')).indexOf('}, [search, members, depts])'))
    assert.ok(!/\.slice\(0,\s*\d+\)/.test(block),
      'the employee list must not cap itself; the panel scrolls and the search box narrows')
    assert.ok(block.includes('if (!q) return pool'),
      'with no search term the whole directory is returned')
  })

  test('only soft-deleted accounts are excluded', () => {
    const block = page.slice(page.indexOf('const searchResults = useMemo'))
      .slice(0, page.slice(page.indexOf('const searchResults = useMemo')).indexOf('}, [search, members, depts])'))
    assert.ok(block.includes('members.filter(m => !m.is_deleted)'))
    assert.ok(!/is_active/.test(block),
      'an inactive account must stay assignable — hiding it here is how somebody becomes unreachable')
  })

  test('no account is excluded for what its name or email contains', () => {
    // Comments are stripped first — block AND line — because the code
    // legitimately DOCUMENTS that it does not filter on these words, and a
    // search over raw text would fail on the sentence promising the very thing
    // it verifies.
    const codeOnly = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//g, ' ')
        .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

    for (const source of [page, picker, read('src/app/api/admin-members/route.ts')]) {
      assert.ok(!/['"`]%?(test|dummy|sample)%?['"`]/i.test(codeOnly(source)),
        'an account that can authenticate can hold permissions, whatever it is called')
      assert.ok(!/not\.ilike|notIlike/.test(codeOnly(source)))
    }
  })

  test('the directory read itself is admin-gated and unfiltered', () => {
    const route = read('src/app/api/admin-members/route.ts')
    assert.ok(route.includes("callerProfile?.role !== 'admin'"), 'admin only')
    assert.ok(route.includes("'Forbidden'"))
    assert.ok(route.includes(".or('is_deleted.eq.false,is_deleted.is.null')"),
      'soft-deleted accounts are excluded at the source, and nothing else is')
    assert.ok(route.includes('SUPABASE_SERVICE_ROLE_KEY'),
      'the service role is used behind the admin check, so RLS on public.users cannot hide a colleague')
  })

  test('the counter prefetch is bounded, but the LIST is not', () => {
    // One request per employee for a decorative "x of y" would be a burst on a
    // company-wide directory. Bounding the requests is right; bounding what an
    // administrator can see is what caused the defect.
    assert.ok(page.includes('const COUNT_PREFETCH_LIMIT = 20'))
    assert.ok(page.includes('searchResults.slice(0, COUNT_PREFETCH_LIMIT)'))
    assert.ok(page.includes('countPrefetchTargets.filter(m => !requestedCountIds.current.has(m.id))'),
      'the effect drives off the bounded window, not the full list')
    assert.ok(page.includes('}, [countPrefetchTargets, token])'))
  })

  test('the panel says how many people it is showing', () => {
    assert.ok(/results\.length === 1 \? 'employee' : 'employees'/.test(page),
      'so a complete list is visibly complete')
  })

  test('the module member picker states what its cap is holding back', () => {
    // The cap is right there — it is a picker, not a directory — but a silent
    // one leaves a missing colleague indistinguishable from a missing account.
    assert.ok(picker.includes('const hidden = matched.length - matches.length'))
    assert.ok(picker.includes('type to narrow the list'))
    assert.ok(picker.includes('matched.slice(0, MAX_VISIBLE)'),
      'the cap applies to what is drawn, after the full match set is known')
  })

  test('the picker still admits only active, non-deleted people', () => {
    // Custom visibility grants module access, so a deactivated account must not
    // be handed one. This is an eligibility rule, not a display cap.
    const cc = read('src/app/admin/control-center/page.tsx')
    assert.ok(cc.includes('.filter(m => !m.is_deleted && m.is_active)'))
  })
})
