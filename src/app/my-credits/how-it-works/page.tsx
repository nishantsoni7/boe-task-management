'use client'

// How BOE Credits Work — the whole scheme, for somebody who has never seen it.
//
// THE RULE THIS PAGE LIVES BY
// ---------------------------
// Not one business number is typed into this file. The reward, the value of a
// credit, the two attendance prices and the monthly target are read from
// /api/boe-credits/settings — the same row every operational path reads — so
// a settings change updates every example here the next time the page loads.
// The page explains; it decides nothing.
//
// It reads no employee record, so every signed-in person may open it; an
// administrator reaches it from the management page, an employee from theirs.
// Same shape as How Payroll Works: a hero with the live numbers, a journey,
// worked examples, and a compact rule book.

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowRight, BookOpen, CalendarCheck, CheckCircle2, ClipboardCheck, Coins, Lock,
  MessageSquareHeart, Send, ShieldCheck, Undo2, Wallet, XCircle,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { formatRupees } from '@/lib/payroll/money'
import { formatCredits } from '@/lib/boeCredits/ledger'
import { DEFAULT_BOE_CREDIT_SETTINGS, formatCreditValue } from '@/lib/boeCredits/settings'
import { MY_CREDITS_PATH } from '@/lib/boeCredits/paths'
import type { BoeCreditSettings } from '@/lib/boeCredits/types'

const ACCENT = '#4F6FD0'
const GREEN  = '#047857'
const AMBER  = '#92400E'

const card: React.CSSProperties = {
  background: '#fff', borderRadius: 12, border: `1px solid ${colors.border}`, overflow: 'hidden',
}

function SectionHeading({ id, title, note }: { id: string; title: string; note?: string }) {
  return (
    <div style={{ margin: '26px 0 10px' }}>
      <h2 id={id} style={{ margin: 0, fontSize: 16, fontWeight: 700, color: colors.primary, letterSpacing: '-0.01em' }}>{title}</h2>
      {note && <p style={{ margin: '4px 0 0', fontSize: 12.5, color: '#5B6474', lineHeight: 1.55 }}>{note}</p>}
    </div>
  )
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div style={{ borderRadius: 9, padding: '10px 12px', background: 'rgba(79,111,208,0.06)', border: '1px solid rgba(79,111,208,0.18)', minWidth: 0 }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.09em', color: colors.muted }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 700, color: colors.primary, marginTop: 3, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {note && <div style={{ fontSize: 11, color: colors.muted, marginTop: 2 }}>{note}</div>}
    </div>
  )
}

