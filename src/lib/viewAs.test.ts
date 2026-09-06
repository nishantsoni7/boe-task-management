/**
 * View As — the identity model, and the display/write split it enforces.
 *
 * THE RULE UNDER TEST:
 *
 *   READ IDENTITY  = the display subject (the viewed employee)
 *   WRITE AUTHORITY = the authenticated actor (the admin), and while previewing
 *                     there are no writes at all.
 *
 * Pure data-in/data-out for the decision functions, plus source assertions for
 * the places that must ask them — the same method as
 * performanceAccessEnforcement.test.ts.
 *
 * Run:
 *   npx tsx --test src/lib/viewAs.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  decideViewAsSubject, isEligibleViewer, isEligibleSubject,
  isPreviewRequest, VIEW_AS_HEADER, PREVIEW_WRITE_REFUSED,
} from './viewAs'
import { derivePerformanceCapabilities } from './permissions/performance'
import { canAccessManagementModule } from './permissions/moduleVisibility'
import type { EffectivePermission } from './permissions/types'

const read = (path: string) => readFileSync(path, 'utf8')

const ADMIN    = { id: 'admin-1', role: 'admin',   is_active: true, is_deleted: false }
const MANAGER  = { id: 'dhruv',   role: 'manager', is_active: true, is_deleted: false }
const EMPLOYEE = { id: 'shravi',  role: 'member',  is_active: true, is_deleted: false }

const headers = (value?: string) => ({
  get: (name: string) => (name === VIEW_AS_HEADER && value !== undefined ? value : null),
})

// ─── 1. Who may preview whom ─────────────────────────────────────────────────

describe('may this caller preview this employee', () => {
  test('an unauthenticated caller previews nobody', () => {
    const d = decideViewAsSubject({ requestedSubjectId: 'dhruv', actor: null })
    assert.deepEqual(d, { allowed: false, status: 401, reason: 'Unauthorized' })
  })

  test('an admin may preview another employee', () => {
    const d = decideViewAsSubject({ requestedSubjectId: MANAGER.id, actor: ADMIN })
    assert.deepEqual(d, { allowed: true, subjectId: MANAGER.id, isPreview: true })
  })

  test('a NON-admin may not preview anybody, whatever they ask for', () => {
    for (const actor of [MANAGER, EMPLOYEE]) {
      const d = decideViewAsSubject({ requestedSubjectId: 'someone-else', actor })
      assert.equal(d.allowed, false)
      assert.equal(d.allowed === false && d.status, 403)
    }
  })

  test('a deactivated or deleted admin may not preview', () => {
    // Deactivating an account does not end its Supabase session, so role alone
    // is not enough — the same rule the Control Center permission route applies.
    for (const actor of [
      { ...ADMIN, is_active: false },
      { ...ADMIN, is_deleted: true },
    ]) {
      const d = decideViewAsSubject({ requestedSubjectId: MANAGER.id, actor })
      assert.equal(d.allowed, false)
      assert.equal(isEligibleViewer(actor), false)
    }
  })

  test('asking for nobody, or for yourself, is not a preview', () => {
    for (const requested of [null, undefined, '', EMPLOYEE.id]) {
      const d = decideViewAsSubject({ requestedSubjectId: requested, actor: EMPLOYEE })
      assert.deepEqual(d, { allowed: true, subjectId: EMPLOYEE.id, isPreview: false })
    }
  })

  test('the resolved subject is never the id the client sent, unless allowed', () => {
    // The decision returns the id to scope by, so a caller cannot smuggle one
    // past: a refusal carries no subjectId at all.
    const refused = decideViewAsSubject({ requestedSubjectId: 'victim', actor: EMPLOYEE })
    assert.equal('subjectId' in refused, false)
  })

  test('an inactive or deleted employee cannot be previewed', () => {
    assert.equal(isEligibleSubject({ is_active: true, is_deleted: false }), true)
    assert.equal(isEligibleSubject({ is_active: false, is_deleted: false }), false)
    assert.equal(isEligibleSubject({ is_active: true, is_deleted: true }), false)
    assert.equal(isEligibleSubject(null), false)
  })
})

// ─── 2. The preview header only ever removes authority ───────────────────────

describe('the preview header', () => {
  test('is recognised when present and truthy', () => {
    for (const v of ['1', 'true', 'yes']) assert.equal(isPreviewRequest(headers(v)), true)
  })

  test('absent, blank or "false" is not a preview', () => {
    for (const v of [undefined, '', '   ', 'false']) {
      assert.equal(isPreviewRequest(headers(v)), false)
    }
  })

  test('it can only refuse — it never names a user', () => {
    // The header carries no identity. A client that lies by sending it gets less
    // authority, never more; a client that omits it gets exactly what it already
    // had as itself. That is what makes trusting it safe.
    const source = read('src/lib/viewAs.ts')
    assert.match(source, /only ever REFUSE a write/)
    assert.ok(!/userId|user_id/.test(PREVIEW_WRITE_REFUSED))
  })
})

// ─── 3. Display resolves from the SUBJECT ────────────────────────────────────

const perms = (allowed: string[], keys: string[]): EffectivePermission[] =>
  keys.map(actionKey => ({
    actionKey, allowed: allowed.includes(actionKey), source: 'employee_override' as const,
  }))

describe('what the preview renders is the employee, not the admin', () => {
  const FINANCE = ['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage', 'view_all']

  test("an admin's Finance does not appear on an employee who lacks it", () => {
    // The launcher and ModuleGuard both call canAccessManagementModule with the
    // SUBJECT's role and permissions, so previewing an employee with no Finance
    // hides Finance — even though the person doing the previewing is an admin.
    assert.equal(canAccessManagementModule({
      role: 'admin', moduleKey: 'finance', isModuleActive: true, permissions: [],
    }), true, 'the admin has it in their own session')

    assert.equal(canAccessManagementModule({
      role: 'member', moduleKey: 'finance', isModuleActive: true,
      permissions: perms([], FINANCE),
    }), false, 'and it must vanish inside the preview')
  })

  test('a module the employee DOES have still appears', () => {
    assert.equal(canAccessManagementModule({
      role: 'member', moduleKey: 'finance', isModuleActive: true,
      permissions: perms(['view'], FINANCE),
    }), true)
  })

  test('previewing Dhruv reproduces Personal AND Team Performance', () => {
    const PERFORMANCE = ['view', 'create', 'edit', 'export', 'manage', 'view_team', 'view_all']
    const caps = derivePerformanceCapabilities('manager',
      perms(['view', 'view_team', 'view_all'], PERFORMANCE))
    assert.equal(caps.canAccessPersonalPerformance, true)
    assert.equal(caps.canAccessTeamPerformance, true)
    assert.equal(caps.canViewAllEmployeePerformance, true)
  })

  test('previewing an employee without Team Performance hides it', () => {
    const PERFORMANCE = ['view', 'create', 'edit', 'export', 'manage', 'view_team', 'view_all']
    const caps = derivePerformanceCapabilities('member', perms(['view'], PERFORMANCE))
    assert.equal(caps.canAccessPersonalPerformance, true)
    assert.equal(caps.canAccessTeamPerformance, false, 'the admin’s own view_team must not leak in')
    assert.equal(caps.canViewAllEmployeePerformance, false)
  })

  test('an unresolved subject renders NOTHING rather than the admin', () => {
    // useDisplaySubject fails closed while previewing: a null role and an empty
    // permission map, which every display helper reads as "no modules". Falling
    // back to the actor would put the ADMIN's cards under the employee's name,
    // which is the leak this whole change closes.
    const hook = read('src/hooks/queries/useDisplaySubject.ts')
    assert.match(hook, /FAIL CLOSED WHILE PREVIEWING/)
    assert.equal(canAccessManagementModule({
      role: null, moduleKey: 'finance', isModuleActive: true, permissions: [],
    }), false)
  })
})

// ─── 4. The surfaces actually ask the subject ────────────────────────────────

describe('every display surface reads the subject', () => {
  const SURFACES: [string, string][] = [
    ['the launcher',            'src/app/modules/page.tsx'],
    ['the module route guard',  'src/components/layout/ModuleGuard.tsx'],
    ['the Team Performance guard', 'src/app/performance/team/layout.tsx'],
    ['the sidebar',             'src/components/layout/DashboardLayout.tsx'],
    ['the personal Performance page', 'src/app/performance/page.tsx'],
    ['the unread badge',        'src/hooks/queries/useUnreadNotifications.ts'],
    ['the notification list',   'src/hooks/queries/useNotifications.ts'],
  ]

  for (const [name, path] of SURFACES) {
    test(`${name} resolves through useDisplaySubject`, () => {
      assert.ok(read(path).includes('useDisplaySubject'), `${name} still renders the actor's screen`)
    })
  }

  test('no display surface resolves another user’s permissions in the browser', () => {
    // getEffectivePermissions(<arbitrary id>) from client code puts "may this
    // person preview that person" in the browser. The subject now comes from
    // /api/view-as/subject, which decides from the session.
    // Comments are stripped first: this file explains the removed call by name,
    // and an assertion that cannot tell code from prose would fail on its own
    // documentation.
    const code = (path: string) => read(path).replace(/\/\/[^\n]*/g, '')
    for (const path of [
      'src/components/layout/DashboardLayout.tsx',
      'src/app/modules/page.tsx',
      'src/components/layout/ModuleGuard.tsx',
    ]) {
      assert.ok(!code(path).includes('getEffectivePermissions('),
        `${path} must not resolve an arbitrary user’s permissions client-side`)
    }
  })

  test('the subject route validates the caller, not the query string', () => {
    const route = read('src/app/api/view-as/subject/route.ts')
    assert.ok(route.includes('resolveViewAsSubject'), 'the route does not gate the preview')
    assert.ok(route.includes('auth.getUser()'), 'the caller must come from the session')
    // Read-only: there is no write verb in the file.
    for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.ok(!new RegExp(`export async function ${verb}`).test(route),
        `the preview route must not expose ${verb}`)
    }
  })
})

