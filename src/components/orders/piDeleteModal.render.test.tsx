/**
 * THE DELETE CONFIRMATION, ACTUALLY RENDERED.
 *
 * A destructive dialog is one of the few screens where what it SAYS is the whole
 * safety mechanism: there is no undo behind it, and the only thing standing
 * between a mis-click and a deleted PI is that the person read an accurate
 * sentence. So this renders the real PiDeleteConfirmModal — the same export the
 * PI Drafts list opens — and reads the markup that comes out.
 *
 * Run:
 *   npx tsx --test src/components/orders/piDeleteModal.render.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { PiDeleteConfirmModal } from './piReviewModals'
import {
  DELETE_PI_BUSY_LABEL,
  DELETE_PI_CANCEL_LABEL,
  DELETE_PI_CONFIRM_LABEL,
  DELETE_PI_DIALOG_TITLE,
  DELETE_PI_WARNING,
  describeDeletionFailure,
} from '@/lib/orders/submissionDeletion'

function render(over: {
  client?: string
  status?: string
  deleting?: boolean
  failure?: string | null
} = {}): string {
  return renderToStaticMarkup(
    <PiDeleteConfirmModal
      client={over.client ?? 'Kalyan Interiors'}
      status={over.status ?? 'draft'}
      deleting={over.deleting ?? false}
      failure={over.failure ?? null}
      onCancel={() => {}}
      onConfirm={() => {}}
    />,
  )
}

/** The confirm button is the last one in the panel; Cancel sits before it. */
function confirmDisabled(html: string): boolean {
  const button = html.lastIndexOf('<button')
  assert.ok(button >= 0)
  const tail = html.slice(button)
  return tail.slice(0, tail.indexOf('>')).includes('disabled=""')
}

describe('the dialog states what is about to be destroyed', () => {
  const html = render({ client: 'Meridian Hotels', status: 'rejected' })

  test('the title asks rather than announces', () => {
    assert.ok(html.includes(DELETE_PI_DIALOG_TITLE))
  })

  test('the client is named, so a mis-clicked row is visible from here', () => {
    assert.ok(html.includes('Meridian Hotels'))
  })

  test('the current status is shown in words, not as an enum value', () => {
    assert.ok(html.includes('Rejected'))
    assert.ok(!html.includes('needs_changes'))
  })

  test('the warning names the workbook, the images and the history', () => {
    // React escapes nothing in this sentence, so it appears verbatim.
    assert.ok(html.includes(DELETE_PI_WARNING))
    for (const thing of ['workbook', 'product images', 'activity history',
                         'permanently', 'cannot be undone']) {
      assert.ok(html.includes(thing), `"${thing}" must be on screen`)
    }
  })

  test('the two buttons are Cancel and Delete PI, and nothing else', () => {
    assert.ok(html.includes(DELETE_PI_CANCEL_LABEL))
    assert.ok(html.includes(DELETE_PI_CONFIRM_LABEL))
    assert.equal((html.match(/<button/g) ?? []).length, 3, 'Cancel, Delete PI, and the × control')
  })

  test('NO TYPED CONFIRMATION is demanded', () => {
    assert.ok(!html.includes('<input'), 'no box to retype a client name into')
    assert.ok(!html.includes('<textarea'))
  })

  test('and the destructive button is enabled, because there is nothing to fill in', () => {
    assert.equal(confirmDisabled(html), false)
  })

  test('every status the rule allows renders in its own words', () => {
    assert.ok(render({ status: 'draft' }).includes('Draft'))
    assert.ok(render({ status: 'needs_changes' }).includes('Needs Changes'))
    assert.ok(render({ status: 'rejected' }).includes('Rejected'))
  })
})

describe('a deletion in flight cannot be started twice', () => {
  const html = render({ deleting: true })

  test('the confirm button is disabled and says what is happening', () => {
    assert.equal(confirmDisabled(html), true)
    assert.ok(html.includes(DELETE_PI_BUSY_LABEL))
    assert.ok(!html.includes(`>${DELETE_PI_CONFIRM_LABEL}<`))
  })

  test('so are Cancel and the × control, so nothing races the request', () => {
    assert.equal((html.match(/<button[^>]*disabled=""/g) ?? []).length, 3)
  })
})

describe('a failed deletion keeps the dialog open and says why', () => {
  test('the row is not removed and the reason is on screen', () => {
    for (const code of ['STATUS_CHANGED', 'FORBIDDEN', 'NOT_FOUND',
                        'STORAGE_CLEANUP_FAILED', 'DELETE_FAILED'] as const) {
      const failure = describeDeletionFailure(code)
      const html = render({ failure: failure.message })
      assert.ok(html.includes(failure.message.replace(/’/g, '’')),
        `${code} must be shown`)
      assert.equal(confirmDisabled(html), false, 'and the action stays retryable')
    }
  })

  test('a PI that entered review explains itself in the dialog', () => {
    const html = render({
      status: 'draft',
      failure: describeDeletionFailure('STATUS_CHANGED').message,
    })
    assert.ok(/under review/i.test(html))
    assert.ok(/cannot be deleted/i.test(html))
  })

  test('no raw database text ever reaches it', () => {
    const html = render({ failure: describeDeletionFailure('DELETE_FAILED').message })
    assert.ok(!/ERROR|relation |column |pg_|sqlstate/i.test(html))
  })
})
