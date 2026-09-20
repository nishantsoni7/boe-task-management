'use client'

// ── Quick Capture — one box, one tap ─────────────────────────────────────────
//
// "500 cash to Ramesh for diesel." Said or typed while walking back to the car,
// saved in one tap, completed at a desk that evening.
//
// ── WHY THIS EXISTS BESIDE A PERFECTLY GOOD FORM ────────────────────────────
//
// The full form asks for six things and refuses to save until five of them are
// right. That is correct for an expense — a total is only worth reading if every
// row in it is complete. But somebody standing beside a tempo does not know the
// category, may not have the exact amount, and has about four seconds. The
// realistic alternative to this box is not a carefully filled form; it is the
// expense never being recorded at all.
//
// So: one text box and a microphone, and the ONLY requirement is that something
// was said. Everything missing is missing, shown as missing, and filled in
// later.
//
// ── IT IS NOT A CHAT ────────────────────────────────────────────────────────
//
// One box, one button, no thread, no back-and-forth, no follow-up questions. The
// parser reads what it can and says nothing about what it could not; the inbox
// is where the gaps are listed.
//
// ── VOICE NEVER SAVES ───────────────────────────────────────────────────────
//
// Speech recognition fills the box and stops. The transcript sits there, on
// screen, editable, until the person taps Save for later themselves. There is no
// code path from a recognition result to a write — not here, not in the hook,
// not in the parser.

import { useCallback, useMemo, useRef, useState } from 'react'
import { Mic } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { formatMoney } from '@/lib/finance/piPaymentView'
import { localTodayIso } from '@/lib/finance/piPaymentView'
import type { createClient } from '@/lib/supabase/client'
import {
  DRAFT_RAW_TEXT_MAX,
  QUICK_CAPTURE_HINT,
  QUICK_CAPTURE_PLACEHOLDER,
  QUICK_CAPTURE_SAVE_LABEL,
  draftMissingFields,
  draftMissingSummary,
  draftTextProblem,
  draftWritePayload,
  type ExpenseDraftRow,
} from '@/lib/finance/expenseDrafts'
import { VOICE_UNSUPPORTED_MESSAGE } from '@/lib/finance/expenseVoice'
import { useExpenseSpeech } from './useExpenseSpeech'
import { friendlyWriteError } from './ExpenseForm'

type Supabase = ReturnType<typeof createClient>

export const QUICK_CAPTURE_EXAMPLES = [
  'Paid 1000 rupees to Vikram for machine repair',
  '500 cash to Ramesh for diesel',
  'Paid Mohan 2200 yesterday',
  '750 for factory work',
] as const

