import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// GUARD: the Notifications page warms a task's page on INTENT (pointer over,
// focus, touch start) and never on load.
//
// Warming a route brings its stylesheet. Doing it for the first twelve tasks on
// load made Chrome preload the Task page's CSS, which Notifications never
// applies ("preloaded using link preload but not used within a few seconds"),
// and the extra requests competed with the notification list itself.

const read = (...p: string[]) => readFileSync(path.join(process.cwd(), ...p), 'utf8')
const code = (s: string) =>
  s.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n')
const linesWith = (s: string, needle: string) =>
  s.split('\n').filter(l => l.includes(needle))

const VIEW  = code(read('src', 'components', 'notifications', 'NotificationsView.tsx'))
const GROUP = code(read('src', 'components', 'notifications', 'NotificationTaskGroup.tsx'))

describe('Notifications warms task pages on intent only', () => {
  it('the list view prefetches only inside the intent helper, never in an effect', () => {
    const calls = linesWith(VIEW, 'prefetch(')
    assert.equal(calls.length, 1)
    assert.ok(/const warmTask = useCallback/.test(calls[0]))
  })

  it('the task title link opts out of viewport prefetch', () => {
    assert.ok(GROUP.includes('prefetch={false}'))
  })

  it('the task title link warms the task on pointer, focus and touch', () => {
    assert.ok(GROUP.includes('onPointerEnter={warm}'))
    assert.ok(GROUP.includes('onFocus={warm}'))
    assert.ok(GROUP.includes('onTouchStart={warm}'))
  })

  it('the card owns no router: the page hands it the intent callback', () => {
    assert.equal(GROUP.includes('prefetch('), false)
    assert.ok(VIEW.includes('onWarmTask={warmTask}'))
  })
})
