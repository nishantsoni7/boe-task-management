// THE EVENT LINE, AND WHAT IT REFUSES TO INVENT.
//
// Run:
//   npx tsx --test src/lib/notifications/eventPresentation.test.ts

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeNotificationEvent,
  actorMetaFor,
  updateCountLabel,
  truncateOneLine,
  safeCommentPreview,
  COMMENT_WITHOUT_PREVIEW,
  STATUS_WITHOUT_VALUES,
  COMMENT_PREVIEW_MAX,
} from './eventPresentation'

const row = (title: string, type = 'task_acknowledged') => ({ title, type })

// ── 5–6. Comments ────────────────────────────────────────────────────────────

describe('5-6. comment events', () => {
  test('5. a preview is one line, quoted by the caller, and truncated cleanly', () => {
    const long = 'Please confirm the final dimensions before proceeding, and also '
      + 'check the revised drawing that was uploaded this morning against the site survey.'
    const e = describeNotificationEvent(row('Dhruv added a comment'), { commentPreview: long })
    assert.equal(e.action, 'Added a comment')
    assert.equal(e.detail?.kind, 'comment')
    const text = e.detail!.kind === 'comment' ? e.detail.text : ''
    assert.ok(text.length <= COMMENT_PREVIEW_MAX + 1, 'within the one-line budget')
    assert.ok(text.endsWith('…'), 'ends with a real ellipsis')
    assert.equal(/\n/.test(text), false, 'genuinely one line')
    assert.equal(/[\s.,;:-]…$/.test(text), false, 'no dangling punctuation before the ellipsis')
  })

  test('5b. a short comment is shown whole, with no ellipsis', () => {
    const e = describeNotificationEvent(row('Dhruv added a comment'),
      { commentPreview: 'Please confirm the final dimensions before proceeding.' })
    assert.deepEqual(e.detail, { kind: 'comment', text: 'Please confirm the final dimensions before proceeding.' })
  })

  test('5c. markup, JSON and attachment URLs never reach the card', () => {
    assert.equal(safeCommentPreview('{"note":"hi","file":"x"}'), null, 'a JSON payload is not a comment')
    assert.equal(safeCommentPreview('[{"a":1}]'), null)
    assert.equal(safeCommentPreview('<b>bold</b> text'), 'bold text')
    const withUrl = safeCommentPreview('See https://xyz.supabase.co/storage/v1/object/sign/a.pdf now')
    assert.equal(withUrl, 'See now')
    assert.equal(/https?:/.test(withUrl ?? ''), false, 'no URL survives')
  })

  test('6. NO preview stored → an honest fallback, never an empty quote', () => {
    const e = describeNotificationEvent(row('Dhruv added a comment'))
    assert.equal(e.action, COMMENT_WITHOUT_PREVIEW)
    assert.equal(e.action, 'Comment added')
    assert.equal(e.detail, null, 'no detail line at all')
  })

  test('6b. the TASK TITLE is never used as the comment preview', () => {
    // body holds the task title on every write path. Passing it here would be
    // the tempting wrong answer, so the function only ever reads what it is
    // explicitly given as commentPreview — and given nothing, shows nothing.
    const e = describeNotificationEvent(row('Dhruv added a comment'))
    assert.equal(e.detail, null)
    assert.equal(/test task/i.test(e.action), false)
  })

  test('6c. a blank or whitespace preview is treated as absent', () => {
    for (const empty of ['', '   ', '\n\n']) {
      const e = describeNotificationEvent(row('Dhruv added a comment'), { commentPreview: empty })
      assert.equal(e.action, COMMENT_WITHOUT_PREVIEW, JSON.stringify(empty))
      assert.equal(e.detail, null)
    }
  })
})

// ── 7–8. Status ──────────────────────────────────────────────────────────────

describe('7-8. status events', () => {
  test('7. both values known → previous → new, with user-facing labels', () => {
    const e = describeNotificationEvent(row('Dhruv moved task to Waiting'),
      { fromStatus: 'working', toStatus: 'waiting' })
    assert.equal(e.action, 'Status changed')
    assert.deepEqual(e.detail, { kind: 'transition', from: 'Working', to: 'Waiting' })
  })

  test('8. only the NEW status → never an invented previous value', () => {
    const e = describeNotificationEvent(row('Dhruv moved task to Waiting'))
    assert.equal(e.action, 'Status changed to Waiting')
    assert.equal(e.detail, null, 'no transition line without both halves')
    assert.equal(/→/.test(e.action), false, 'no arrow with one value')
  })

  test('8b. every status word in the title is read, none is guessed', () => {
    for (const [title, expected] of [
      ['Dhruv moved task to Blocked', 'Status changed to Blocked'],
      ['Dhruv moved task to Working', 'Status changed to Working'],
      ['Task moved to Waiting',       'Status changed to Waiting'],
    ] as const) {
      assert.equal(describeNotificationEvent(row(title)).action, expected)
    }
  })

  test('8c. neither value available → the generic line, and nothing more', () => {
    const e = describeNotificationEvent(row('Task status updated'))
    assert.equal(e.action, STATUS_WITHOUT_VALUES)
    assert.equal(e.action, 'Status updated')
    assert.equal(e.detail, null)
  })

  test('8d. a from-status alone still does not produce a transition', () => {
    // A previous value with no new one describes nothing that happened.
    const e = describeNotificationEvent(row('Something happened'), { fromStatus: 'working' })
    assert.equal(e.detail, null)
    assert.equal(/Working/.test(e.action), false)
  })
})

