'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, RefreshCw, Send } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { hasInternalTestWarning } from '@/lib/customerReviews/internalTest'
import { maskWhatsAppNumber } from '@/lib/customerReviews/contact'
import { InternalTestWarning, WhatsAppOpenedNote } from './ReviewPieces'

// The one control that reaches outside BOE — and it still does not send
// anything.
//
// THE ALLOWLIST IS THE POINT, AND IT LIVES ON THE SERVER
// -----------------------------------------------------
// Nothing in this component builds a wa.me URL. It asks
// /api/customer-reviews/whatsapp for the approved internal team numbers, the
// tester picks one, and the SERVER composes the message and the link. If the
// browser assembled the URL the allowlist would be a suggestion: anything
// running in this tab could put a stranger's number in the path. Here, the
// number in the link is one the server chose from its own list.
//
// A tester may also TYPE a number instead of picking one. That is not a hole:
// what they type is sent to the server and checked against the same list, and a
// number that is not on it comes back 403 with no link. The picker is a
// convenience; the server is the boundary.
//
// WHAT THE OPEN BUTTON DOES, IN ORDER
//   1. opens a blank tab SYNCHRONOUSLY, inside the click, so the browser treats
//      it as user-initiated and does not block it;
//   2. asks the server for the link with `record: true` — which re-checks, on
//      the server and in the database, that the caller holds this card, holds
//      `use`, that the card is still booked, and that the number is approved;
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
//   * It does not contact a customer. Every number it can reach is a BOE
//     internal team number from the deployment's own configuration.
//
// REPEATED CLICKS are stopped twice over: a ref guard that rejects a second
// click while the first is still in flight (state is too slow — two clicks in
// the same tick would both see `busy === false`), and a cooldown afterwards.

const COOLDOWN_MS = 5000

type AllowedNumber = { label: string; e164: string }

type Preview = { message: string; waMeUrl: string; target: { label: string; e164: string } }

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
  const [numbers, setNumbers]   = useState<AllowedNumber[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [choice, setChoice]     = useState('')
  const [typed, setTyped]       = useState('')
  const [useTyped, setUseTyped] = useState(false)

  const [preview, setPreview]   = useState<Preview | null>(null)
  const [previewing, setPreviewing] = useState(false)

  const [busy, setBusy]         = useState(false)
  const [cooling, setCooling]   = useState(false)
  const inFlight = useRef(false)
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (cooldownTimer.current) clearTimeout(cooldownTimer.current)
  }, [])

  // THE ALLOWLIST, FETCHED ONCE. A failure here is shown as a failure — the
  // panel does not fall back to a free-text field with no list to check
  // against, because that is precisely the state the allowlist exists to
  // prevent.
  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const res = await fetch('/api/customer-reviews/whatsapp', { cache: 'no-store' })
        const body = await res.json().catch(() => null)
        if (!active) return
        if (!res.ok) {
          setListError(body?.error ?? 'Internal test numbers are not available.')
          return
        }
        const list: AllowedNumber[] = Array.isArray(body?.numbers) ? body.numbers : []
        setNumbers(list)
        setChoice(list[0]?.e164 ?? '')
        if (list.length === 0) setListError('No internal test numbers are configured.')
      } catch {
        if (active) setListError('Internal test numbers are not available.')
      }
    }
    load()
    return () => { active = false }
  }, [])

  const chosenNumber = useTyped ? typed.trim() : choice

  /**
   * Ask the server to compose the message. RECORDS NOTHING — `record` defaults
   * to false server-side and is not sent here, so reading what you are about to
   * send never writes to the card.
   */
  const loadPreview = useCallback(async () => {
    if (!chosenNumber) return
    setPreviewing(true)
    setPreview(null)
    try {
      const res = await fetch('/api/customer-reviews/whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId, number: chosenNumber }),
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
  }, [cardId, chosenNumber, onError])

  const ready = enabled && !!chosenNumber && !listError && !busy && !cooling

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
        body: JSON.stringify({ cardId, number: chosenNumber, record: true }),
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
      // opens rather than an unlabelled message reaching a colleague's phone.
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
  }, [ready, cardId, chosenNumber, onOpened, onError])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>

      {/* ── Who it goes to ── */}
      <div>
        <label
          htmlFor="internal-test-number"
          style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: colors.secondary, marginBottom: '6px' }}
        >
          Send the test to an approved BOE internal number
        </label>

        {listError ? (
          <p role="alert" style={{ fontSize: '12px', color: colors.red, margin: 0 }}>
            {listError} Ask an administrator to configure the internal test numbers for this
            deployment. No message can be prepared until they do.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {!useTyped ? (
              <select
                id="internal-test-number"
                value={choice}
                onChange={e => { setChoice(e.target.value); setPreview(null) }}
                disabled={!enabled}
                className="boe-input"
                style={{ maxWidth: '340px' }}
              >
                {numbers.map(n => (
                  <option key={n.e164} value={n.e164}>
                    {n.label} — {maskWhatsAppNumber(n.e164)}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="internal-test-number"
                type="tel"
                value={typed}
                onChange={e => { setTyped(e.target.value); setPreview(null) }}
                disabled={!enabled}
                placeholder="+91 98765 43210"
                className="boe-input"
                style={{ maxWidth: '340px' }}
              />
            )}

            <button
              type="button"
              onClick={() => { setUseTyped(v => !v); setPreview(null) }}
              style={{
                alignSelf: 'flex-start', background: 'transparent', border: 'none',
                padding: 0, cursor: 'pointer', color: colors.tertiary,
                fontSize: '11px', fontWeight: 600, textDecoration: 'underline',
              }}
            >
              {useTyped ? 'Choose from the approved list instead' : 'Type an approved number instead'}
            </button>

            {useTyped && (
              <p style={{ fontSize: '11px', color: colors.muted, margin: 0, lineHeight: 1.5 }}>
                Whatever you type is checked against the same approved list on the server. A number
                that is not on it is refused and no link is produced.
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── What it says ── */}
      <div>
        <button
          type="button"
          onClick={loadPreview}
          disabled={!enabled || !chosenNumber || !!listError || previewing}
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
              {preview.target.label} ({maskWhatsAppNumber(preview.target.e164)}).
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
