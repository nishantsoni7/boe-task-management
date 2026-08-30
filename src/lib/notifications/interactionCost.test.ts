/**
 * WHAT MAKES A NOTIFICATION CLICK CHEAP, ASSERTED IN THE SOURCE.
 *
 * The measured defect, on a 20-card page with identical data either side:
 *
 *   group "Mark all read"   BEFORE 121 mutations in the synchronous render
 *                                  burst (242 total, two waves of 121)
 *                           AFTER    6 mutations in the burst (17 total)
 *   expand / collapse       BEFORE   8 mutations   AFTER 8 — untouched
 *
 * Three things caused it, and a regression in any one of them brings it back,
 * silently and without failing any behavioural test. So they are pinned here.
 *
 *   1. the card was not memoized
 *   2. its handlers were recreated on every parent render, which would have
 *      defeated the memo anyway
 *   3. `busy` was ONE page-wide boolean, so clicking any card changed a prop on
 *      every card
 *
 * Run:
 *   npx tsx --test src/lib/notifications/interactionCost.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const VIEW  = read('src/components/notifications/NotificationsView.tsx')
const CARD  = read('src/components/notifications/NotificationTaskGroup.tsx')
const HOOK  = read('src/hooks/queries/useNotificationMutations.ts')
const MUTS  = read('src/lib/notificationMutations.ts')

describe('1. the card is memoized, by content', () => {
  test('it is exported through memo()', () => {
    assert.match(CARD, /export const NotificationTaskGroup = memo\(/)
  })

  test('with a comparator, not the default shallow one', () => {
    // Every group object is new whenever any row changes, so a shallow compare
    // would never skip anything. The comparator must consult content.
    assert.match(CARD, /sameGroupContent\(prev\.group, next\.group\)/)
    assert.match(CARD, /sameSetMembership\(next\.group, prev\.selected, next\.selected\)/)
    assert.match(CARD, /sameSetMembership\(next\.group, prev\.pendingDeletes, next\.pendingDeletes\)/)
  })

  test('and it still re-renders when a handler identity changes', () => {
    for (const h of ['onToggleSelect', 'onMarkGroupRead', 'onDeleteGroup', 'onDeleteOne', 'onRowClick']) {
      assert.match(CARD, new RegExp(`prev\\.${h} !== next\\.${h}`), `${h} must be compared`)
    }
  })
})

describe('2. the handlers passed to every card are stable', () => {
  for (const fn of ['handleDeleteSingle', 'handleMarkGroupRead', 'toggleSelect', 'handleRowClick']) {
    test(`${fn} is useCallback`, () => {
      assert.match(VIEW, new RegExp(`const ${fn} = useCallback\\(`), `${fn} must not be recreated per render`)
    })
  }

  test('useCallback is actually imported', () => {
    assert.match(VIEW, /import \{ useCallback,/)
  })
})

describe('3. busy is per-card, not per-page', () => {
  test('the hook reports WHICH group is in flight', () => {
    assert.match(HOOK, /busyTaskId: string \| null/)
    assert.match(HOOK, /markTaskGroupMutation\.variables/)
    assert.match(HOOK, /deleteTaskGroupMutation\.variables/)
  })

  test('the list disables one card, not all of them', () => {
    assert.match(VIEW, /busy=\{busyTaskId === item\.taskId/)
    // The page-wide flags remain for the operations that really are page-wide.
    assert.match(VIEW, /markingAll \|\| deletingBulk \|\| deletingAll/)
  })

  test('one-group-action-at-a-time is still enforced, in the handlers', () => {
    // The guard that prevents a second concurrent group action is unchanged;
    // only the DISABLED STYLING became per-card.
    assert.match(HOOK, /if \(!taskId \|\| markTaskGroupMutation\.isPending\) return/)
    assert.match(HOOK, /if \(!taskId \|\| deleteTaskGroupMutation\.isPending\) return/)
    assert.match(VIEW, /groupBusy/)
  })
})

describe('expand / collapse stays local, and fetches nothing', () => {
  test('the open state lives in the card', () => {
    assert.match(CARD, /const \[open, setOpen\] = useState\(false\)/)
  })

  test('the card never invalidates, refetches or fetches', () => {
    // Opening a card is a disclosure, not a data change. It must not reach the
    // network or the query cache at all.
    assert.equal(/invalidateQueries/.test(CARD), false, 'the card must not invalidate queries')
    assert.equal(/refetch\(/.test(CARD), false, 'the card must not refetch')
    assert.equal(/\bfetch\(/.test(CARD), false, 'the card must not fetch')
    assert.equal(/useQuery\(/.test(CARD), false, 'the card must not own a query')
  })
})

describe('mark-read and delete paint before the network answers', () => {
  test('every mutation writes the cache in onMutate', () => {
    // onMutate runs synchronously before the request — that is what makes the
    // click feel instant. onSuccess only reconciles.
    const onMutates = MUTS.match(/onMutate:/g) ?? []
    assert.ok(onMutates.length >= 6, `expected every mutation to be optimistic, found ${onMutates.length}`)
    assert.match(MUTS, /setQueryData<Notification\[\]>/)
  })

  test('and cancels in-flight refetches first, so a slower GET cannot undo it', () => {
    assert.match(MUTS, /cancelQueries/)
  })

  test('a failure rolls the optimistic write back', () => {
    assert.match(MUTS, /onError/)
  })

  test('the single-delete guard is synchronous, so a double-click sends one DELETE', () => {
    assert.match(HOOK, /if \(!guard\.tryAcquire\(id\)\) return/)
  })
})

describe('nothing about grouping or counting moved', () => {
  test('the arrangement is still one memoized derivation from the row list', () => {
    assert.match(VIEW, /const items\s+= useMemo\(\(\) => groupNotificationsByTask\(rows\), \[rows\]\)/)
    assert.match(VIEW, /const visible = useMemo\(\(\) => filterDisplayItems\(items, filter\), \[items, filter\]\)/)
  })

  test('the unread number is still counted in events by the shared summariser', () => {
    assert.match(VIEW, /summarizeDisplayItems\(items\)/)
    assert.match(VIEW, /const unreadCount = summary\.unreadEvents/)
  })

  test('the card does not compute its own counts', () => {
    // Call form, not the bare name: the memo's comment cites
    // groupNotificationsByTask as the reason the comparator has to be
    // content-based, and naming it in prose is not calling it.
    assert.equal(/summarizeDisplayItems\(/.test(CARD), false)
    assert.equal(/groupNotificationsByTask\(/.test(CARD), false)
  })
})
