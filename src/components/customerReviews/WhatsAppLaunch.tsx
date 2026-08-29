'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, RefreshCw, Send } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { hasInternalTestWarning } from '@/lib/customerReviews/internalTest'
import { maskFromLastFour, maskWhatsAppNumber, normalizeWhatsAppNumber } from '@/lib/customerReviews/contact'
import { InternalTestWarning, WhatsAppOpenedNote } from './ReviewPieces'

// The one control that reaches outside BOE — and it still does not send
// anything.
//
// ANY VALID NUMBER, AND WHAT STANDS IN ITS PLACE
// ----------------------------------------------
// A tester types whatever international number they want to test against.
// There is no approved list. What replaced it is not nothing:
//
//   * the SERVER re-validates whatever is typed, whatever this component did
//     with it, and refuses a malformed, too-short, too-long or country-code-less
//     number with no link in the response;
//   * the tester must tick a confirmation that the number may receive an
//     internal BOE test message — required by the REQUEST, not by this form;
//   * only an active `use` holder, and only for a card they hold, gets a link
//     at all;
//   * the message still carries the permanent internal-test label, which the
//     server re-checks and this component re-checks again before opening.
//
// THE VALIDATION HERE IS A COURTESY. It saves a round trip to be told the
// number is malformed and lets the tester see what they typed in canonical
// form. It is not the boundary: the same function runs on the server, on the
// value that actually reaches it.
//
// NOTHING IN THIS FILE BUILDS A wa.me URL. It asks
// /api/customer-reviews/whatsapp, and the server composes both the message and
// the link. If the browser assembled the URL, the validation, the confirmation
// and the label would each be a suggestion a devtools console could skip.
//
// WHAT THE OPEN BUTTON DOES, IN ORDER
//   1. opens a blank tab SYNCHRONOUSLY, inside the click, so the browser treats
//      it as user-initiated and does not block it;
//   2. asks the server for the link with `record: true` — which re-checks, on
//      the server and in the database, that the caller holds this card, holds
//      `use`, that the card is still booked, that the confirmation was given
//      and that the number is well-formed;
//   3. only then points that tab at the URL the server returned.
//
// If step 2 refuses, the tab is closed and nothing opens. That ordering is the
// reason the request is not fired after the navigation: the answer has to
// arrive BEFORE anything opens, or the check is decoration.
//
// WHAT IT DOES NOT DO
//   * It does not send the message. WhatsApp opens with the text in the input
//     box and a person still has to press send — which is why the server writes
//     whatsapp_opened_at and NOT any status, and why confirming "I sent this"
//     is a separate, deliberate action below.
//   * It does not attach anything. A wa.me link carries a phone number and a
//     text parameter and nothing else.
//   * It does not keep the number. The card stores four digits and a
//     non-reversible fingerprint; this component holds what was typed only for
//     as long as the screen is open.
//
// REPEATED CLICKS are stopped twice over: a ref guard that rejects a second
// click while the first is still in flight (state is too slow — two clicks in
// the same tick would both see `busy === false`), and a cooldown afterwards.

const COOLDOWN_MS = 5000

/**
 * THE CONFIRMATION, WORD FOR WORD.
 *
 * The same sentence the route requires. It is written out here rather than
 * imported from the route because a Client Component must not pull in a module
 * that reads server-only configuration — and a source-contract test pins the
 * two strings to each other, so they cannot drift.
 */
export const RECIPIENT_CONFIRMATION =
  'I confirm this number may receive an internal BOE test message and the content will not be published as a customer review.'

type Preview = { message: string; waMeUrl: string; target: { lastFour: string } }