// ─── 5. Mutation safety ──────────────────────────────────────────────────────

describe('nothing mutates while previewing', () => {
  test('the notification hook returns no-ops', () => {
    const hook = read('src/hooks/queries/useNotificationMutations.ts')
    assert.match(hook, /if \(readOnly\) return \{ \.\.\.NO_MUTATIONS, error, clearError \}/)
    // Opening a notification must not mark it read — so markRead is among them.
    assert.match(hook, /markRead: \(\) => \{\}/)
    assert.match(hook, /markAllRead: \(\) => \{\}/)
    assert.match(hook, /deleteAll: \(\) => \{\}/)
    assert.match(hook, /deleteSelected: \(\) => \{\}/)
  })

  test('all four notification write routes refuse a preview server-side', () => {
    const ROUTES = [
      'src/app/api/notifications/route.ts',
      'src/app/api/notifications/mark-read/route.ts',
      'src/app/api/notifications/delete-selected/route.ts',
      'src/app/api/notifications/[id]/route.ts',
    ]
    for (const path of ROUTES) {
      const source = read(path)
      assert.match(source, /if \(isPreviewRequest\(req\.headers\)\) \{\s*\n\s*return NextResponse\.json\(\{ error: PREVIEW_WRITE_REFUSED \}, \{ status: 403 \}\)/,
        `${path} does not refuse a preview write`)
    }
  })

  test('the EOD form renders but cannot submit', () => {
    // "Same interface, no writes" — the control stays visible so an admin can
    // check the employee's screen; only the write is removed.
    const page = read('src/app/performance/page.tsx')
    assert.match(page, /if \(readOnly\) return\r?\n\s*if \(!summary\.trim\(\)\) return/)
    assert.match(page, /disabled=\{readOnly \|\| isSaving \|\| !summary\.trim\(\)\}/)
    assert.ok(page.includes('readOnly={readOnly}'), 'the form is not told it is read-only')
    // And it is NOT hidden — the old code removed it entirely in View As.
    assert.ok(!page.includes('!viewAsUserId && capabilities.canSubmitOwnEod'),
      'the EOD form must render inside a preview, not disappear from it')
  })

  test('the mutation transport carries the refusal header', () => {
    const lib = read('src/lib/notificationMutations.ts')
    assert.ok(lib.includes('VIEW_AS_HEADER'), 'requests do not declare themselves previews')
  })

  test('no endpoint takes an actor id from the client', () => {
    // Audit integrity: a preview can never produce "Dhruv marked this read",
    // because the actor is always the token's own user.
    for (const path of [
      'src/app/api/notifications/mark-read/route.ts',
      'src/app/api/notifications/delete-selected/route.ts',
      'src/app/api/daily-log/route.ts',
    ]) {
      const source = read(path)
      assert.ok(!/user_id:\s*(body|payload)\./.test(source),
        `${path} accepts an actor id from the request body`)
    }
  })
})

// ─── 6. Persistence and the banner ───────────────────────────────────────────

describe('the preview survives navigation', () => {
  test('the selection is stored outside the route, so a route change cannot clear it', () => {
    const ctx = read('src/contexts/ViewAsContext.tsx')
    assert.ok(ctx.includes('localStorage'), 'the selection must outlive a navigation')
    assert.ok(ctx.includes('exitViewMode'), 'there must be an explicit way out')
  })

  test('the banner is the deliberate difference, and says READ ONLY', () => {
    const controls = read('src/components/layout/AdminViewModeControls.tsx')
    assert.ok(controls.includes('READ ONLY'))
    assert.match(controls, /Viewing as/)
    assert.ok(controls.includes('Exit View Mode'))
  })

  test('the personal Performance page no longer ejects a previewing caller', () => {
    const page = read('src/app/performance/page.tsx')
    assert.ok(!page.includes("router.push('/dashboard')"),
      'a preview must continue on the page, not bounce to the dashboard')
  })
})
