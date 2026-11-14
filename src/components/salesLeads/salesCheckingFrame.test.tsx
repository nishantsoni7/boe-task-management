import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import '@/lib/testing/cssModuleStub'
import { SalesCheckingFrame, checkingTitle } from './SalesCheckingFrame'

// While the permission check runs, a Sales page shows its own frame instead of the full-screen spinner (owner, 2026-11-14): on the
// live board the spinner covered about 0.4 s to 0.95 s of every full load. This is the one place the rule "nothing renders before
// the access decision" is relaxed, so these tests pin how far: a static frame, only while the check runs, only for Sales.

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const guard = read('src/components/layout/ModuleGuard.tsx')
const frame = read('src/components/salesLeads/SalesCheckingFrame.tsx')

describe('the guard', () => {
  test('shows the module\'s checking frame only while the check has not answered, and never the children', () => {
    assert.ok(guard.includes('checking?: React.ReactNode'), 'the frame is an optional prop')
    assert.ok(guard.includes('if (!ready && checking) return <>{checking}</>'), 'only while the context is unresolved')
    assert.ok(guard.indexOf('if (!ready && checking)') < guard.indexOf('if (!allowed) return <LoadingScreen />'), 'before the gate, so a denial still gets the spinner')
    assert.equal((guard.match(/\{children\}/g) ?? []).length, 1, 'children still have a single render site')
    assert.ok(guard.indexOf('return <>{children}</>') > guard.indexOf('if (!allowed) return <LoadingScreen />'), 'and it is past the gate')
  })

  test('only Sales passes a frame; every other guarded module still shows the spinner', () => {
    const layouts: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(join(process.cwd(), dir))) {
        const rel = `${dir}/${name}`
        if (statSync(join(process.cwd(), rel)).isDirectory()) walk(rel)
        else if (name === 'layout.tsx') layouts.push(rel)
      }
    }
    walk('src/app')
    const passing = layouts.filter(f => read(f).includes('checking='))
    assert.deepEqual(passing, ['src/app/sales/layout.tsx'])
    assert.ok(read('src/app/sales/layout.tsx').includes('checking={<SalesCheckingFrame />}'))
  })
})

describe('the frame reads nothing and draws nothing to act on', () => {
  test('no query, request, permission read or notification read', () => {
    for (const banned of ['useQuery', 'useMutation', 'fetch(', 'createClient', 'useSalesAccess', 'useDisplaySubject', 'usePermissionContext', 'useSalesUnread', 'useUnreadNotifications', 'SalesLayout']) {
      assert.ok(!frame.replace(/\/\/.*$/gm, '').includes(banned), `${banned} must not be in the frame`)
    }
  })

  test('it is drawn without a button, a link or a click handler, and hidden from assistive technology except its status', () => {
    const html = renderToStaticMarkup(<SalesCheckingFrame />)
    // (React adds a <link rel="preload"> for the logo image: that is not something a person can press.)
    assert.ok(!/<button|<a[ >]|onclick|role="button"|tabindex/i.test(html))
    assert.ok(html.includes('aria-busy="true"') && html.includes('role="status"'))
    assert.ok(html.includes('<aside class="boe-sidebar" aria-hidden="true">'))
  })

  test('it shows the Sales frame, and none of the items that depend on what a person may do', () => {
    const html = renderToStaticMarkup(<SalesCheckingFrame />)
    assert.ok(html.includes('>Sales<') && html.includes('>My day<') && html.includes('>Lead Board<') && html.includes('>Notifications<'))
    assert.ok(!html.includes('>Team<') && !html.includes('>Lead Master<'), 'Team and Lead Master come from permissions')
  })

  test('the page names itself as the real page does', () => {
    assert.equal(checkingTitle('/sales/board'), 'Lead Board')
    assert.equal(checkingTitle('/sales/my-day'), 'My day')
    assert.equal(checkingTitle('/sales/team'), 'Team')
    assert.equal(checkingTitle('/sales/lead-master'), 'Lead Master')
    assert.equal(checkingTitle('/sales/lead-master/new'), 'Add lead')
    assert.equal(checkingTitle('/sales/board/'), 'Lead Board', 'a trailing slash is the same page')
    assert.equal(checkingTitle('/sales/something-new'), 'Sales', 'a page it does not know is just Sales')
  })

  test('the board gets board-shaped blocks, with the same classes as the real board so nothing jumps', () => {
    assert.ok(frame.includes('b.wrap') && frame.includes('b.cols') && frame.includes('b.col') && frame.includes('b.colList'))
    assert.ok(frame.includes('layout.fill') && frame.includes('layout.fillBody'))
  })
})
