'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { colors } from '@/lib/tokens'
import {
  MAX_BODY,
  MAX_TITLE,
  MIN_BODY,
  validateDraftText,
} from '@/lib/customerReviews/draftGeneration'
import type { TestCard } from '@/lib/customerReviews/types'

// ── Correcting one draft, before anybody may see it ──────────────────────────
//
// WHAT THIS IS FOR. A batch arrives, eleven read well, and one has a phrase the
// verifier would not put their name to. Regenerating the batch throws away the
// eleven good ones; deleting the twelfth leaves the batch short. Neither is
// what somebody wants when the fix is a sentence.
//
// THE FULL TEXT, NOT A COMPRESSED FIELD. The body textarea is sized to hold a
// whole review, because the thing being edited is prose and editing prose
// through a three-line window is how sentences get mangled at the seam.
//
// SAVING IS NOT APPROVING, and the screen says so in as many words. There is no
// path from this file to an approval: `onSaved` refreshes the row and nothing
// else. A verifier who edits and walks away has changed a draft that is still
// awaiting approval.
//
// ── WHY A HOOK AND TWO COMPONENTS ──────────────────────────────────────────
//
// ReviewSheet pins its footer, which is what makes the primary action reachable
// on a phone without scrolling past a long body. That means the fields
// and the Save button are rendered into two different slots by the caller, and
// they need one piece of state between them. A hook is the smallest thing that
// gives them one: the caller owns it, passes it to both, and there is no
// context, no ref forwarding and no way for the button to disagree with the
// field about whether the text is valid.
//
// THE VALIDATION HERE IS A COURTESY. validateDraftText is the SAME function the
// route runs on what actually arrives, which is why it is imported rather than
// restated: a message shown here and a message returned by the server cannot
// disagree about what is wrong. The route re-runs it, and
// edit_customer_review_draft() re-checks the telephone rule in SQL after
// locking the row.
//
// AND IT CANNOT REACH AN APPROVED REVIEW. The editor is only offered for a
// pending draft, the route refuses anything else, and the definer function
// locks the row and reads the status again before it writes. A draft approved
// by somebody else while this sheet was open produces a refusal, not a silent
// overwrite.

export type DraftEditor = ReturnType<typeof useDraftEditor>

export function useDraftEditor(
  card: TestCard,
  onSaved: (updated: { test_title: string; test_body: string }) => void | Promise<void>,
) {
  const [title, setTitle] = useState(card.test_title)
  const [body, setBody] = useState(card.test_body)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // State is too slow to stop a double press — two in one tick would both see
  // `saving === false`. The ref is what actually stops the second request; the
  // database's row lock is what actually decides.
  const inFlight = useRef(false)

  const dirty = title !== card.test_title || body !== card.test_body
  const check = useMemo(() => validateDraftText(title, body), [title, body])

  const save = useCallback(async () => {
    if (inFlight.current) return
    if (!check.ok) { setError(check.error); return }
    inFlight.current = true
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/customer-reviews/draft', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId: card.id, title: check.title, body: check.body }),
      })
      const payload = await res.json().catch(() => null)
      if (!res.ok) {
        setError(payload?.error ?? 'That change could not be saved. Try again.')
        return
      }
      await onSaved({
        test_title: payload?.card?.test_title ?? check.title,
        test_body:  payload?.card?.test_body ?? check.body,
      })
    } catch {
      setError('That change could not be saved. Try again.')
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }, [check, card.id, onSaved])

  return { title, setTitle, body, setBody, saving, error, dirty, check, save }
}

