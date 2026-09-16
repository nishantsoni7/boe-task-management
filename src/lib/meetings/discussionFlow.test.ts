/**
 * The order-discussion flow, read from its source.
 *
 * These pin promises that live in the ORDER of calls or in the SHAPE of a screen
 * rather than in any one function — the kind a harmless-looking refactor can break
 * while every screen still renders:
 *
 *   1. SOURCE-TASK ISOLATION. A meeting viewer must never reach a task they could
 *      not otherwise read. That holds because task rows are read with the VIEWER'S
 *      OWN client, and a link is drawn only for a row that came back. There is no
 *      other mechanism, so a change that trusted an id instead would be silent.
 *
 *   2. THE BOARD WRITES NOTHING, and the workspace writes only to THIS meeting.
 *      An earlier meeting is read-only, and nothing on the screen can reach one.
 *
 *   3. VIEWER VERSUS EDITOR. The composer, the evidence upload, Resolve and Reopen
 *      are all behind the same capability the database enforces, and a completed
 *      meeting is read-only in the browser as well.
 *
 *   4. EVIDENCE ORDER. An image is recorded only AFTER its upload succeeded, and a
 *      failed recording removes the stray object — so no row ever points at
 *      nothing and nothing stored is shown as evidence.
 *
 *   5. SCOPE. Task Detail gained ONE action and ONE dialog, and nothing else in
 *      the Task module changed.
 *
 * Run:
 *   npx tsx --test src/lib/meetings/discussionFlow.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  canEditThisMeeting, canReopenDiscussionItem, deriveMeetingsCapabilities,
  NO_MEETINGS_CAPABILITIES,
} from '@/lib/permissions/meetings'
import type { Meeting } from '@/lib/meetings/types'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const SCREEN    = read('src/app/meetings/[id]/MeetingWorkScreen.tsx')
const BOARD     = read('src/components/meetings/DiscussionBoard.tsx')
const WORKSPACE = read('src/components/meetings/DiscussionWorkspace.tsx')
const MODALS    = read('src/components/meetings/DiscussionModals.tsx')
const READS     = read('src/lib/meetings/discussionReads.ts')
const INBOX     = read('src/app/meetings/inbox/MeetingInboxScreen.tsx')
const CAPTURE   = read('src/components/tasks/AddToMeetingModal.tsx')
const TASK_PAGE = read('src/app/tasks/[id]/page.tsx')

// ─── 1. Source-task isolation ────────────────────────────────────────────────

describe('a meeting viewer cannot reach a task they may not read', () => {
  test('task rows are read with the viewer’s own client, in one query', () => {
    // Not a service-role route and not a definer function: the tasks SELECT policy
    // is what decides, and it decides for THIS user.
    assert.match(SCREEN, /\.from\('tasks'\)\s*\n\s*\.select\([\s\S]{0,140}\)\s*\n\s*\.in\('id', \[\.\.\.taskIds\]\)/)
    assert.equal((SCREEN.match(/\.from\('tasks'\)/g) ?? []).length, 1,
      'one read, so every task link on the screen is decided the same way')
  })

  test('the set read includes the source task and every linked follow-up task', () => {
    assert.match(SCREEN, /if \(issue\.source_task_id\) taskIds\.add\(issue\.source_task_id\)/)
    assert.match(SCREEN, /event\.event_type === 'task_linked' && event\.task_id\) taskIds\.add\(event\.task_id\)/)
  })

  test('the workspace draws a source-task link only for a task that came back', () => {
    assert.match(SCREEN, /sourceTask=\{selectedRow\.item\.source_task_id\s*\n?\s*\? \(tasks\[selectedRow\.item\.source_task_id\] \?\? null\)/)
    assert.match(WORKSPACE, /sourceTaskId && \(sourceTask \?/)
    // …and says so plainly when it did not, rather than hiding that an issue came
    // from somewhere.
    assert.match(WORKSPACE, /Raised from a task you do not have access to/)
  })

  test('a linked task with no readable row is counted but never linked', () => {
    assert.match(WORKSPACE, /const task = readableTasks\[id\]\s*\n\s*if \(!task\) return null/)
    assert.match(WORKSPACE, /taskIds\.filter\(id => !readableTasks\[id\]\)\.length/)
  })

  test('the Inbox applies the same rule to its source-task button', () => {
    assert.match(INBOX, /\.from\('tasks'\)\.select\('id'\)\.in\('id', taskIds\)/)
    assert.match(INBOX, /item\.source_task_id && readableTasks\.has\(item\.source_task_id\)/)
  })

  test('nothing stores or renders a task TITLE on a discussion item', () => {
    // An issue carries only the line the capturing user chose to write, so an
    // agenda row cannot disclose the contents of a task its reader may not open.
    for (const [name, source] of [['reads', READS], ['board', BOARD], ['modals', MODALS]] as const) {
      assert.ok(!/source_task_title|task_title/.test(source), `${name} carries a task title`)
    }
  })
})

// ─── 2. What writes where ────────────────────────────────────────────────────

describe('the board reads and writes nothing', () => {
  test('it holds no client, no query and no RPC', () => {
    assert.ok(!/supabase|\.rpc\(|\.from\(/.test(BOARD))
  })
})

describe('the workspace writes only to THIS meeting', () => {
  test('every RPC it calls is keyed on this appearance', () => {
    const rpcs = [...WORKSPACE.matchAll(/rpc\(\s*\n?\s*'([a-z_]+)'/g)].map(m => m[1]).sort()
    assert.deepEqual(rpcs, [
      'add_meeting_discussion_evidence',
      'ensure_meeting_discussion_order',
      'save_meeting_discussion_update',
    ], 'the workspace calls exactly these three, and each one takes an appearance id')
    // Every one of them is scoped to the appearance being looked at — there is no
    // path from this screen to another meeting's row.
    assert.equal((WORKSPACE.match(/p_appearance_id: appearance\.id/g) ?? []).length, rpcs.length)
  })

  test('it never writes a table directly — every write is a guarded RPC', () => {
    assert.ok(!/supabase\s*\n?\s*\.from\(/.test(WORKSPACE), 'the workspace queries a table directly')
    assert.ok(!/\.from\('meeting/.test(WORKSPACE))
  })

  test('earlier meetings are rendered read-only — no control writes to one', () => {
    const earlier = WORKSPACE.slice(WORKSPACE.indexOf('function EarlierMeetings'))
    assert.ok(!/rpc\(/.test(earlier), 'the earlier-meetings panel calls an RPC')
    assert.match(WORKSPACE, /newest first · read-only/)
  })
})

// ─── 3. Viewer versus editor ─────────────────────────────────────────────────

describe('capabilities decide what is drawn, and the database decides the rest', () => {
  const liveMeeting = { status: 'in_progress', lead_id: 'lead', created_by: 'creator' } as Meeting
  const doneMeeting = { status: 'completed',   lead_id: 'lead', created_by: 'creator' } as Meeting

  const viewer = deriveMeetingsCapabilities('member', [{ actionKey: 'view', allowed: true } as never])
  const editor = deriveMeetingsCapabilities('member', [{ actionKey: 'edit', allowed: true } as never])

  test('a view-only user cannot edit a live meeting', () => {
    assert.equal(canEditThisMeeting(liveMeeting, 'someone', viewer), false)
    assert.equal(viewer.canConductMeeting, false)
  })

  test('an editor can — and still cannot touch a COMPLETED meeting', () => {
    assert.equal(canEditThisMeeting(liveMeeting, 'someone', editor), true)
    assert.equal(canEditThisMeeting(doneMeeting, 'someone', editor), false)
  })

  test('the lead and the creator may conduct their own meeting without a grant', () => {
    assert.equal(canEditThisMeeting(liveMeeting, 'lead', NO_MEETINGS_CAPABILITIES), true)
    assert.equal(canEditThisMeeting(liveMeeting, 'creator', NO_MEETINGS_CAPABILITIES), true)
    assert.equal(canEditThisMeeting(liveMeeting, 'stranger', NO_MEETINGS_CAPABILITIES), false)
  })

  test('nobody edits a completed meeting, however strong the grant', () => {
    const admin = deriveMeetingsCapabilities('admin', [])
    assert.equal(canEditThisMeeting(doneMeeting, 'lead', admin), false)
  })

  test('reopening an ISSUE is allowed from a completed meeting — the issue is not the meeting', () => {
    // The browser mirror of reopen_meeting_discussion_item(), which passes
    // p_allow_completed := true for this one test and writes nothing to the meeting.
    assert.equal(canReopenDiscussionItem(doneMeeting, 'lead', NO_MEETINGS_CAPABILITIES), true)
    assert.equal(canReopenDiscussionItem(doneMeeting, 'someone', editor), true)
    assert.equal(canReopenDiscussionItem(doneMeeting, 'someone', viewer), false)
  })

  test('the composer, the evidence upload and Resolve are all behind `editable`', () => {
    assert.match(WORKSPACE, /\{resolved \? \([\s\S]*?\) : editable \? \(\s*\n\s*<DiscussionComposer/)
    // The upload control lives INSIDE the composer, so it is gated by that same
    // branch and cannot be reached by a viewer or in a completed meeting.
    assert.ok(WORKSPACE.indexOf('function DiscussionComposer') < WORKSPACE.indexOf('<ImagePlus'))
    assert.equal((WORKSPACE.match(/<ImagePlus/g) ?? []).length, 1)
    // Resolve acts on the issue as it stands NOW, and only in an editable (live) meeting.
    assert.match(WORKSPACE, /\{!resolvedNow && editable && \(/)
  })

  test('a view-only user is told why, not left with a dead screen', () => {
    assert.match(WORKSPACE, /You can read this meeting, but not record in it/)
    assert.match(WORKSPACE, /completed and read-only\. Reopen the meeting/)
  })

  test('New Issue is offered only to somebody who can edit the meeting', () => {
    assert.match(SCREEN, /onNewIssue=\{editable \? \(\) => setModal\(\{ kind: 'new-issue' \}\) : undefined\}/)
  })

  test('creating a follow-up task needs the Task module as well as Meetings', () => {
    assert.match(SCREEN, /onCreateTask=\{editable && canCreateTasks && selectedRow\.item\.state === 'open'/)
  })

  test('the Inbox offers Add to a meeting only to a meeting editor', () => {
    // The screen resolves the capability; the body only renders what it is handed.
    assert.match(INBOX, /canAttach=\{caps\.canConductMeeting\}/)
    assert.match(INBOX, /\{canAttach && \(/)
  })

  test('Add to Meeting is denied by default until the check answers', () => {
    assert.match(TASK_PAGE, /const \[canAddToMeeting,\s*setCanAddToMeeting\]\s*=\s*useState\(false\)/)
    assert.match(TASK_PAGE, /hasPermission\(supabase, signedInUserId, 'meetings', 'view'\)/)
    assert.match(TASK_PAGE, /\.catch\(\(\) => \{ if \(active\) setCanAddToMeeting\(false\) \}\)/)
  })

  test('the target-meeting list offers only meetings the RPC will accept', () => {
    assert.match(CAPTURE, /\.in\('status', \['draft', 'in_progress'\]\)/)
    assert.match(CAPTURE, /\.filter\(m => canEditThisMeeting\(m, userId, caps\)\)/)
  })

  test('the attach dialog never offers a completed meeting', () => {
    assert.match(MODALS, /\.in\('status', \['draft', 'in_progress'\]\)/)
  })
})

// ─── 4. Evidence ─────────────────────────────────────────────────────────────

describe('saving an update and its images', () => {
  test('the update is saved BEFORE any image is uploaded', () => {
    const update = WORKSPACE.indexOf("'save_meeting_discussion_update'")
    const upload = WORKSPACE.indexOf('bucket.upload(')
    assert.ok(update > -1 && upload > update, 'a refused update must upload nothing at all')
  })

  test('the order folder is resolved before the upload, never guessed', () => {
    const folder = WORKSPACE.indexOf("'ensure_meeting_discussion_order'")
    const upload = WORKSPACE.indexOf('bucket.upload(')
    assert.ok(folder > -1 && upload > folder,
      'the private bucket authorizes on the folder, so it has to exist before the upload')
    assert.match(WORKSPACE, /buildEvidencePath\(orderId, target\.ext!\)/)
  })

  test('an image is recorded only after its upload, and removed if recording fails', () => {
    const upload  = WORKSPACE.indexOf('bucket.upload(')
    const record  = WORKSPACE.indexOf("'add_meeting_discussion_evidence'")
    const cleanup = WORKSPACE.indexOf('bucket.remove([path])')
    assert.ok(upload > -1 && record > upload && cleanup > record)
    assert.match(WORKSPACE, /upsert: false/, 'an existing object is never overwritten')
  })

  test('a fresh key per attempt, so a retry cannot collide with an earlier one', () => {
    assert.match(WORKSPACE, /A fresh key per attempt/)
  })
})

// ─── 5. Reads are batched ────────────────────────────────────────────────────

describe('the reads scale with the meeting, not with the number of issues', () => {
  test('every discussion read is by a set of ids, never one query per issue', () => {
    for (const pattern of [
      /\.from\('meeting_discussion_items'\)[\s\S]{0,260}\.in\('id', itemIds\)/,
      /\.from\('meeting_discussion_appearances'\)[\s\S]{0,200}\.in\('discussion_item_id', itemIds\)/,
      /\.from\('meeting_discussion_events'\)[\s\S]{0,260}\.in\('discussion_item_id', itemIds\)/,
      /\.from\('meeting_order_evidence'\)[\s\S]{0,260}\.in\('discussion_appearance_id', appearanceIds\)/,
      /\.from\('meetings'\)[\s\S]{0,200}\.in\('id', meetingIds\)/,
    ]) {
      assert.match(READS, pattern)
    }
  })

  test('every read is paged, because PostgREST caps a response silently', () => {
    const selects = (READS.match(/\.select\(|\.rpc\(/g) ?? []).length
    const paged   = (READS.match(/fetchAllRows</g) ?? []).length
    assert.equal(selects, paged, 'a read that is not paged can lose an issue’s oldest updates')
  })

  test('a failed read returns null, so a screen never shows "none" for "unknown"', () => {
    assert.match(READS, /return null/)
    assert.match(SCREEN, /Could not load the discussion items for this meeting/)
  })

  test('the screen composes the board from what it already read', () => {
    assert.match(SCREEN, /buildDiscussionRows\(\{/)
    assert.match(SCREEN, /groupDiscussionHistory\(\{/)
  })
})

// ─── 6. Scope ────────────────────────────────────────────────────────────────

describe('Task Detail gained one action and one dialog, and nothing else', () => {
  test('exactly one button component and one modal are used', () => {
    assert.equal((TASK_PAGE.match(/<AddToMeetingModal/g) ?? []).length, 1)
    assert.equal((TASK_PAGE.match(/<AddToMeetingButton/g) ?? []).length, 2,
      'the active row and the closed-state row, which is how Copy & Assign is placed too')
  })

  test('the dialog changes nothing about the task', () => {
    // No status write, no assignee write, no activity row, no notification.
    assert.ok(!/\.from\('tasks'\)/.test(CAPTURE), 'the dialog writes to tasks')
    assert.ok(!/task_activity_log/.test(CAPTURE))
    assert.ok(!/requestAssignmentNotification/.test(CAPTURE))
    assert.match(CAPTURE, /It changes NOTHING about the task/)
  })

  test('it calls exactly one RPC: the capture', () => {
    const rpcs = [...new Set([...CAPTURE.matchAll(/rpc\(\s*'([a-z_]+)'/g)].map(m => m[1]))].sort()
    assert.deepEqual(rpcs, ['capture_meeting_discussion_item'])
  })

  test('there is no Undo, and nothing that would stand in for one', () => {
    // No operation removes an agenda entry, and Resolve records that the business
    // issue is FINISHED — using it to reverse a mis-click would falsify the record.
    assert.ok(!/resolve_meeting_discussion_item/.test(CAPTURE), 'the capture sheet must not resolve anything')
    assert.ok(!/>\s*Undo\s*</.test(CAPTURE), 'no Undo button')
    assert.ok(!/\.delete\(/.test(CAPTURE))
  })

  test('the outcome says which meeting, and offers the agenda', () => {
    assert.match(CAPTURE, /Added to <strong>\{addedTo\}<\/strong>/)
    assert.match(CAPTURE, /View Agenda/)
  })

  test('a repeat press is reported honestly instead of silently doing nothing', () => {
    assert.match(CAPTURE, /This task already has an open discussion item/)
    assert.match(CAPTURE, /'status', 'existing'|status === 'existing'/)
  })

  test('with no meeting chosen it says the item is waiting in the Inbox', () => {
    assert.match(CAPTURE, /Saved to the <strong>Meeting Inbox<\/strong>/)
    assert.match(CAPTURE, /p_meeting_id: meetingId === INBOX \? null : meetingId/)
  })

  test('the Task module gained no other Meetings coupling', () => {
    const meetingsImports = [...TASK_PAGE.matchAll(/from '@\/(lib|components)\/meetings[^']*'/g)].map(m => m[0])
    assert.deepEqual(meetingsImports, [], 'Task Detail imports the action, not the Meetings module')
  })
})

// ─── 7. The agenda is the screen's first question ────────────────────────────

describe('the meeting screen', () => {
  test('shows the discussion agenda and the Order rail as two separate sections', () => {
    assert.match(SCREEN, /<DiscussionBoard/)
    assert.match(SCREEN, /Orders under review/)
    assert.match(SCREEN, /<MeetingBoard/)
  })

  test('the issue workspace lives in the query string, like the Order one', () => {
    assert.match(SCREEN, /const openItemId\s*= searchParams\.get\('item'\)/)
    assert.match(SCREEN, /\?item=\$\{appearanceId\}/)
  })

  test('an `item` that is no longer on the agenda simply shows the board', () => {
    assert.match(SCREEN, /const selectedRow = selectedRowIndex >= 0 \? discussionRows\[selectedRowIndex\] : null/)
  })

  test('the existing Order rail keeps its own state and behaviour', () => {
    // Renamed so the two kinds of "discussion" cannot be confused, and nothing else.
    assert.match(SCREEN, /const orderDiscussionState = useMemo\(/)
    assert.match(SCREEN, /discussion=\{orderDiscussionState\}/)
    assert.match(SCREEN, /discussionStateByOrder\(history, evidence\)/)
  })

  test('the five shipped Order-rail workflows are still wired', () => {
    for (const modal of [
      'MeetingImportModal', 'CarryForwardOrdersModal', 'AddOrderModal', 'AddItemModal',
      'ItemUpdateModal', 'MeetingTaskModal', 'CompleteMeetingModal', 'ReopenMeetingModal',
      'OrderDiscussion',
    ]) {
      assert.ok(SCREEN.includes(`<${modal}`), `${modal} is no longer rendered`)
    }
  })
})

// ─── 8. Found in the rendered review ─────────────────────────────────────────

describe('defects found by rendering the real components', () => {
  test('Add to Meeting cannot be submitted while the meeting list is still loading', () => {
    // Otherwise the target is silently the Inbox, and a quick tap sends the issue
    // there even though a live meeting of the right type exists.
    assert.match(CAPTURE, /const canSubmit = !saving && result === null && meetings !== null &&/)
  })

  test('the capture outcome never contradicts itself', () => {
    // The title once said "Added to the meeting" over a body saying it went to the Inbox.
    assert.match(CAPTURE, /result\.in_inbox \? 'Saved to the Meeting Inbox' : 'Added to the meeting'/)
    assert.match(CAPTURE, /'Already raised from this task'/)
  })

  test('a completed meeting says "resolved in this meeting", never "today"', () => {
    assert.match(BOARD, /meetingCompleted \? 'resolved in this meeting' : 'resolved today'/)
    assert.match(SCREEN, /meetingCompleted=\{meeting\.status === 'completed'\}/)
  })

  test('the earlier-meetings count does not count the outside-a-meeting group', () => {
    assert.match(WORKSPACE, /groups\.filter\(group => group\.meetingId !== null\)\.length/)
  })

  test('a follow-up task row wraps on a phone instead of running past the edge', () => {
    const row = WORKSPACE.slice(WORKSPACE.indexOf('onClick={() => onOpenTask(id)}'))
    assert.match(row.slice(0, 900), /flexWrap: 'wrap'/)
    assert.ok(!/whiteSpace: 'nowrap'/.test(row.slice(0, 900)), 'the owner line must be allowed to wrap')
  })

  test('the Inbox waiting chip does not wear the After Sales amber', () => {
    const chip = INBOX.slice(INBOX.indexOf('Waiting for a meeting') - 500, INBOX.indexOf('Waiting for a meeting'))
    assert.ok(!/#FFFBEB|#FDE68A|#92400E/.test(chip))
  })
})

// ─── 9. Review fixes (PR #164) ───────────────────────────────────────────────

const TASK_MODAL = read('src/components/meetings/DiscussionTaskModal.tsx')

describe('a failure is never shown as an empty state', () => {
  test('the board: a failed agenda read shows the failure and Retry, not "Add the first issue"', () => {
    assert.match(SCREEN, /loadFailed=\{discussion === null\}/)
    const failed = BOARD.slice(BOARD.indexOf('if (loadFailed) {'), BOARD.indexOf('const resolvedWords'))
    assert.match(failed, /role="alert"/)
    assert.match(failed, /does not mean the agenda is empty/)
    assert.ok(!failed.includes('EmptyBoard') && !failed.includes('Add the first issue'))
  })

  test('the Inbox: the list, its count and its empty state render only after a successful read', () => {
    assert.match(INBOX, /\{!loadError && \(/)
    assert.match(INBOX, /if \(!rows\) \{\s*\n[\s\S]*?setItems\(\[\]\)/)
  })

  test('Add to Meeting: a failed meeting read blocks the Add and says so — it never falls back to the Inbox', () => {
    assert.match(CAPTURE, /const \[meetingsError, setMeetingsError\]/)
    assert.match(CAPTURE, /meetings !== null && meetingsError === null && capturePrefillIsSubmittable/)
    assert.match(CAPTURE, /if \(readError\) throw readError/)
    // The permission read may not silently become "no permissions" either.
    assert.ok(!/getEffectivePermissions\([^)]*\)\.catch/.test(CAPTURE))
  })

  test('the attach dialog: a failed meeting read is not "no live meeting"', () => {
    assert.match(MODALS, /setLoadFailed\(true\)/)
    assert.match(MODALS, /\{loadFailed \? null : meetings === null \?/)
  })
})

describe('the capture result says only what happened', () => {
  test('the toast follows the outcome, including the Inbox', () => {
    assert.match(CAPTURE, /return result\.in_inbox \? 'Saved to the Meeting Inbox' : 'Added to the meeting agenda'/)
    assert.equal((CAPTURE.match(/onDone\(captureToastMessage\(result\)\)/g) ?? []).length, 2)
  })

  test('an existing issue on a meeting the caller cannot open is described without a link', () => {
    assert.match(CAPTURE, /already on the agenda of a meeting you are not part of/)
    assert.match(CAPTURE, /\{result\.meeting_id && \(/)
  })
})

describe('Task Detail offers Add to Meeting only to the people the database accepts', () => {
  test('both rows use the one rule: creator, current assignee or admin, with Meetings access', () => {
    assert.match(TASK_PAGE, /canOfferAddToMeeting\(\{\s*\n?\s*hasMeetingAccess: canAddToMeeting, isCreator, isAssignee, isAdmin, isQuotation,/)
    assert.equal((TASK_PAGE.match(/\{offerAddToMeeting && /g) ?? []).length, 2)
    assert.ok(!/\{canAddToMeeting && /.test(TASK_PAGE), 'no row may draw the action on Meetings access alone')
  })
})

describe('a follow-up task whose link failed is never created twice', () => {
  test('the created task is kept and only Retry link is offered', () => {
    assert.match(TASK_MODAL, /setUnlinked\(\{ taskId, notified \}\)/)
    assert.match(TASK_MODAL, /const canSubmit = createdTaskId === null && unlinked === null/)
    assert.match(TASK_MODAL, /\{unlinked \? \(\s*<MeetingModalActions[\s\S]*?onSave=\{retryLink\}[\s\S]*?saveLabel="Retry link"/)
    // The retry re-records the link; it never inserts a task.
    const retry = TASK_MODAL.slice(TASK_MODAL.indexOf('const retryLink'), TASK_MODAL.indexOf('return (', TASK_MODAL.indexOf('const retryLink')))
    assert.ok(!retry.includes(".from('tasks')"))
    assert.match(retry, /linkTask\(unlinked\.taskId, unlinked\.notified\)/)
  })
})

describe('the workspace', () => {
  test('"Earlier meetings" leaves out this meeting and every later one', () => {
    assert.match(WORKSPACE, /const earlier = earlierDiscussionHistory\(history, meeting\)/)
  })

  test('emptying a decision is sent as the explicit clear flag', () => {
    assert.match(WORKSPACE, /const clearsDecision = decisionMoved && decisionText === ''/)
    assert.match(WORKSPACE, /p_decision: decisionMoved && !clearsDecision \? decisionText : null/)
    assert.match(WORKSPACE, /p_clear_decision: clearsDecision/)
  })

  test('nothing in the browser selects the resolution_note column', () => {
    for (const source of [SCREEN, WORKSPACE, MODALS, READS, INBOX, CAPTURE]) {
      assert.ok(!source.includes('resolution_note'))
    }
  })
})
