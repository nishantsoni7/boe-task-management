'use client'

// "Ask About Your Salary" — the Q&A at the foot of the payroll guide.
//
// Answers come from /api/payroll/ask, which is grounded in BOE's own payroll
// rules and holds no employee data. The provider key never reaches this file;
// everything here is a fetch to our own route.
//
// Four states, all of them real: idle (with suggested questions), loading,
// answered, and failed (with a retry that re-sends the same question). A fifth —
// not configured — is what the page shows when ANTHROPIC_API_KEY is absent, and
// it says so plainly rather than pretending to think.

import { useState } from 'react'
import { colors } from '@/lib/tokens'
import {
  MAX_QUESTION_LENGTH,
  SUGGESTED_QUESTIONS,
  ASK_DISABLED_MESSAGE,
} from '@/lib/payroll/askGrounding'

type AskState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'answered'; question: string; answer: string }
  | { status: 'error'; question: string; message: string }
  | { status: 'unconfigured' }

export function AskAboutSalary({ token }: { token: string }) {
  const [question, setQuestion] = useState('')
  const [state, setState]       = useState<AskState>({ status: 'idle' })

  const ask = async (raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed || state.status === 'loading') return

    setState({ status: 'loading' })
    try {
      const res = await fetch('/api/payroll/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ question: trimmed }),
      })
      const json = await res.json().catch(() => ({}))

      if (!res.ok) {
        setState({ status: 'error', question: trimmed, message: json.error ?? 'Something went wrong. Please try again.' })
        return
      }
      // The route reports this rather than erroring: nothing is broken, the
      // feature simply is not switched on.
      if (json.configured === false) {
        setState({ status: 'unconfigured' })
        return
      }
      setState({ status: 'answered', question: trimmed, answer: json.answer })
    } catch {
      setState({ status: 'error', question: trimmed, message: 'Could not reach the assistant. Check your connection and try again.' })
    }
  }

  const askSuggested = (suggested: string) => {
    setQuestion(suggested)
    void ask(suggested)
  }

  const busy = state.status === 'loading'

  return (
    <section
      aria-labelledby="ask-about-salary"
      style={{
        background: '#fff', border: `1px solid ${colors.border}`, borderRadius: 12,
        padding: '18px 18px 20px', marginTop: 26,
      }}
    >
      <h2
        id="ask-about-salary"
        style={{ fontSize: 15.5, fontWeight: 700, color: '#111318', letterSpacing: '-0.01em', margin: 0 }}
      >
        Ask About Your Salary
      </h2>
      <p style={{ fontSize: 12.5, color: '#8C94A6', margin: '3px 0 0', lineHeight: 1.5 }}>
        Ask a question about BOE attendance, deductions, adjustments, or salary settlement.
      </p>

      {state.status === 'unconfigured' ? (
        <div style={{
          marginTop: 14, padding: '12px 14px', borderRadius: 9,
          background: 'rgba(0,0,0,0.028)', fontSize: 12.5, color: '#5B6474', lineHeight: 1.6,
        }}>
          {ASK_DISABLED_MESSAGE}
        </div>
      ) : (
        <>
          <form
            onSubmit={e => { e.preventDefault(); void ask(question) }}
            style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            <label htmlFor="ask-input" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
              Your question
            </label>
            <textarea
              id="ask-input"
              value={question}
              onChange={e => setQuestion(e.target.value.slice(0, MAX_QUESTION_LENGTH))}
              maxLength={MAX_QUESTION_LENGTH}
              rows={2}
              disabled={busy}
              placeholder="For example: why was a deduction applied for a late arrival?"
              onKeyDown={e => {
                // Enter sends, Shift+Enter makes a new line — the convention for
                // a single-question box.
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(question) }
              }}
              style={{
                width: '100%', padding: '10px 12px', borderRadius: 9,
                border: `1px solid ${colors.border}`, fontSize: 13, fontFamily: 'inherit',
                color: colors.primary, background: busy ? 'rgba(0,0,0,0.02)' : '#fff',
                resize: 'vertical', lineHeight: 1.5,
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11.5, color: '#A9AFBD', fontVariantNumeric: 'tabular-nums' }}>
                {question.length}/{MAX_QUESTION_LENGTH}
              </span>
              <button
                type="submit"
                disabled={busy || question.trim().length === 0}
                className="boe-btn boe-btn-primary"
                style={{
                  padding: '7px 16px', fontSize: 12.5, whiteSpace: 'nowrap',
                  opacity: busy || question.trim().length === 0 ? 0.55 : 1,
                }}
              >
                {busy ? 'Thinking…' : 'Ask'}
              </button>
            </div>
          </form>

          {/* Suggested questions double as the empty state — they show what the
              assistant is for, without a paragraph explaining it. */}
          {state.status === 'idle' && (
            <div style={{ marginTop: 14 }}>
              <div style={{
                fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: '0.09em', color: '#8C94A6', marginBottom: 8,
              }}>
                Try one of these
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                {SUGGESTED_QUESTIONS.map(s => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => askSuggested(s)}
                    style={{
                      padding: '6px 12px', borderRadius: 999, cursor: 'pointer',
                      border: `1px solid ${colors.border}`, background: '#fff',
                      fontSize: 12, color: '#3D4455', textAlign: 'left', lineHeight: 1.4,
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {busy && (
            <div
              role="status"
              style={{
                marginTop: 14, padding: '12px 14px', borderRadius: 9,
                background: 'rgba(0,0,0,0.028)', fontSize: 12.5, color: '#6B7280',
              }}
            >
              Reading the payroll rules…
            </div>
          )}

          {state.status === 'answered' && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12.5, color: '#8C94A6', marginBottom: 6 }}>
                {state.question}
              </div>
              <div style={{
                padding: '13px 15px', borderRadius: 9,
                background: 'rgba(79,111,208,0.05)', border: '1px solid rgba(79,111,208,0.22)',
              }}>
                <AnswerText text={state.answer} />
              </div>
              <div style={{ fontSize: 11.5, color: '#A9AFBD', marginTop: 7, lineHeight: 1.5 }}>
                Answered from BOE&rsquo;s payroll rules. It has no access to your payroll records —
                open the month in My Payroll for your own figures.
              </div>
            </div>
          )}

          {state.status === 'error' && (
            <div
              role="alert"
              style={{
                marginTop: 14, padding: '12px 14px', borderRadius: 9,
                background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.22)',
                fontSize: 12.5, color: '#B42318', lineHeight: 1.55,
                display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
              }}
            >
              <span style={{ minWidth: 200, flex: 1 }}>{state.message}</span>
              <button
                type="button"
                onClick={() => void ask(state.question)}
                className="boe-btn boe-btn-ghost"
                style={{ padding: '4px 12px', fontSize: 12.5, whiteSpace: 'nowrap' }}
              >
                Try again
              </button>
            </div>
          )}
        </>
      )}
    </section>
  )
}

