'use client'

import { useEffect, useState } from 'react'

const QUOTES = [
  "Small steps every day lead to big results over time.",
  "Your work today shapes the success of tomorrow.",
  "Focus on progress, not perfection.",
  "Every task completed is a step forward.",
  "Consistency beats intensity — show up every day.",
  "Clarity of purpose turns hard work into great work.",
  "Effort compounds. What you do today multiplies.",
  "Do it with intention and it will make a difference.",
  "Great teams are built one reliable person at a time.",
  "Your attitude at the start determines the outcome.",
  "Begin with energy. The momentum will carry you.",
  "Discipline is the bridge between goals and achievement.",
  "Small wins build the confidence for bigger ones.",
  "The best time to be productive is right now.",
  "Pursue excellence quietly — results will speak loudly.",
  "Make today count. Future you is watching.",
  "A clear mind is more powerful than a busy one.",
  "Be the person your team can count on.",
  "Good work is its own reward — do it anyway.",
  "One focused hour beats three distracted ones.",
  "Challenges are feedback in disguise.",
  "Trust the process. Growth is rarely visible in the moment.",
  "Bring your full self to work — it matters.",
  "Every expert was once a beginner who kept going.",
  "Kindness and quality at work are never wasted.",
  "Today is a fresh chance to do something great.",
  "Precision and care in small tasks build a great reputation.",
  "Hard work is a quiet form of respect for the craft.",
  "Your energy sets the tone for those around you.",
  "Start before you feel ready — momentum follows action.",
  "Difficulties reveal strengths you didn't know you had.",
  "A great day starts with a clear first task.",
  "Execution is the strategy that actually works.",
  "Show up fully and let the results follow.",
  "Reliable people move the world forward.",
  "Excellence is a habit, not a destination.",
  "Make the mundane meaningful — it all adds up.",
  "Teamwork compounds individual effort.",
  "The work you put in today is tomorrow's foundation.",
  "Purpose turns ordinary tasks into meaningful ones.",
  "Stay curious. The best ideas come from unexpected places.",
  "A calm approach solves most problems faster.",
  "Progress, however small, is still progress.",
  "Invest your focus where it matters most today.",
  "Good enough can always become better — start somewhere.",
  "Patience with the process is a professional skill.",
  "You set the standard for what great looks like here.",
  "Each completed task is a promise kept to yourself.",
  "The difference is in the details — take care of them.",
]

function getTodayKey() {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm   = String(d.getMonth() + 1).padStart(2, '0')
  const dd   = String(d.getDate()).padStart(2, '0')
  return `boe_daily_quote_seen_${yyyy}-${mm}-${dd}`
}

function getDailyQuote() {
  const d = new Date()
  // Use local date components only — avoids UTC-based day switching for IST users
  const startOfYear = new Date(d.getFullYear(), 0, 1)
  const dayOfYear =
    (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) -
     Date.UTC(startOfYear.getFullYear(), startOfYear.getMonth(), startOfYear.getDate())) /
    86_400_000
  return QUOTES[dayOfYear % QUOTES.length]
}

export default function DailyQuoteLoader({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<'check' | 'quote' | 'done'>('check')
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const key = getTodayKey()
    if (localStorage.getItem(key)) {
      setPhase('done')
      return
    }

    setPhase('quote')
    // Fade in
    const fadeIn = setTimeout(() => setVisible(true), 30)
    // Start fade out at 2.1s, then mark done at 2.5s and persist
    const fadeOut = setTimeout(() => setVisible(false), 2100)
    const finish  = setTimeout(() => {
      localStorage.setItem(key, '1')
      setPhase('done')
    }, 2500)

    return () => {
      clearTimeout(fadeIn)
      clearTimeout(fadeOut)
      clearTimeout(finish)
    }
  }, [])

  if (phase === 'check') return null

  if (phase === 'quote') {
    const quote = getDailyQuote()
    return (
      <div style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0F1422',
        zIndex: 9999,
        padding: '32px 24px',
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.4s ease',
      }}>
        {/* BOE logo */}
        <div style={{ marginBottom: '48px' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/branding/boe-logo-white.png"
            alt="Best of Exports"
            style={{ height: '32px', width: 'auto', opacity: 0.85 }}
          />
        </div>

        {/* Quote mark */}
        <div style={{
          fontSize: '64px',
          lineHeight: 1,
          color: '#1A2A4A',
          fontFamily: 'Georgia, serif',
          marginBottom: '16px',
          alignSelf: 'flex-start',
          maxWidth: '520px',
          width: '100%',
        }}>
          &ldquo;
        </div>

        {/* Quote text */}
        <p style={{
          fontSize: 'clamp(18px, 4vw, 26px)',
          fontWeight: 500,
          color: '#E2E8F0',
          lineHeight: 1.55,
          textAlign: 'center',
          maxWidth: '520px',
          margin: '0 0 48px',
          letterSpacing: '-0.01em',
        }}>
          {quote}
        </p>

        {/* Progress bar */}
        <div style={{
          width: '40px',
          height: '2px',
          background: '#1E3A5F',
          borderRadius: '999px',
          overflow: 'hidden',
        }}>
          <div style={{
            height: '100%',
            background: '#4A90D9',
            borderRadius: '999px',
            animation: 'boe-progress 2.1s linear forwards',
          }} />
        </div>

        <style>{`
          @keyframes boe-progress {
            from { width: 0% }
            to   { width: 100% }
          }
        `}</style>
      </div>
    )
  }

  return <>{children}</>
}