export function QuickCapture({
  supabase, userId, onSaved, onCancel, autoFocus = false,
}: {
  supabase: Supabase
  userId: string
  /** The saved draft. The caller decides what to offer next. */
  onSaved: (draft: ExpenseDraftRow) => void
  onCancel?: () => void
  autoFocus?: boolean
}) {
  const todayIso = useMemo(() => localTodayIso(), [])
  const [text, setText] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // DOUBLE SUBMISSION IS IMPOSSIBLE, not merely discouraged — the same
  // arrangement every other Finance write uses. A ref set SYNCHRONOUSLY is what
  // actually stops the second of two taps inside one frame.
  const inFlight = useRef(false)

  // WHAT WAS HEARD GOES IN THE BOX, AND STOPS THERE. Appended rather than
  // replacing, so a second sentence adds to the first and nothing somebody
  // typed is thrown away by pressing the microphone.
  const takeTranscript = useCallback((heard: string) => {
    setText(prev => (prev.trim() === '' ? heard : `${prev.trim()} ${heard}`))
    setError(null)
  }, [])

  const voice = useExpenseSpeech(takeTranscript)

  const problem = draftTextProblem(text)
  const shownProblem = submitted ? problem : null

  // ── WHAT WILL BE SAVED, SHOWN BEFORE IT IS ──
  // The same parser that runs on the server-bound payload, run here on every
  // keystroke, so nothing about the result is a surprise. In particular the
  // MISSING AMOUNT is on screen before the tap, not discovered in the inbox
  // afterwards.
  const preview = useMemo(
    () => (text.trim() === '' ? null : draftWritePayload(text, todayIso)),
    [text, todayIso],
  )
  const missing = preview ? draftMissingFields({ ...preview }) : []

  const save = async () => {
    setSubmitted(true)
    if (inFlight.current) return
    if (draftTextProblem(text) !== null) return

    inFlight.current = true
    setSaving(true)
    setError(null)
    try {
      const payload = draftWritePayload(text, todayIso)
      const { data, error: dbError } = await supabase
        .from('expense_drafts')
        .insert({ ...payload, created_by: userId })
        .select('*')
        .single()

      if (dbError) { setError(friendlyWriteError(dbError)); return }
      onSaved(data as ExpenseDraftRow)
      setText('')
      setSubmitted(false)
    } catch {
      setError('The capture could not be saved. Check your connection and try again.')
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  return (
    <div data-testid="quick-capture" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>

      {/* ── THE BOX AND THE MICROPHONE, side by side, nothing between them ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <label htmlFor="quick-capture-text" className="boe-input-label">
          What was paid?
        </label>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch' }}>
          <textarea
            id="quick-capture-text"
            className="boe-input"
            value={text}
            disabled={saving}
            autoFocus={autoFocus}
            rows={3}
            maxLength={DRAFT_RAW_TEXT_MAX + 50}
            placeholder={QUICK_CAPTURE_PLACEHOLDER}
            aria-invalid={shownProblem ? true : undefined}
            aria-describedby="quick-capture-hint"
            onChange={e => { setText(e.target.value); setError(null) }}
            style={{ flex: 1, minWidth: 0, resize: 'vertical', lineHeight: 1.5, padding: '10px 12px' }}
          />
          {/* Drawn only where the browser can actually run it, so a phone that
              cannot is not shown a control that does nothing. */}
          {voice.supported && (
            <button
              type="button"
              onClick={voice.toggle}
              disabled={saving}
              aria-pressed={voice.listening}
              aria-label={voice.listening ? 'Stop listening' : 'Speak instead of typing'}
              className="boe-btn"
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                gap: '3px', flexShrink: 0, width: '72px', minHeight: '44px', padding: '8px',
                fontSize: '10.5px', fontWeight: 600,
                background: voice.listening ? 'rgba(217,79,79,0.10)' : colors.base,
                color: voice.listening ? '#C13030' : colors.primary,
                border: `1px solid ${voice.listening ? 'rgba(217,79,79,0.35)' : colors.borderSoft}`,
              }}
            >
              <Mic size={18} strokeWidth={1.9} />
              {voice.listening ? 'Listening' : 'Speak'}
            </button>
          )}
        </div>
        <div id="quick-capture-hint" style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.5 }}>
          {QUICK_CAPTURE_HINT}
        </div>
        {!voice.supported && (
          <div style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.5 }}>
            {VOICE_UNSUPPORTED_MESSAGE}
          </div>
        )}
        {voice.message && (
          <div role="status" style={{ fontSize: '11.5px', color: colors.tertiary, lineHeight: 1.5 }}>
            {voice.message}
          </div>
        )}
        {shownProblem && (
          <div role="alert" style={{ fontSize: '12px', color: '#C13030', lineHeight: 1.4 }}>
            {shownProblem}
          </div>
        )}
      </div>

      {/* ── WHAT WAS UNDERSTOOD, AND WHAT WAS NOT ──
          Both halves matter. Seeing "₹500 · Ramesh" confirms the parse; seeing
          "Missing: Amount" before tapping Save is what stops somebody
          discovering it a week later when they no longer remember. */}
      {preview && (
        <div
          data-testid="quick-capture-preview"
          style={{
            border: `1px solid ${colors.border}`, borderRadius: '10px',
            background: colors.raised, padding: '10px 12px',
            display: 'flex', flexDirection: 'column', gap: '5px',
          }}
        >
          <div style={{ fontSize: '12.5px', color: colors.primary, lineHeight: 1.5 }}>
            {preview.parsed_amount !== null
              ? <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{formatMoney(preview.parsed_amount)}</strong>
              : <span style={{ color: '#8A5A00', fontWeight: 600 }}>Amount not heard</span>}
            {preview.parsed_paid_to && <> · {preview.parsed_paid_to}</>}
          </div>
          <div style={{ fontSize: '11px', color: missing.length > 0 ? '#8A5A00' : colors.muted, lineHeight: 1.5 }}>
            {draftMissingSummary(missing)}
            {missing.length > 0 && ' — you can fill these in later.'}
          </div>
        </div>
      )}

      {error && (
        <div role="alert" style={{
          padding: '10px 12px', borderRadius: '8px',
          background: 'rgba(217,79,79,0.1)', color: '#C13030', fontSize: '12px', lineHeight: 1.5,
        }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        {onCancel && (
          <button
            type="button" onClick={onCancel} disabled={saving}
            className="boe-btn boe-btn-ghost" style={{ minHeight: '46px', fontSize: '13px' }}
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="boe-btn boe-btn-primary"
          style={{ minHeight: '46px', fontSize: '13.5px', minWidth: '150px', fontWeight: 600 }}
        >
          {saving ? 'Saving…' : QUICK_CAPTURE_SAVE_LABEL}
        </button>
      </div>

      {/* The shapes that work, learned by using them rather than by reading a
          manual. Tapping one fills the box — it does not save it. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
        <span style={{ fontSize: '10.5px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Try
        </span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {QUICK_CAPTURE_EXAMPLES.map(example => (
            <button
              key={example}
              type="button"
              disabled={saving}
              onClick={() => { setText(example); setError(null) }}
              className="boe-btn boe-btn-ghost"
              style={{ minHeight: '36px', padding: '5px 10px', fontSize: '11.5px', color: colors.tertiary }}
            >
              {example}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
