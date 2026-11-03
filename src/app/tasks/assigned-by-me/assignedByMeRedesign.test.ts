/**
 * Assigned By Me redesign (Oct 2026): the owner's decisions, held still.
 *
 * Reads source only. The behaviour behind these lines is run in teamResponse.test.ts,
 * taskListActions.test.ts and the /api/tasks/people route test.
 *
 * Run:
 *   npx tsx --test src/app/tasks/assigned-by-me/assignedByMeRedesign.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')
const codeOf = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const PAGE = codeOf(read('src/app/tasks/assigned-by-me/page.tsx'))
const DETAIL = codeOf(read('src/app/tasks/[id]/page.tsx'))
const ROW = PAGE.slice(PAGE.indexOf('function TaskCard('), PAGE.indexOf('const PRIORITIES_DELEGATE'))

describe('the row', () => {
  test('the description is gone from the list, and is still loaded for Edit and the drawer', () => {
    assert.equal(ROW.includes('task.note'), false)
    assert.ok(read('src/hooks/queries/useAssignedByMe.ts').includes("'note'"))
  })

  test('Created On gave way to Last update', () => {
    assert.equal(PAGE.includes('Created On'), false)
    assert.ok(PAGE.includes('Last update'))
  })

  test('one menu, and every action it replaced is in it', () => {
    for (const text of ['Open full page', 'Edit', 'Cancel task', 'Delete']) assert.ok(ROW.includes(`text: '${text}'`), text)
    assert.equal(ROW.includes('<TaskRowMenu'), true)
  })
})

describe('Approve and Cancel on the row', () => {
  test('each is offered only by its rule, and never under View As', () => {
    assert.ok(PAGE.includes('const actorId = viewAsUserId ? null : (loggedInId ?? null)'))
    assert.ok(PAGE.includes('onApprove={actorId && canApproveTask(task, actorId) ?'))
    assert.ok(PAGE.includes('onCancel={actorId && canCancelFromList(task, actorId) ?'))
  })

  test('the list reads the column the Approve rule needs', () => {
    assert.ok(read('src/hooks/queries/useAssignedByMe.ts').includes("'task_type'"))
  })

  test('both go through the shared helpers, behind their dialogs', () => {
    assert.ok(PAGE.includes('approveTaskFromList(supabase, task, actor)'))
    assert.ok(PAGE.includes('cancelTaskFromList(supabase, task, actor, reason, profile?.full_name)'))
    assert.ok(PAGE.includes('<ApproveTaskDialog'))
    assert.ok(PAGE.includes('<CancelTaskModal'))
  })

  test('a double click cannot send twice', () => {
    assert.ok(PAGE.includes('if (!actorId || rowActionBusyRef.current) return'))
    assert.ok(/finally \{\s*rowActionBusyRef\.current = false/.test(PAGE))
  })

  test('work waiting on the reader comes first', () => {
    assert.ok(PAGE.includes("t.status === 'pending_approval' ? 0 : t.is_urgent ? 1 : 2"))
  })
})

// Nov 2026. Approve and Cancel task were labelled buttons that needed about 250px in a
// 216px column, so on an approval row they grew leftwards over Last update.
describe('the row buttons fit their column', () => {
  const CSS = read('src/app/tasks/assigned-by-me/assignedByMe.module.css')
  // Three 32px squares, two 4px gaps, 8px + 10px of padding.
  const ACTIONS_MIN_PX = 3 * 32 + 2 * 4 + 18

  test('every width leaves the Actions column room for all three', () => {
    const grids = [...CSS.matchAll(/grid-template-columns:\s*([^;]+);/g)].map(m => m[1].trim()).filter(g => g.includes('minmax'))
    assert.ok(grids.length >= 4, 'the full row and each of the three narrower tiers')
    for (const g of grids) {
      const last = g.split(/\s+/).at(-1) ?? ''
      assert.ok(/^\d+px$/.test(last) && parseInt(last, 10) >= ACTIONS_MIN_PX, `${g} ends in ${last}`)
    }
  })

  test('Approve and Cancel are icon buttons: the words are the tooltip and the name', () => {
    assert.ok(ROW.includes('title="Approve"'))
    assert.ok(ROW.includes('title="Cancel task"'))
    assert.ok(ROW.includes('aria-label={`Approve ${task.title}`}'))
    assert.ok(ROW.includes('aria-label={`Cancel ${task.title}`}'))
  })

  test('and they wear the icons Task Detail uses for the same actions', () => {
    for (const icon of ['CircleCheckBig', 'Ban']) {
      assert.ok(DETAIL.includes(`<${icon} `), `Task Detail no longer draws ${icon}`)
      assert.ok(ROW.includes(`<${icon} `), `the row does not draw ${icon}`)
    }
  })

  test('someone with too little history gets no strip, only the line that says so', () => {
    const BAR = codeOf(read('src/components/tasks/TeamResponseBar.tsx'))
    assert.ok(BAR.includes("person.label !== 'too_early' && ("))
  })
})

describe('Team response', () => {
  test('it does not run under View As, where RLS would give it the wrong person', () => {
    assert.ok(PAGE.includes('useTeamResponse(viewAsUserId ? null : loggedInId)'))
    assert.ok(/\{!viewAsUserId && \(\s*<TeamResponseBar/.test(PAGE))
  })

  test('clicking a person uses the page\'s own assignee filter', () => {
    assert.ok(PAGE.includes('onSelect={id => setState({ assignee: id })}'))
  })
})

describe('leaving Task Detail', () => {
  const approve = DETAIL.slice(DETAIL.indexOf('const approveTask = async'), DETAIL.indexOf('const returnTask = async'))
  const cancel = DETAIL.slice(DETAIL.indexOf('const handleCancelTask = async'), DETAIL.indexOf('const addCommentFiles'))

  test('Cancel goes to Assigned By Me, not to the Cancelled page', () => {
    assert.ok(cancel.includes('router.replace(assignedByMeReturnPath(window.location.search))'))
    assert.equal(cancel.includes("'/tasks/cancelled'"), false)
  })

  test('both carry their notice across, because a toast dies with its page', () => {
    assert.ok(approve.includes("flashToast('Task approved and completed.')"))
    assert.ok(cancel.includes("flashToast('Task cancelled.')"))
    assert.equal(/showToast\(/.test(approve), false)
    assert.ok(PAGE.includes('takeFlashToast()'))
  })

  test('a failed approval stays on the task', () => {
    assert.ok(approve.indexOf('if (!ok || !mountedRef.current) return') < approve.indexOf('flashToast('))
  })
})

describe('names', () => {
  for (const rel of [
    'src/app/tasks/assigned-by-me/cancelled/page.tsx',
    'src/app/tasks/cancelled/page.tsx',
    'src/app/tasks/all/page.tsx',
  ]) {
    test(`${rel} names a deactivated person through the shared lookup`, () => {
      const code = codeOf(read(rel))
      assert.ok(code.includes('useAllUserNames()'))
      assert.equal(code.includes("from('users').select('id, full_name')"), false)
    })
  }

  test('the Completed pages share that lookup', () => {
    assert.ok(read('src/hooks/queries/useCompletedTasks.ts').includes('useQuery<Record<string, string>>(allUserNamesQueryOptions())'))
  })

  test('Task Detail can name a deactivated assignee and actor', () => {
    assert.ok(DETAIL.includes("userNames[task.assigned_to ?? ''] ?? 'Unknown'"))
    assert.ok(DETAIL.includes("actorNameOf(entry) ?? 'Someone'"))
  })
})