export function WhatsAppTestPanel({
  cardId,
  /** False when the caller does not hold this card, or it is no longer booked. */
  enabled,
  onOpened,
  onError,
}: {
  cardId: string
  enabled: boolean
  onOpened?: () => void
  onError?: (message: string) => void
}) {
  const [typed, setTyped] = useState('')
  const [confirmed, setConfirmed] = useState(false)

  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewing, setPreviewing] = useState(false)

  const [busy, setBusy] = useState(false)
  const [cooling, setCooling] = useState(false)
  const inFlight = useRef(false)
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (cooldownTimer.current) clearTimeout(cooldownTimer.current)
  }, [])

  // The courtesy check. `touched` keeps the message from appearing before the
  // tester has typed anything, which would be scolding them for an empty field
  // they have not reached yet.
  const touched = typed.trim() !== ''
  const normalized = normalizeWhatsAppNumber(typed)
  const localError = touched && !normalized.ok ? normalized.error : null

  const ready = enabled && normalized.ok && confirmed && !busy && !cooling

  /**
   * Ask the server to compose the message. RECORDS NOTHING — `record` is not
   * sent, and defaults to false server-side, so reading what you are about to
   * send never writes to the card.
   */
  const loadPreview = useCallback(async () => {
    if (!normalized.ok || !confirmed) return
    setPreviewing(true)
    setPreview(null)
    try {
      const res = await fetch('/api/customer-reviews/whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId, number: typed, confirmed: true }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        onError?.(body?.error ?? 'That message could not be prepared.')
        return
      }
      setPreview(body as Preview)
    } catch {
      onError?.('That message could not be prepared.')
    } finally {
      setPreviewing(false)
    }
  }, [cardId, typed, normalized.ok, confirmed, onError])

  const launch = useCallback(async () => {
    if (inFlight.current || !ready) return
    inFlight.current = true
    setBusy(true)

    // Opened inside the click so the popup blocker permits it. Everything after
    // this point either points the tab somewhere or closes it.
    const tab = window.open('', '_blank', 'noopener,noreferrer')

    try {
      const res = await fetch('/api/customer-reviews/whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId, number: typed, confirmed: true, record: true }),
      })
      const body = await res.json().catch(() => null)

      if (!res.ok) {
        tab?.close()
        onError?.(body?.error ?? 'Could not open WhatsApp for this test card.')
        return
      }

      const built = body as Preview
      // THE LAST LINE OF DEFENCE FOR THE MANDATORY LABEL. The server already
      // refuses to return an unlabelled message; if that ever changed, nothing
      // opens rather than an unlabelled message reaching somebody's phone.
      if (!built?.waMeUrl || !hasInternalTestWarning(built.message ?? '')) {
        tab?.close()
        onError?.('That message is missing its internal-test label and was not opened.')
        return
      }

      setPreview(built)
      if (tab) tab.location.href = built.waMeUrl
      // A blocked popup is not a failure of the record: the open was already
      // recorded, so the fallback navigates this tab rather than silently doing
      // nothing.
      else window.location.href = built.waMeUrl

      onOpened?.()
      setCooling(true)
      cooldownTimer.current = setTimeout(() => setCooling(false), COOLDOWN_MS)
    } catch {
      tab?.close()
      onError?.('Could not open WhatsApp for this test card.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }, [ready, cardId, typed, onOpened, onError])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>

      {/* ── Who it goes to ── */}
      <div>
        <label
          htmlFor="internal-test-number"
          style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: colors.secondary, marginBottom: '6px' }}
        >
          Enter WhatsApp number
        </label>

        <input
          id="internal-test-number"
          type="tel"
          inputMode="tel"
          autoComplete="off"
          value={typed}
          onChange={e => { setTyped(e.target.value); setPreview(null) }}
          disabled={!enabled}
          placeholder="+91 98765 43210"
          aria-invalid={localError ? true : undefined}
          aria-describedby="internal-test-number-help"
          className="boe-input"
          style={{ maxWidth: '340px' }}
        />

        <p
          id="internal-test-number-help"
          style={{ fontSize: '11px', color: colors.muted, margin: '6px 0 0', lineHeight: 1.5 }}
        >
          Include the country code. Spaces, hyphens and brackets are fine. The number is
          re-checked on the server, and only the last four digits are ever stored.
        </p>

        {localError && (
          <p role="alert" style={{ fontSize: '12px', color: colors.red, margin: '6px 0 0' }}>
            {localError}
          </p>
        )}

        {normalized.ok && (
          <p style={{ fontSize: '11px', color: colors.tertiary, margin: '6px 0 0' }}>
            This will open a chat with {maskWhatsAppNumber(normalized.e164)}.
          </p>
        )}
      </div>

      {/* ── The confirmation ── */}
      <label
        style={{
          display: 'flex', gap: '9px', alignItems: 'flex-start',
          padding: '10px 12px', borderRadius: '8px',
          background: colors.blueTint, border: '1px solid rgba(85,133,232,0.22)',
          fontSize: '12px', lineHeight: 1.55, color: colors.secondary,
          cursor: enabled ? 'pointer' : 'not-allowed',
        }}
      >
        <input
          type="checkbox"
          checked={confirmed}
          disabled={!enabled}
          onChange={e => { setConfirmed(e.target.checked); setPreview(null) }}
          style={{ marginTop: '2px', flexShrink: 0 }}
        />
        <span>{RECIPIENT_CONFIRMATION}</span>
      </label>

      {/* ── What it says ── */}
      <div>
        <button
          type="button"
          onClick={loadPreview}
          disabled={!enabled || !normalized.ok || !confirmed || previewing}
          className="boe-btn boe-btn-secondary"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}
        >
          <RefreshCw size={13} strokeWidth={2} />
          {previewing ? 'Preparing…' : preview ? 'Refresh preview' : 'Preview the exact message'}
        </button>

        {preview && (
          <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <InternalTestWarning />
            <pre
              data-testid="internal-test-message-preview"
              style={{
                margin: 0, padding: '12px', borderRadius: '8px',
                background: '#F9FAFB',
                border: `1px solid ${colors.border}`,
                fontSize: '12px', lineHeight: 1.6, whiteSpace: 'pre-wrap',
                wordBreak: 'break-word', fontFamily: 'inherit', color: colors.primary,
              }}
            >
              {preview.message}
            </pre>
            <p style={{ fontSize: '11px', color: colors.muted, margin: 0 }}>
              This is exactly what WhatsApp will be handed, addressed to{' '}
              {maskFromLastFour(preview.target.lastFour)}.
            </p>
          </div>
        )}
      </div>

      {/* ── Opening it ── */}
      <div>
        <button
          type="button"
          onClick={launch}
          disabled={!ready}
          className="boe-btn boe-btn-primary"
          style={{
            display: 'flex', alignItems: 'center', gap: '7px',
            padding: '9px 18px', fontSize: '13px',
            opacity: ready ? 1 : 0.5, cursor: ready ? 'pointer' : 'not-allowed',
          }}
        >
          <Send size={14} strokeWidth={2.2} />
          {busy ? 'Opening…' : cooling ? 'Opened — wait a moment' : 'Open WhatsApp'}
        </button>
        <p style={{ fontSize: '11px', color: colors.muted, marginTop: '6px', lineHeight: 1.5 }}>
          WhatsApp opens with this text ready, and nothing else — nothing is attached. You still
          have to press send there; BOE never sends it for you.
        </p>
        <WhatsAppOpenedNote />
      </div>
    </div>
  )
}

