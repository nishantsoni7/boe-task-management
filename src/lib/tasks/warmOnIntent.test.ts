import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// GUARD: the app shell and the task lists warm other routes on INTENT, never on
// load, and never for a pointer that merely crosses something.
//
// Measured in the owner's Chrome on 2026-11-11: every page that used the shell
// prefetched the launcher (`/modules`) on mount, so its stylesheet was preloaded
// and never applied (one "preloaded but not used" warning per page opened), and
// opening the drawer on My Tasks had already requested every task page in the
// list (13 tasks, 26+ requests). The Orders / Finance switch did the same from
// the Finance header: its Link prefetched `/orders` on every Finance page, so
// the Orders stylesheet was preloaded and never applied. The Finance and Orders
// side menus did it for every one of their own pages (`/finance/founders` left
// its stylesheet unused on every other Finance page). The For-you column on
// the Modules page (AttentionPanel, PendingApprovals) did it for every card's
// target (2026-11-12: Orders, Control Center, Attendance & Payroll stylesheets
// unused on /modules). See src/app/modules/intentPrefetch.test.ts for the same
// rule on the Modules cards.

const read = (...p: string[]) => readFileSync(path.join(process.cwd(), ...p), 'utf8')

const HOOK = read('src', 'hooks', 'useIntentWarm.ts')
const WARM = read('src', 'hooks', 'useWarmOnRest.ts')
const INTENT_LINK = read('src', 'components', 'ui', 'IntentLink.tsx')
const SHELL = read('src', 'components', 'layout', 'DashboardLayout.tsx')
const SWITCH = read('src', 'components', 'layout', 'ModuleSwitchButton.tsx')
const MENU = read('src', 'components', 'layout', 'ModuleShellControls.tsx')
const FOR_YOU = read('src', 'app', 'modules', 'AttentionPanel.tsx')
const APPROVALS = read('src', 'app', 'modules', 'PendingApprovals.tsx')

describe('useWarmOnRest keeps prefetch off until the person shows intent', () => {
  it('keeps prefetch off until the person shows intent', () => {
    assert.ok(WARM.includes('prefetch: warm ? null : false'))
    assert.ok(WARM.includes('const [warm, setWarm] = useState(false)'))
  })

  it('waits for the pointer to rest, cancels on leave and unmount, and treats focus and touch as deliberate', () => {
    assert.ok(WARM.includes('rest.current = setTimeout(() => setWarm(true), INTENT_DWELL_MS)'))
    assert.ok(WARM.includes('onPointerLeave: () => clearTimeout(rest.current)'))
    assert.ok(WARM.includes('useEffect(() => () => clearTimeout(rest.current), [])'))
    assert.ok(WARM.includes('onFocus: () => setWarm(true)'))
    assert.ok(WARM.includes('onTouchStart: () => setWarm(true)'))
  })
})

describe('the Finance and Orders side menus warm a page only on intent', () => {
  it('applies the hook to the menu items AND to the Home link that appears when the rail opens', () => {
    // The Home link is drawn only once the rail expands on hover; a viewport
    // prefetch fired the moment the pointer touched the rail (measured 2026-11-11).
    assert.ok(MENU.includes("import { useWarmOnRest } from '@/hooks/useWarmOnRest'"))
    assert.equal(MENU.split('{...warmProps}').length - 1, 2)
    assert.equal(MENU.split('const warmProps = useWarmOnRest()').length - 1, 2)
  })
})

describe('the For-you column and the approvals card link on intent only', () => {
  it('IntentLink is a next/link with the hook applied, and the caller wins', () => {
    assert.ok(INTENT_LINK.includes('return <Link {...warm} {...props} />'))
    assert.ok(INTENT_LINK.includes('const warm = useWarmOnRest()'))
  })

  it('both panels use it instead of a default next/link', () => {
    // Every link here points at another module's page. A default Link prefetched
    // them all as soon as the card showed, and each page left its stylesheet
    // unused on /modules.
    for (const src of [FOR_YOU, APPROVALS]) {
      assert.ok(src.includes("import { IntentLink as Link } from '@/components/ui/IntentLink'"))
      assert.equal(src.includes("from 'next/link'"), false)
    }
  })
})

describe('the Orders / Finance switch does not prefetch the other module on every page', () => {
  it('turns viewport prefetch off and warms on intent only', () => {
    assert.ok(SWITCH.includes('prefetch={false}'))
    assert.ok(SWITCH.includes('onPointerEnter={() => warmOnRest(route)}'))
    assert.ok(SWITCH.includes('onPointerLeave={cancel}'))
    assert.ok(SWITCH.includes('onFocus={() => warmNow(route)}'))
    assert.ok(SWITCH.includes('onTouchStart={() => warmNow(route)}'))
  })
})

describe('useIntentWarm', () => {
  it('waits for the pointer to rest before it warms, and cancels on leave and unmount', () => {
    assert.ok(HOOK.includes('timer.current = setTimeout(() => router.prefetch(href), INTENT_DWELL_MS)'))
    assert.ok(HOOK.includes('const cancel = useCallback(() => clearTimeout(timer.current), [])'))
    assert.ok(HOOK.includes('useEffect(() => cancel, [cancel])'))
  })

  it('rests long enough to ignore a crossing pointer, short enough to stay useful', () => {
    const ms = Number(/export const INTENT_DWELL_MS = (\d+)/.exec(HOOK)?.[1])
    assert.ok(ms >= 150 && ms <= 500, `dwell ${ms} ms should be 150-500`)
  })

  it('warms focus and touch at once — they are deliberate', () => {
    assert.ok(HOOK.includes('const warmNow = useCallback((href: string) => router.prefetch(href), [router])'))
  })
})

describe('the module shell does not warm the launcher on load', () => {
  it('has no router.prefetch call of its own', () => {
    const code = SHELL.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n')
    assert.equal(code.includes('router.prefetch('), false)
  })

  it('warms the launcher from the Home button on intent only', () => {
    assert.ok(SHELL.includes("const { warmOnRest, warmNow, cancel: cancelWarm } = useIntentWarm()"))
    assert.ok(SHELL.includes("onPointerEnter={() => warmOnRest('/modules')}"))
    assert.ok(SHELL.includes('onPointerLeave={cancelWarm}'))
    assert.ok(SHELL.includes("onFocus={() => warmNow('/modules')}"))
    assert.ok(SHELL.includes("onTouchStart={() => warmNow('/modules')}"))
  })
})