// ── Other events ─────────────────────────────────────────────────────────────

describe('other events are compact action lines', () => {
  const CASES: [title: string, action: string][] = [
    ['New task assigned to you',            'Task assigned'],
    ['New quotation request',               'Quotation request assigned'],
    ['Asha submitted task for approval',    'Submitted for approval'],
    ['Asha returned task to Working',       'Returned for changes'],
    ['Asha approved and completed task',    'Approved and completed'],
    ['Dhruv completed task',                'Task completed'],
    ['Dhruv cancelled a task',              'Task cancelled'],
    ['Dhruv acknowledged task',             'Acknowledged'],
    ['Dhruv reversed cancellation of a task', 'Cancellation reversed'],
    ['Dhruv reopened a task',               'Task reopened'],
  ]
  for (const [title, action] of CASES) {
    test(`"${title}" → "${action}"`, () => {
      assert.equal(describeNotificationEvent(row(title)).action, action)
    })
  }

  test('an unrecognised sentence degrades to a generic line, not to "System"', () => {
    const e = describeNotificationEvent(row('Something nobody has written yet'))
    assert.equal(e.action, 'Task updated')
    assert.equal(/system/i.test(e.action), false,
      'a human action must never be labelled System Activity')
  })

  test('no action line names a person — the actor belongs in the metadata', () => {
    for (const [title] of CASES) {
      const e = describeNotificationEvent(row(title))
      assert.equal(/dhruv|asha/i.test(e.action), false, `"${title}" leaked the actor into the action`)
    }
  })
})

// ── 9–10. The actor rule ─────────────────────────────────────────────────────

describe('9-10. the actor is shown once, and only when it differs', () => {
  test('9. an actor who IS the assignee is not repeated', () => {
    assert.equal(actorMetaFor('Nishant', 'Nishant', '2h ago'), '2h ago')
    // Case and padding must not defeat it.
    assert.equal(actorMetaFor('  nishant ', 'Nishant', '2h ago'), '2h ago')
  })

  test('10. a different actor appears once, as muted metadata', () => {
    assert.equal(actorMetaFor('Dhruv', 'Nishant', '2h ago'), 'By Dhruv · 2h ago')
  })

  test('10b. and it appears in exactly one place', () => {
    const e = describeNotificationEvent(row('Dhruv added a comment'))
    assert.equal(e.actorName, 'Dhruv')
    assert.equal(/Dhruv/.test(e.action), false, 'never in the action sentence too')
    const meta = actorMetaFor(e.actorName, 'Nishant', '2h ago')
    assert.equal((meta.match(/Dhruv/g) ?? []).length, 1)
  })

  test('an actor-less sentence yields no actor rather than a guess', () => {
    for (const title of ['Task cancelled', 'Task completed', 'New task assigned to you']) {
      assert.equal(describeNotificationEvent(row(title)).actorName, null, title)
    }
  })

  test('with no assignee known, a named actor is still shown once', () => {
    assert.equal(actorMetaFor('Dhruv', null, 'just now'), 'By Dhruv · just now')
  })
})

// ── 3–4. The update count ────────────────────────────────────────────────────

describe('3-4. the count is events, and is always called "updates"', () => {
  test('4. plural for many', () => {
    assert.equal(updateCountLabel(3), '3 updates')
    assert.equal(updateCountLabel(12), '12 updates')
  })

  test('3. the singular exists but the card never shows it — see the component test', () => {
    assert.equal(updateCountLabel(1), '1 update')
  })

  test('the word is never "events", "items" or "subtasks"', () => {
    for (const n of [0, 1, 2, 9]) {
      assert.match(updateCountLabel(n), /update(s)?$/)
      assert.equal(/subtask|item|event/i.test(updateCountLabel(n)), false)
    }
  })
})

describe('truncateOneLine', () => {
  test('collapses whitespace and never breaks mid-word when it can help it', () => {
    assert.equal(truncateOneLine('a\n b   c'), 'a b c')
    const out = truncateOneLine('word '.repeat(60), 20)
    assert.ok(out.length <= 21)
    assert.ok(out.endsWith('…'))
  })

  test('an unbroken token still truncates rather than collapsing to nothing', () => {
    const out = truncateOneLine('x'.repeat(300), 20)
    assert.equal(out.length, 21)
    assert.ok(out.endsWith('…'))
  })
})