/**
 * The answer, rendered as controlled plain text.
 *
 * Paragraphs, "-" bullets and **bold** only — deliberately not a Markdown
 * renderer. Model output is text from outside this application, and the set of
 * things it can turn into on the page is kept to exactly three, none of which
 * can produce a link, an image or an embed.
 */
function AnswerText({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/).map(b => b.trim()).filter(Boolean)

  return (
    <div style={{ fontSize: 13, color: '#3D4455', lineHeight: 1.65 }}>
      {blocks.map((block, i) => {
        const lines = block.split('\n').map(l => l.trim()).filter(Boolean)
        const isList = lines.length > 0 && lines.every(l => /^[-*]\s+/.test(l))

        if (isList) {
          return (
            <ul key={i} style={{ margin: i > 0 ? '9px 0 0' : 0, paddingLeft: 18 }}>
              {lines.map((l, j) => (
                <li key={j} style={{ marginTop: j > 0 ? 3 : 0 }}>{bold(l.replace(/^[-*]\s+/, ''))}</li>
              ))}
            </ul>
          )
        }
        return <p key={i} style={{ margin: i > 0 ? '9px 0 0' : 0 }}>{bold(block)}</p>
      })}
    </div>
  )
}

/** **bold** → <strong>. The only inline markup accepted. */
function bold(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, i) =>
    part.startsWith('**') && part.endsWith('**')
      ? <strong key={i} style={{ fontWeight: 600, color: '#111318' }}>{part.slice(2, -2)}</strong>
      : <span key={i}>{part}</span>,
  )
}
