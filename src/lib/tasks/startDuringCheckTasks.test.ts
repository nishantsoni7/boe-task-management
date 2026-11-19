/**
 * TASK MANAGEMENT STARTS ITS PAGE WHILE THE PERMISSION ANSWER IS ON ITS WAY (2026-11-19, page speed).
 *
 * The behaviour of the guard itself is tested in src/components/layout/moduleGuardStartsEarly.dom.test.tsx. This file
 * pins the wiring, and holds the audit that makes the hidden build safe: while the page is hidden, anything it does
 * on opening beyond READING must wait for useModuleShown(). The scan below fails if an effect in the Task Management
 * tree writes and nobody has said how it waits.
 *
 * Run: npx tsx --test src/lib/tasks/startDuringCheckTasks.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const codeOf = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

function files(dir: string, out: string[] = []): string[] {
  const abs = join(ROOT, dir)
  if (!existsSync(abs)) return out
  if (!statSync(abs).isDirectory()) { out.push(dir); return out }
  for (const name of readdirSync(abs)) {
    const rel = `${dir}/${name}`
    if (statSync(join(ROOT, rel)).isDirectory()) files(rel, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(rel)
  }
  return out
}

describe('the wiring', () => {
  test('only the two Task Management layouts use the guard that starts early; every other module keeps ModuleGuard', () => {
    const layouts = files('src/app').filter(f => f.endsWith('/layout.tsx'))
    const early = layouts.filter(f => read(f).includes('ModuleGuardStartsEarly'))
    assert.deepEqual(early.sort(), ['src/app/dashboard/layout.tsx', 'src/app/tasks/layout.tsx'])
    for (const f of early) {
      assert.ok(read(f).includes('<ModuleGuardStartsEarly moduleKey="task_management">'), `${f} guards Task Management`)
    }
    // A module that has not been audited cannot be moved over by accident: ModuleGuard still guards the rest.
    const classic = layouts.filter(f => /<ModuleGuard[ >]/.test(read(f)))
    assert.ok(classic.length >= 15, `the other modules still use ModuleGuard (${classic.length})`)
  })

  test('ModuleGuard itself is untouched by this: it still builds no page before the answer', () => {
    const guard = read('src/components/layout/ModuleGuard.tsx')
    for (const word of ['inert', 'ModuleShownContext', 'buildHidden', 'startDuringCheck']) {
      assert.equal(guard.includes(word), false, `ModuleGuard must not mention ${word}`)
    }
    assert.ok(guard.includes('if (!allowed) return <LoadingScreen />'))
  })

  test('the early guard asks the SAME question: the display subject and canAccessManagementModule', () => {
    const g = codeOf(read('src/components/layout/ModuleGuardStartsEarly.tsx'))
    assert.ok(g.includes("useDisplaySubject } from '@/hooks/queries/useDisplaySubject'"))
    assert.ok(g.includes('canAccessManagementModule({'))
    assert.ok(g.includes('isModuleActive: true'))
    assert.ok(g.includes('permissions: permissionsByModule.get(moduleKey) ?? []'))
    // The same three redirects, only once the context has answered.
    assert.ok(g.includes('if (!ready) return'))
    assert.ok(g.includes("if (userId === null) { router.replace('/login'); return }"))
    assert.ok(g.includes('if (!allowed) router.replace(deniedRoute)'))
    // Denied or signed out: the spinner, never the page.
    assert.ok(g.includes('if (ready && !allowed) return <LoadingScreen />'))
    // The hidden build waits for the browser, so the server's HTML and the first browser render match.
    assert.ok(g.includes('useSyncExternalStore(subscribeNothing, () => true, () => false)'))
  })
})

describe('what waits until the page is on screen', () => {
  test('the once-per-session "app open" ping', () => {
    const layout = codeOf(read('src/components/layout/DashboardLayout.tsx'))
    assert.ok(layout.includes("import { useModuleShown } from '@/lib/moduleShown'"))
    assert.ok(layout.includes('const shown = useModuleShown()'))
    assert.ok(layout.includes('useRecordAppOpen(!!profile && shown)'))
  })
})

describe('the audit: no effect in the Task Management tree writes without being accounted for', () => {
  // Every effect body in the pages, the shared shell and the Task Management components that does one of these.
  // A read (a query, a select, a read-only rpc) is fine while hidden: it only starts sooner.
  const WRITES = /\.(insert|update|upsert|delete)\(|method:\s*'(POST|PUT|PATCH|DELETE)'|sendBeacon|\.mutate\(|mutateAsync\(|\.rpc\(/
  const SCOPE = [
    'src/app/tasks', 'src/app/dashboard', 'src/components/layout', 'src/components/tasks',
    'src/components/ui/TaskDetailPanel.tsx', 'src/components/notifications', 'src/hooks/useRecordAppOpen.ts',
  ]
  // Each entry says HOW it is safe while the page is hidden. Add one only after reading the effect.
  const ACCOUNTED_FOR: Record<string, string> = {
    'src/hooks/useRecordAppOpen.ts': 'a POST, and DashboardLayout passes enabled = profile && shown, so it waits for the page to be on screen',
  }

  function effectsThatWrite(): string[] {
    const hits = new Set<string>()
    for (const f of SCOPE.flatMap(d => files(d))) {
      const src = read(f)
      const re = /use(?:Layout)?Effect\(\s*\(\)\s*=>\s*\{/g
      while (re.exec(src) !== null) {
        let i = re.lastIndex
        let depth = 1
        while (i < src.length && depth > 0) { const c = src[i]; if (c === '{') depth++; else if (c === '}') depth--; i++ }
        if (WRITES.test(codeOf(src.slice(re.lastIndex, i - 1)))) hits.add(f)
      }
    }
    return [...hits].sort()
  }

  test('every effect that writes is listed, with the reason it is safe', () => {
    const found = effectsThatWrite()
    const unknown = found.filter(f => !(f in ACCOUNTED_FOR))
    assert.deepEqual(unknown, [],
      'an effect in the Task Management tree now writes on mount: while the guard builds the page hidden it would run for '
      + 'somebody the guard turns away. Make it wait for useModuleShown(), then list it in ACCOUNTED_FOR with the reason.')
  })

  test('the list stays honest: every entry still has such an effect', () => {
    const found = new Set(effectsThatWrite())
    for (const f of Object.keys(ACCOUNTED_FOR)) assert.ok(found.has(f), `${f} no longer has a writing effect: remove it from ACCOUNTED_FOR`)
  })
})