function Row({ label, value, tone, strong }: { label: string; value: string; tone?: string; strong?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', alignItems: 'baseline' }}>
      <span style={{ fontSize: strong ? 13 : 12.5, fontWeight: strong ? 700 : 400, color: strong ? colors.primary : '#5B6474' }}>{label}</span>
      <span style={{ fontSize: strong ? 15 : 13.5, fontWeight: strong ? 700 : 600, color: tone ?? colors.primary, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  )
}

export default function HowCreditsWorkPage() {
  const [profile,  setProfile]  = useState<UserProfile | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [settings, setSettings] = useState<BoeCreditSettings>(DEFAULT_BOE_CREDIT_SETTINGS)
  const [live,     setLive]     = useState(false)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      const { data: prof } = await supabase
        .from('users')
        .select(USER_PROFILE_COLUMNS)
        .eq('id', session.user.id)
        .single()
      setProfile((prof as UserProfile | null) ?? null)
      setLoading(false)

      const res = await fetch('/api/boe-credits/settings', { headers: { authorization: `Bearer ${session.access_token}` } }).catch(() => null)
      if (res && res.ok) {
        const json = await res.json().catch(() => null)
        if (json?.settings) { setSettings(json.settings as BoeCreditSettings); setLive(json.using_defaults !== true) }
      }
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  const s = settings
  const value = formatCreditValue(s.credit_value)
  const reward = formatCredits(s.review_reward_credits)
  const exampleCredits = 5
  const exampleAddition = exampleCredits * s.credit_value
  const examplePayable = 30_000
  const target = s.minimum_monthly_reviews
  const isAdmin = profile?.role === 'admin'

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="How BOE Credits Work"
      subtitle="Earn credits through verified customer review work. Use them for attendance support or add them to your salary."
      onSignOut={handleSignOut}
      actions={
        <Link href={isAdmin ? '/payroll/credits' : MY_CREDITS_PATH} className="boe-btn boe-btn-ghost" style={{ fontSize: 12.5, padding: '6px 12px' }}>
          {isAdmin ? 'Manage credits' : 'My credits'}
        </Link>
      }
    >
      <div style={{ maxWidth: 960 }}>
        <h1 className="payroll-guide-sr-only">How BOE Credits Work</h1>

        {/* ── Hero: the live numbers ─────────────────────────────────────── */}
        <section style={{ ...card, padding: '16px 18px' }}>
          <p style={{ margin: 0, fontSize: 13.5, color: '#3D4455', lineHeight: 1.6, maxWidth: 760 }}>
            A verified review earns credits. Once your month reaches its target, those credits are yours to spend —
            on a Half Day or Absent deduction, or as extra money on your salary. Unused credits never expire.
          </p>
          <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 150px), 1fr))', gap: 10 }}>
            <Stat label="1 verified review" value={reward} />
            <Stat label="1 credit" value={value} note="on your salary" />
            <Stat label="Half Day" value={formatCredits(s.half_day_redemption_credits)} />
            <Stat label="Full Day / Absent" value={formatCredits(s.full_day_redemption_credits)} />
            <Stat label="Monthly target" value={`${target} verified ${target === 1 ? 'review' : 'reviews'}`} />
          </div>
          <p style={{ margin: '10px 0 0', fontSize: 11.5, color: colors.muted, lineHeight: 1.5 }}>
            {live ? 'These are the current settings.' : 'These are the standard settings.'} An administrator can change them; a change applies
            to future reviews, redemptions and payroll applications only.
          </p>
        </section>

        {/* ── How you earn ───────────────────────────────────────────────── */}
        <SectionHeading id="earn" title="How you earn" note="Five steps. The credit is recorded at the last one, and it counts for the month you handed the work over." />
        <div className="payroll-guide-flow">
          {[
            { Icon: MessageSquareHeart, title: 'Book a review', text: 'Pick one from Available in the Review Workflow.' },
            { Icon: Send,               title: 'Send it',        text: 'Open WhatsApp, send, and confirm you sent it.' },
            { Icon: ClipboardCheck,     title: 'Submit',         text: 'Attach your screenshot and submit for verification.' },
            { Icon: ShieldCheck,        title: 'Verified',       text: 'A verifier checks it — or returns it to you to fix.' },
            { Icon: Coins,              title: 'Credit recorded', text: `${reward} on your ledger, for the month you submitted.` },
          ].map((step, i, all) => (
            <div key={step.title} style={{ ...card, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6, position: 'relative' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 24, height: 24, borderRadius: 999, background: 'rgba(79,111,208,0.10)', color: ACCENT, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11.5, fontWeight: 700 }}>{i + 1}</span>
                <step.Icon size={15} strokeWidth={1.9} color={ACCENT} aria-hidden="true" />
                <span style={{ fontSize: 13, fontWeight: 700, color: colors.primary }}>{step.title}</span>
              </div>
              <div style={{ fontSize: 12, color: '#5B6474', lineHeight: 1.5 }}>{step.text}</div>
              {i < all.length - 1 && (
                <ArrowRight size={14} color="#A8B0BF" aria-hidden="true" style={{ position: 'absolute', right: -13, top: 18 }} />
              )}
            </div>
          ))}
        </div>
        <div style={{ ...card, marginTop: 10, padding: '11px 14px', fontSize: 12.5, color: '#3D4455', lineHeight: 1.55, background: 'rgba(0,0,0,0.02)' }}>
          <strong>Which month does a credit belong to?</strong> The month you <em>submitted</em> the review — the month you handed the work over — not the
          month it was verified. Submitted on 30 September and verified on 2 October counts for <strong>September</strong>. If a review is returned and
          you resubmit it, the later submission is the one that counts.
        </div>

        {/* ── Monthly target ─────────────────────────────────────────────── */}
        <SectionHeading id="target" title="The monthly target" note={`Until a month reaches ${target} verified ${target === 1 ? 'review' : 'reviews'}, its credits are pending. Reach it and they become available.`} />
        <div className="payroll-guide-grid-2">
          <div style={{ ...card, padding: '14px 16px' }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.09em', color: colors.muted }}>Example · target {target}</div>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {Array.from({ length: target }, (_, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#3D4455' }}>
                  <CheckCircle2 size={16} color={GREEN} aria-hidden="true" />
                  <span>Review {i + 1} verified · <strong style={{ color: colors.primary }}>{formatCredits(s.review_reward_credits, { signed: true })}</strong>{i + 1 < target ? ' · pending' : ''}</span>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, background: 'rgba(5,150,105,0.09)', color: GREEN, fontSize: 12.5, fontWeight: 600 }}>
              Monthly target completed — {formatCredits(target * s.review_reward_credits)} now available
            </div>
            <div style={{ fontSize: 11.5, color: colors.muted, marginTop: 8, lineHeight: 1.5 }}>
              Review {target + 1}, {target + 2}… in the same month are available straight away.
            </div>
          </div>
          <div style={{ ...card, padding: '14px 16px' }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.09em', color: colors.muted }}>If the month closes below target</div>
            <Row label="Credits you already had" value="17" />
            <Row label="September review 1" value={formatCredits(s.review_reward_credits, { signed: true })} tone={AMBER} />
            <Row label="September review 2" value={formatCredits(s.review_reward_credits, { signed: true })} tone={AMBER} />
            <Row label="September closes below target" value={formatCredits(-2 * s.review_reward_credits, { signed: true })} tone="#B91C1C" />
            <div style={{ height: 1, background: 'rgba(0,0,0,0.12)', margin: '6px 0' }} />
            <Row label="Spendable after" value="17" strong />
            <div style={{ fontSize: 11.5, color: colors.muted, marginTop: 8, lineHeight: 1.5 }}>
              Only that month&rsquo;s pending credits lapse. Everything you already had stays exactly as it was.
            </div>
          </div>
        </div>

        {/* ── How you can use credits ────────────────────────────────────── */}
        <SectionHeading id="use" title="How you can use credits" note="Two uses, both on your own payslip in My Payroll, while the month is still unlocked." />
        <div className="payroll-guide-grid-2">
          <div style={{ ...card, padding: '14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <CalendarCheck size={16} color={ACCENT} aria-hidden="true" />
              <span style={{ fontSize: 13.5, fontWeight: 700, color: colors.primary }}>Attendance</span>
            </div>
            <Row label="Half Day" value={formatCredits(s.half_day_redemption_credits)} />
            <Row label="Full Day / Absent" value={formatCredits(s.full_day_redemption_credits)} />
            <div style={{ fontSize: 12, color: '#5B6474', marginTop: 8, lineHeight: 1.55 }}>
              Next to a chargeable Half Day or Absent deduction on your payslip you will see <em>Use {s.half_day_redemption_credits} credits</em>.
              Confirm, and the day is settled at ₹0. Late arrivals, missing punches and days already covered by paid leave cannot be covered.
            </div>
          </div>
          <div style={{ ...card, padding: '14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <Wallet size={16} color={ACCENT} aria-hidden="true" />
              <span style={{ fontSize: 13.5, fontWeight: 700, color: colors.primary }}>Salary</span>
            </div>
            <Row label={`${exampleCredits} credits × ${value}`} value={`+${formatRupees(exampleAddition)}`} tone={GREEN} />
            <div style={{ height: 1, background: 'rgba(0,0,0,0.08)', margin: '6px 0' }} />
            <Row label="Salary Payable" value={formatRupees(examplePayable)} />
            <Row label="BOE Credit Addition" value={`+${formatRupees(exampleAddition)}`} tone={GREEN} />
            <div style={{ height: 1, background: 'rgba(0,0,0,0.12)', margin: '6px 0' }} />
            <Row label="Final Salary Payable" value={formatRupees(examplePayable + exampleAddition)} strong />
            <div style={{ fontSize: 12, color: '#5B6474', marginTop: 8, lineHeight: 1.55 }}>
              Choose how many credits to use on your payslip; the rupees are worked out for you. You can use credits this way even
              when you have no attendance deduction at all, and change or remove them until payroll is locked.
            </div>
          </div>
        </div>

        {/* ── Carry forward + historical protection ──────────────────────── */}
        <div className="payroll-guide-grid-2" style={{ marginTop: 12 }}>
          <div style={{ ...card, padding: '14px 16px', background: 'rgba(5,150,105,0.05)', border: '1px solid rgba(5,150,105,0.25)' }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: GREEN }}>Unused available credits do not expire.</div>
            <div style={{ fontSize: 12.5, color: '#3D4455', marginTop: 4, lineHeight: 1.55 }}>
              They carry forward month after month until you use them. Only <em>pending</em> credits of a month that closes below target lapse.
            </div>
          </div>
          <div style={{ ...card, padding: '14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Lock size={15} color={ACCENT} aria-hidden="true" />
              <span style={{ fontSize: 13.5, fontWeight: 700, color: colors.primary }}>Old transactions keep their original values</span>
            </div>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12.5, color: '#3D4455', lineHeight: 1.6 }}>
              <li>A payroll application made at {value} per credit stays at that rate even if the setting changes later.</li>
              <li>A day covered for {formatCredits(s.half_day_redemption_credits)} stays {formatCredits(s.half_day_redemption_credits)} in your history.</li>
              <li>Regenerating payroll never re-prices credits already applied.</li>
            </ul>
          </div>
        </div>

        {/* ── Cancellation ───────────────────────────────────────────────── */}
        <SectionHeading id="cancel" title="If a review is cancelled" note="Sometimes a review turns out not to count. Only that review's own credit is affected." />
        <div style={{ ...card, padding: '14px 16px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: 12 }}>
            <div style={{ display: 'flex', gap: 10 }}>
              <Undo2 size={16} color={AMBER} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
              <div style={{ fontSize: 12.5, color: '#3D4455', lineHeight: 1.55 }}>
                <strong>Before the month closes:</strong> the credit comes off your ledger and the review no longer counts toward that month&rsquo;s target.
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <XCircle size={16} color={AMBER} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
              <div style={{ fontSize: 12.5, color: '#3D4455', lineHeight: 1.55 }}>
                <strong>After a month closed as completed:</strong> only that review&rsquo;s credit comes off. The month stays completed and nothing else you earned is touched.
              </div>
            </div>
          </div>
          <div style={{ fontSize: 11.5, color: colors.muted, marginTop: 10, lineHeight: 1.5 }}>
            Every change shows in your history as its own line, with a reason. Nothing is ever edited or deleted.
          </div>
        </div>

        {/* ── Rule book ──────────────────────────────────────────────────── */}
        <SectionHeading id="rules" title="The rule book" note="Everything BOE Credits does. If a rule is not here, credits do not do it." />
        <div style={card}>
          {[
            ['Earning',        `${reward} for every review a verifier confirms. The credit belongs to the month you submitted the review.`],
            ['Monthly target', `${target} verified ${target === 1 ? 'review' : 'reviews'} in a month. The target that applied when the month started is the one that counts, even if the setting changes later.`],
            ['Pending credits', 'A month’s review credits are pending — recorded but not spendable — until that month reaches the target.'],
            ['Available credits', 'Pending credits become available the moment the target is reached; any further review that month is available at once.'],
            ['Lapse',          'When an administrator closes a month that ended below target, only that month’s still-pending credits lapse — as one line in your history.'],
            ['Carry forward',  'Available credits never expire and are not reset at month end.'],
            ['Attendance',     `Cover a chargeable Half Day for ${formatCredits(s.half_day_redemption_credits)} or an Absent day for ${formatCredits(s.full_day_redemption_credits)}, from your payslip, before payroll is locked. If the day later stops being a deduction, the credits come back.`],
            ['Payroll',        `Add credits to a month’s salary at ${value} each, from your payslip, before payroll is locked. Change or remove them any time until then.`],
            ['Locked payroll', 'Once a month’s payroll is locked, its attendance coverage and salary addition are final.'],
            ['Historical values', 'Every redemption and payroll application keeps the price and rate it was made at.'],
            ['Cancellations',  'An invalid review’s credit is reversed on its own; a completed month is never reopened, and a lapsed month’s credit is never taken twice.'],
            ['Settings',       'An administrator sets the five numbers above. Changes apply to future actions only.'],
          ].map(([term, meaning], i) => (
            <div key={term} style={{ padding: '10px 16px', borderTop: i === 0 ? 'none' : '1px solid rgba(0,0,0,0.05)', display: 'grid', gridTemplateColumns: 'minmax(110px, 150px) 1fr', gap: 12 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: colors.primary }}>{term}</div>
              <div style={{ fontSize: 12.5, color: '#5B6474', lineHeight: 1.55 }}>{meaning}</div>
            </div>
          ))}
        </div>

        <div style={{ ...card, marginTop: 14, padding: '12px 16px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <BookOpen size={16} color={ACCENT} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
          <div style={{ fontSize: 12.5, color: '#3D4455', lineHeight: 1.55 }}>
            <strong>Need help?</strong> If a credit on your ledger looks wrong, raise it with your admin the same way you raise a
            payroll issue — from <Link href="/my-payroll" style={{ color: ACCENT }}>My Payroll</Link>, with <em>Raise Issue</em> on the month it concerns.
          </div>
        </div>
      </div>
    </AttendancePayrollLayout>
  )
}