export function EditDraftFields({ editor }: { editor: DraftEditor }) {
  const { title, setTitle, body, setBody, saving, error, dirty, check } = editor
  const titleLength = title.trim().length
  const bodyLength = body.trim().length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <p style={{ margin: 0, fontSize: '12px', color: colors.secondary, lineHeight: 1.6 }}>
        You are editing a draft that is still awaiting approval. Saving records the change
        and leaves it awaiting approval — it does not approve it, and no candidate can see
        it either way.
      </p>

      <Field label="Title" hint={`${titleLength} / ${MAX_TITLE}`} over={titleLength > MAX_TITLE}>
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          disabled={saving}
          aria-label="Review title"
          style={{
            width: '100%', boxSizing: 'border-box',
            padding: '11px 12px', minHeight: '44px',
            borderRadius: '8px', border: `1px solid ${colors.border}`,
            fontSize: '13px', fontFamily: 'inherit', color: colors.primary,
            background: '#FFFFFF', lineHeight: 1.5,
          }}
        />
      </Field>

      {/*
        THE WHOLE REVIEW, OPEN. Fourteen rows covers most of a real draft
        without the inner scrollbar that makes long-form editing feel like
        working through a letterbox, and it is resizable rather than clipped —
        a body near the MAX_BODY ceiling still just grows the box.
      */}
      <Field
        label="Review"
        hint={`${bodyLength} / ${MAX_BODY}`}
        over={bodyLength > MAX_BODY || (bodyLength > 0 && bodyLength < MIN_BODY)}
      >
        <textarea
          value={body}
          onChange={e => setBody(e.target.value)}
          disabled={saving}
          rows={14}
          aria-label="Review text"
          style={{
            width: '100%', boxSizing: 'border-box',
            padding: '11px 12px', resize: 'vertical', minHeight: '240px',
            borderRadius: '8px', border: `1px solid ${colors.border}`,
            fontSize: '13px', fontFamily: 'inherit', color: colors.primary,
            background: '#FFFFFF', lineHeight: 1.65,
          }}
        />
      </Field>

      {/*
        THE LIVE OBJECTION, BEFORE SAVE IS PRESSED — but only once something has
        changed, so a sheet that has just opened is not scolding a verifier for
        text they have not touched.
      */}
      {dirty && !check.ok && !error && (
        <p style={{ margin: 0, fontSize: '12px', color: colors.red, lineHeight: 1.5 }}>
          {check.error}
        </p>
      )}

      {error && (
        <p role="alert" style={{ margin: 0, fontSize: '12px', color: colors.red, lineHeight: 1.5 }}>
          {error}
        </p>
      )}

      {/*
        role="status" so the save is announced rather than only shown. A spinner
        on a button tells a screen-reader user nothing.
      */}
      <span role="status" style={{ fontSize: '11px', color: colors.tertiary, lineHeight: 1.4 }}>
        {saving ? 'Saving your changes…' : ' '}
      </span>
    </div>
  )
}

/**
 * Save and Cancel, rendered into ReviewSheet's pinned footer by the caller —
 * the same arrangement ReviewFullViewActions uses, and for the same reason.
 */
export function EditDraftActions({
  editor,
  onCancel,
}: {
  editor: DraftEditor
  onCancel: () => void
}) {
  const { saving, dirty, check, save } = editor
  return (
    <>
      <button
        type="button"
        onClick={save}
        // Off while nothing has changed, while the text would be refused, and
        // while a request is in flight. Three different reasons, none of them
        // "the server will sort it out".
        disabled={saving || !dirty || !check.ok}
        className="boe-btn boe-btn-primary"
        style={{
          flex: '1 1 auto', justifyContent: 'center',
          fontSize: '13px', padding: '11px 16px', minHeight: '44px',
        }}
      >
        {saving && <Loader2 size={14} strokeWidth={2.4} style={{ animation: 'boe-spin 0.8s linear infinite' }} />}
        {saving ? 'Saving…' : 'Save changes'}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={saving}
        className="boe-btn boe-btn-ghost"
        style={{ justifyContent: 'center', fontSize: '13px', padding: '11px 16px', minHeight: '44px' }}
      >
        Cancel
      </button>
    </>
  )
}

/**
 * A note that a draft is no longer exactly what the model wrote.
 *
 * THE POINT OF THIS COMPONENT. The module labels every draft as AI-generated,
 * and that label stops being the whole truth the moment a person types over it.
 * Leaving it alone would let "generated by a model" stand for text a verifier
 * partly wrote — a small dishonesty about provenance, and provenance is most of
 * what this module is careful about.
 *
 * It does not replace the AI label. Both are shown: the draft came from a model
 * AND a person has since changed it.
 */
export function DraftEditedNote({ card, compact = false }: { card: TestCard; compact?: boolean }) {
  if (!card.draft_edited_at) return null
  return (
    <span
      data-testid="draft-edited-note"
      style={{
        display: 'inline-flex', alignItems: 'center',
        padding: compact ? '2px 6px' : '3px 8px',
        borderRadius: '5px', background: '#FEF6E7', border: '1px solid #F5DFB0',
        fontSize: compact ? '10px' : '11px', color: '#8A5A0B', lineHeight: 1.4,
      }}
    >
      Edited by a verifier
    </span>
  )
}

function Field({
  label, hint, over, children,
}: {
  label: string
  hint: string
  over: boolean
  children: React.ReactNode
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <span style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'baseline' }}>
        <span style={{
          fontSize: '11px', fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.05em', color: colors.tertiary,
        }}>
          {label}
        </span>
        {/*
          The counter turns red rather than the input clamping. Silently
          truncating what somebody typed is worse than telling them it is long.
        */}
        <span style={{ fontSize: '11px', color: over ? colors.red : colors.muted }}>
          {hint}
        </span>
      </span>
      {children}
    </label>
  )
}