/**
 * The tester's own claim, and it is deliberately a SEPARATE control from the
 * one above.
 *
 * Opening WhatsApp records that a link was built. This records that a person
 * pressed send. They are two different facts, made by two different actors —
 * the application and the human — and collapsing them into one button is
 * exactly the thing this module exists to demonstrate is wrong.
 *
 * It is disabled until WhatsApp has actually been opened, which is an ORDERING
 * constraint rather than evidence: there is nothing to have sent if no link was
 * ever built. The database enforces the same rule.
 */
export function ConfirmSentControl({
  alreadyConfirmed,
  canConfirm,
  onConfirm,
  busy,
}: {
  alreadyConfirmed: boolean
  canConfirm: boolean
  onConfirm: () => void
  busy: boolean
}) {
  if (alreadyConfirmed) {
    return (
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: '7px',
        color: '#166534', fontSize: '12px', fontWeight: 600,
      }}>
        <CheckCircle2 size={14} strokeWidth={2.2} />
        You confirmed you sent this internal test.
      </div>
    )
  }

  return (
    <div>
      <button
        type="button"
        onClick={onConfirm}
        disabled={!canConfirm || busy}
        className="boe-btn boe-btn-secondary"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px',
          opacity: canConfirm && !busy ? 1 : 0.5,
          cursor: canConfirm && !busy ? 'pointer' : 'not-allowed',
        }}
      >
        <CheckCircle2 size={14} strokeWidth={2.2} />
        {busy ? 'Recording…' : 'Confirm internal test sent'}
      </button>
      <p style={{ fontSize: '11px', color: colors.muted, marginTop: '6px', lineHeight: 1.5 }}>
        Only press this after you have actually sent the message in WhatsApp. Opening WhatsApp does
        not do it for you, and nothing else in BOE will.
      </p>
    </div>
  )
}
