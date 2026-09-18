'use client'

// How Meetings Work — the guide's content, without the module shell.
//
// Split from page.tsx so the page owns exactly two things — the Meetings shell
// and the signed-in user — and this owns everything a reader sees. The content
// reads no data and needs no session, which is what lets the guide be rendered
// and reviewed on its own. See page.tsx for where it lives and who may see it.

// RESPONSIVENESS AND ACCESSIBILITY
// --------------------------------
// The diagrams are CSS grids, never SVG or fixed-width canvases — see the
// MEETINGS block in globals.css. Every one of them has a text equivalent that is
// part of the page rather than a tooltip, every state is named as well as
// coloured, the headings run h1 → h2 → h3 with nothing skipped, and each arrow
// and marker is aria-hidden because the words beside it already say the same
// thing.


import { Fragment, useState } from 'react'
import {
  AlertTriangle, ArrowLeft, ArrowRight, CalendarCheck, CheckCircle2, ClipboardList,
  Inbox, ListChecks, MessageSquare, RotateCcw, Users,
} from 'lucide-react'
import { MeetingBadge } from '@/components/meetings/MeetingModal'
import { colors } from '@/lib/tokens'
import {
  AFTER_SALES_TAG_LABEL, DISCUSSION_CATEGORY_META, DISCUSSION_STATE_META,
} from '@/lib/meetings/discussion'
import {
  AFTER_SALES_TAG_NOTE, CAPTURE_FLOW, CAPTURE_NOTES, CATEGORY_CARDS,
  CATEGORY_DIVIDING_LINE, COMPLETION_CHECKLIST, FAQS, LIFECYCLE, LIFECYCLE_BRANCHES,
  MEETINGS_VS_TASKS, MEETINGS_VS_TASKS_RULE, MULTI_MEETING_EXAMPLE,
  MULTI_MEETING_NOTE, PHASES, PURPOSE_NODES, SECTIONS,
  type Phase,
} from './guideContent'

/** One tone per phase, from the existing BOE palette. */
const PHASE_TONE: Record<Phase['id'], { bg: string; border: string; color: string }> = {
  before: { bg: '#EFF6FF', border: '#BFDBFE', color: '#1E40AF' },
  during: { bg: '#F5F3FF', border: '#DDD6FE', color: '#5B21B6' },
  after:  { bg: '#F0FDF4', border: '#BBF7D0', color: '#166534' },
}

export function MeetingGuide({ onBack }: { onBack: () => void }) {
  return (
    <div style={{ maxWidth: 1180 }}>
      {/* The shell prints the page title as a styled div, so the document has
          no h1 of its own. Supplying one here — hidden, because it would
          otherwise be the same words twice — puts the section h2s under a
          heading rather than starting the outline at level 2. */}
      <h1 className="meeting-guide-sr-only">How Meetings Work</h1>

      <Hero onBack={onBack} />

      <nav aria-label="Sections of this guide" style={{
        display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '14px',
      }}>
        {SECTIONS.map(section => (
          <a key={section.id} href={`#${section.id}`} className="meeting-guide-jump">
            {section.title}
          </a>
        ))}
      </nav>

      {/* ── 1 ─────────────────────────────────────────────────────────── */}
      <SectionHeading
        id="purpose"
        title="What Meetings is for"
        note="One place for the discussions that decide what happens to an order."
      />
      <PurposeMap />

      {/* ── 2 ─────────────────────────────────────────────────────────── */}
      <SectionHeading
        id="phases"
        title="Before, during and after"
        note="The record is written while the meeting happens, not typed up afterwards."
      />
      <div className="meeting-guide-phases">
        {PHASES.map(phase => <PhaseCard key={phase.id} phase={phase} />)}
      </div>

      {/* ── 3 ─────────────────────────────────────────────────────────── */}
      <SectionHeading
        id="categories"
        title="The two order categories"
        note="Every order-related discussion item is one of exactly two things."
      />
      <div className="meeting-guide-grid-2">
        {CATEGORY_CARDS.map(card => <CategoryCardView key={card.category} card={card} />)}
      </div>
      <Note>{CATEGORY_DIVIDING_LINE}</Note>
      <Note>{AFTER_SALES_TAG_NOTE}</Note>

      {/* ── 4 ─────────────────────────────────────────────────────────── */}
      <SectionHeading
        id="capture"
        title="Adding an issue from a task"
        note="Five steps, a few taps, and the task is left exactly as it was."
      />
      <CaptureFlow />
      <ul style={LIST_STYLE}>
        {CAPTURE_NOTES.map(note => (
          <li key={note} style={LIST_ITEM_STYLE}>{note}</li>
        ))}
      </ul>

      {/* ── 5 ─────────────────────────────────────────────────────────── */}
      <SectionHeading
        id="lifecycle"
        title="The life of an issue"
        note="An issue is written down once and keeps that identity for the rest of its life."
      />
      <LifecycleFlow />
      <div className="meeting-guide-grid-3" style={{ marginTop: '10px' }}>
        {LIFECYCLE_BRANCHES.map(branch => (
          <BranchCard key={branch.id} branch={branch} />
        ))}
      </div>

      {/* ── 6 ─────────────────────────────────────────────────────────── */}
      <SectionHeading
        id="example"
        title="The same issue across four meetings"
        note="An example, so the carry-forward can be followed end to end."
      />
      <MultiMeetingTimeline />
      <Note tone="warning">{MULTI_MEETING_NOTE}</Note>

      {/* ── 7 ─────────────────────────────────────────────────────────── */}
      <SectionHeading
        id="vs-tasks"
        title="Meetings and Tasks"
        note="Two modules, two different questions. Neither one closes the other."
      />
      <div className="meeting-guide-compare">
        {MEETINGS_VS_TASKS.map(side => (
          <div key={side.id} style={{
            background: colors.base, border: `1px solid ${colors.border}`,
            borderRadius: '10px', padding: '13px 15px',
          }}>
            <h3 style={{ ...H3_STYLE, display: 'flex', alignItems: 'center', gap: '7px' }}>
              {side.id === 'meetings'
                ? <MessageSquare size={14} strokeWidth={1.9} color={colors.blue} aria-hidden="true" />
                : <ListChecks size={14} strokeWidth={1.9} color={colors.green} aria-hidden="true" />}
              {side.label}
            </h3>
            <ul style={{ ...LIST_STYLE, marginTop: '7px' }}>
              {side.answers.map(answer => (
                <li key={answer} style={LIST_ITEM_STYLE}>{answer}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div style={{
        marginTop: '10px', padding: '11px 14px', borderRadius: '9px',
        background: colors.amberTint, border: '1px solid rgba(232,160,48,0.28)',
      }}>
        {MEETINGS_VS_TASKS_RULE.map(rule => (
          <p key={rule} style={{
            margin: 0, fontSize: '12.5px', fontWeight: 600, color: '#8A5A12', lineHeight: 1.6,
          }}>
            {rule}
          </p>
        ))}
      </div>

      {/* ── 8 ─────────────────────────────────────────────────────────── */}
      <SectionHeading
        id="checklist"
        title="Before you complete a meeting"
        note="Six things worth a glance. None of them is enforced — they are what makes the record usable next month."
      />
      <div style={{
        background: colors.base, border: `1px solid ${colors.border}`,
        borderRadius: '10px', padding: '6px 4px',
      }}>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {COMPLETION_CHECKLIST.map((line, index) => (
            <li key={line} style={{
              display: 'flex', alignItems: 'flex-start', gap: '9px',
              padding: '9px 13px',
              borderTop: index === 0 ? 'none' : `1px solid ${colors.border}`,
            }}>
              <CheckCircle2
                size={14}
                strokeWidth={2}
                color={colors.green}
                aria-hidden="true"
                style={{ flexShrink: 0, marginTop: '2px' }}
              />
              <span style={{ fontSize: '12.5px', color: colors.secondary, lineHeight: 1.55 }}>{line}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* ── 9 ─────────────────────────────────────────────────────────── */}
      <SectionHeading
        id="faq"
        title="Questions"
        note="The nine asked most often."
      />
      <Faqs />

      <div style={{ display: 'flex', marginTop: '18px' }}>
        <button
          onClick={() => onBack()}
          className="boe-btn boe-btn-ghost meeting-guide-link"
          style={{ padding: '8px 15px', fontSize: '12.5px', display: 'flex', alignItems: 'center', gap: '6px' }}
        >
          <ArrowLeft size={14} strokeWidth={2}  aria-hidden="true" /> Back to Meetings
        </button>
      </div>
    </div>
  )
}

// ─── Shared pieces ────────────────────────────────────────────────────────────

const H3_STYLE: React.CSSProperties = {
  margin: 0, fontSize: '13.5px', fontWeight: 700, color: colors.primary, letterSpacing: '-0.01em',
}

const LIST_STYLE: React.CSSProperties = {
  margin: '10px 0 0', paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '5px',
}

const LIST_ITEM_STYLE: React.CSSProperties = {
  fontSize: '12.5px', color: colors.secondary, lineHeight: 1.55,
}

function Hero({ onBack }: { onBack: () => void }) {
  return (
    <section style={{
      background: colors.base, border: `1px solid ${colors.border}`,
      borderRadius: '12px', padding: '16px 18px',
    }}>
      <p style={{ margin: 0, fontSize: '13.5px', color: colors.secondary, lineHeight: 1.65, maxWidth: 780 }}>
        A meeting in BOE is a dated record of a conversation about orders. You bring the things that
        need discussing, record what was said and decided as you go, and hand anything that needs
        doing to Tasks. Anything you do not finish comes back on its own next time — you do not have
        to remember it, and it cannot quietly disappear.
      </p>
      <p style={{ margin: '10px 0 0', fontSize: '12px', color: colors.muted, lineHeight: 1.6, maxWidth: 780 }}>
        This page explains the whole module. It shows no meeting and no order of its own, so
        everybody who can open Meetings can read it.
      </p>
      <button
        onClick={onBack}
        className="boe-btn boe-btn-ghost meeting-guide-link"
        style={{ marginTop: '12px', padding: '7px 13px', fontSize: '12.5px', display: 'flex', alignItems: 'center', gap: '5px' }}
      >
        <ArrowLeft size={13} strokeWidth={2}  aria-hidden="true" /> Back to Meetings
      </button>
    </section>
  )
}

function SectionHeading({ id, title, note }: { id: string; title: string; note: string }) {
  return (
    <div style={{ marginTop: '22px', marginBottom: '10px' }}>
      <h2 id={id} style={{
        margin: 0, fontSize: '15px', fontWeight: 700, color: colors.primary,
        letterSpacing: '-0.01em', scrollMarginTop: '80px',
      }}>
        {title}
      </h2>
      <p style={{ margin: '3px 0 0', fontSize: '12px', color: colors.muted, lineHeight: 1.55 }}>
        {note}
      </p>
    </div>
  )
}

function Note({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'warning' }) {
  const warning = tone === 'warning'
  return (
    <p style={{
      margin: '10px 0 0', padding: '10px 13px', borderRadius: '9px',
      background: warning ? colors.amberTint : colors.raised,
      border: `1px solid ${warning ? 'rgba(232,160,48,0.28)' : colors.border}`,
      fontSize: '12.5px', color: warning ? '#8A5A12' : colors.secondary, lineHeight: 1.6,
    }}>
      {children}
    </p>
  )
}

// ─── 1. The purpose map ───────────────────────────────────────────────────────

/**
 * A mind map on desktop, a stack of cards on a phone — the same markup either
 * way, placed by the grid rules in globals.css.
 *
 * The text equivalent is not a tooltip and not an alt attribute: the hub and
 * every node are real text in the reading order, so the diagram works identically
 * for somebody using a screen reader and for somebody looking at it.
 */
function PurposeMap() {
  return (
    <div className="meeting-guide-map">
      <div className="meeting-guide-map-hub">
        <div style={{
          display: 'flex', alignItems: 'center', gap: '7px',
          fontSize: '14px', fontWeight: 800, color: '#B01824', letterSpacing: '-0.01em',
        }}>
          <Users size={15} strokeWidth={2} aria-hidden="true" />
          Meetings
        </div>
        <p style={{ margin: '5px 0 0', fontSize: '12px', color: colors.secondary, lineHeight: 1.55 }}>
          Everything around this box happens inside a meeting, and every one of them leaves a record
          somebody can read next month.
        </p>
      </div>
      {PURPOSE_NODES.map(node => (
        <div key={node.id} className="meeting-guide-map-node">
          <div style={{ fontSize: '12.5px', fontWeight: 700, color: colors.primary }}>{node.label}</div>
          <p style={{ margin: '2px 0 0', fontSize: '11.5px', color: colors.muted, lineHeight: 1.5 }}>
            {node.detail}
          </p>
        </div>
      ))}
    </div>
  )
}

// ─── 2. Phases ────────────────────────────────────────────────────────────────

function PhaseCard({ phase }: { phase: Phase }) {
  const tone = PHASE_TONE[phase.id]
  const Icon = phase.id === 'before' ? ClipboardList : phase.id === 'during' ? MessageSquare : CalendarCheck
  return (
    <section style={{
      background: tone.bg, border: `1px solid ${tone.border}`,
      borderRadius: '11px', padding: '13px 15px',
    }}>
      <h3 style={{ ...H3_STYLE, color: tone.color, display: 'flex', alignItems: 'center', gap: '7px' }}>
        <Icon size={14} strokeWidth={2} aria-hidden="true" />
        {phase.title}
      </h3>
      <p style={{ margin: '4px 0 0', fontSize: '12px', color: colors.secondary, lineHeight: 1.55 }}>
        {phase.summary}
      </p>
      <ol style={{ margin: '9px 0 0', paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '5px' }}>
        {phase.steps.map(step => (
          <li key={step} style={{ fontSize: '12.5px', color: colors.primary, lineHeight: 1.55 }}>{step}</li>
        ))}
      </ol>
    </section>
  )
}

// ─── 3. Categories ────────────────────────────────────────────────────────────

function CategoryCardView({ card }: { card: (typeof CATEGORY_CARDS)[number] }) {
  const meta = DISCUSSION_CATEGORY_META[card.category]
  return (
    <section style={{
      background: colors.base, border: `1px solid ${meta.border}`,
      borderLeft: `3px solid ${meta.color}`, borderRadius: '11px', padding: '13px 15px',
    }}>
      <h3 style={{ ...H3_STYLE, display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <MeetingBadge meta={meta} />
        <span className="meeting-guide-sr-only">{card.label}</span>
      </h3>
      <p style={{ margin: '7px 0 0', fontSize: '12.5px', color: colors.secondary, lineHeight: 1.6 }}>
        {card.when}
      </p>
      <div style={{
        fontSize: '11px', fontWeight: 700, color: colors.muted,
        textTransform: 'uppercase', letterSpacing: '0.07em', marginTop: '11px',
      }}>
        Typical items
      </div>
      <ul style={{ margin: '5px 0 0', paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
        {card.examples.map(example => (
          <li key={example} style={{ fontSize: '12.5px', color: colors.primary, lineHeight: 1.5 }}>{example}</li>
        ))}
      </ul>
      {card.tags.length > 0 && (
        <div style={{ marginTop: '11px', display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
          {card.tags.map(tag => (
            <span key={tag} style={{
              padding: '2px 8px', borderRadius: '5px', fontSize: '11px', fontWeight: 600,
              background: colors.raised, color: colors.secondary, border: `1px solid ${colors.border}`,
            }}>
              {AFTER_SALES_TAG_LABEL[tag]}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

// ─── 4. Capture flow ──────────────────────────────────────────────────────────

/**
 * Horizontal on a wide screen, a vertical timeline on a phone. The arrows are
 * aria-hidden: the steps are a numbered list either way, so the order is carried
 * by the numbers rather than by the arrow glyph.
 */
function CaptureFlow() {
  return (
    <div className="meeting-guide-flow">
      {CAPTURE_FLOW.map((step, index) => (
        <Fragment key={step.title}>
          {index > 0 && (
            <div className="meeting-guide-flow-arrow" aria-hidden="true">
              <ArrowRight size={15} strokeWidth={2}  aria-hidden="true" />
            </div>
          )}
          <div className="meeting-guide-flow-step">
            <div style={{
              fontSize: '11px', fontWeight: 700, color: colors.muted,
              textTransform: 'uppercase', letterSpacing: '0.07em',
            }}>
              Step {index + 1}
            </div>
            <div style={{ fontSize: '12.5px', fontWeight: 700, color: colors.primary, marginTop: '3px' }}>
              {step.title}
            </div>
            <p style={{ margin: '3px 0 0', fontSize: '11.5px', color: colors.muted, lineHeight: 1.5 }}>
              {step.detail}
            </p>
          </div>
        </Fragment>
      ))}
    </div>
  )
}

// ─── 5. Lifecycle ─────────────────────────────────────────────────────────────

function LifecycleFlow() {
  return (
    <div className="meeting-guide-flow">
      {LIFECYCLE.map((stage, index) => (
        <Fragment key={stage.id}>
          {index > 0 && (
            <div className="meeting-guide-flow-arrow" aria-hidden="true">
              <ArrowRight size={15} strokeWidth={2}  aria-hidden="true" />
            </div>
          )}
          <div className="meeting-guide-flow-step">
            <div style={{ fontSize: '12.5px', fontWeight: 700, color: colors.primary }}>{stage.label}</div>
            <p style={{ margin: '3px 0 0', fontSize: '11.5px', color: colors.muted, lineHeight: 1.5 }}>
              {stage.detail}
            </p>
          </div>
        </Fragment>
      ))}
    </div>
  )
}

function BranchCard({ branch }: { branch: (typeof LIFECYCLE_BRANCHES)[number] }) {
  const Icon = branch.id === 'resolved' ? CheckCircle2 : branch.id === 'reopened' ? RotateCcw : AlertTriangle
  const accent = branch.id === 'resolved' ? colors.green : branch.id === 'reopened' ? colors.blue : colors.amber
  return (
    <section style={{
      background: colors.base, border: `1px solid ${colors.border}`,
      borderTop: `2px solid ${accent}`, borderRadius: '10px', padding: '12px 14px',
    }}>
      <h3 style={{ ...H3_STYLE, fontSize: '13px', display: 'flex', alignItems: 'center', gap: '7px' }}>
        <Icon size={14} strokeWidth={2} color={accent} aria-hidden="true" />
        {branch.label}
      </h3>
      <ul style={{ ...LIST_STYLE, marginTop: '7px' }}>
        {branch.points.map(point => (
          <li key={point} style={LIST_ITEM_STYLE}>{point}</li>
        ))}
      </ul>
    </section>
  )
}

// ─── 6. Four meetings ─────────────────────────────────────────────────────────

function MultiMeetingTimeline() {
  return (
    <div className="meeting-guide-timeline">
      {MULTI_MEETING_EXAMPLE.map((entry, index) => {
        const last = index === MULTI_MEETING_EXAMPLE.length - 1
        return (
          <div key={entry.meeting} className="meeting-guide-timeline-row">
            <div className="meeting-guide-timeline-rail" aria-hidden="true">
              <span style={{
                width: 24, height: 24, borderRadius: 999, flexShrink: 0,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                background: entry.state === 'resolved' ? 'rgba(69,168,112,0.14)' : 'rgba(85,133,232,0.12)',
                color: entry.state === 'resolved' ? '#166534' : '#1E40AF',
                fontSize: '11px', fontWeight: 700,
              }}>
                {index + 1}
              </span>
              {!last && <span className="meeting-guide-timeline-line" />}
            </div>
            <div style={{ minWidth: 0, paddingBottom: last ? 0 : '14px' }}>
              <h3 style={{ ...H3_STYLE, fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                {entry.meeting}
                <MeetingBadge meta={DISCUSSION_STATE_META[entry.state]} />
              </h3>
              <div style={{
                marginTop: '5px', padding: '8px 11px', borderRadius: '8px',
                background: colors.raised, borderLeft: `2px solid ${colors.blue}`,
                fontSize: '12.5px', color: colors.primary, lineHeight: 1.5,
              }}>
                {entry.update}
              </div>
              <p style={{ margin: '4px 0 0', fontSize: '11.5px', color: colors.muted, lineHeight: 1.5 }}>
                {entry.note}
              </p>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── 9. Questions ─────────────────────────────────────────────────────────────

/**
 * Buttons with aria-expanded rather than <details>, matching how every other
 * collapsible section in this product behaves, and keyboard-operable for the same
 * reason. The first answer is open so the section never reads as an empty list.
 */
function Faqs() {
  const [open, setOpen] = useState<Set<number>>(new Set([0]))

  const toggle = (index: number) => setOpen(prev => {
    const next = new Set(prev)
    if (next.has(index)) next.delete(index)
    else next.add(index)
    return next
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
      {FAQS.map((faq, index) => {
        const expanded = open.has(index)
        return (
          <div key={faq.question} style={{
            background: colors.base, border: `1px solid ${colors.border}`,
            borderRadius: '10px', overflow: 'hidden',
          }}>
            <h3 style={{ margin: 0 }}>
              <button
                type="button"
                onClick={() => toggle(index)}
                aria-expanded={expanded}
                className="meeting-guide-link"
                style={{
                  width: '100%', textAlign: 'left', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: '9px',
                  padding: '11px 14px', minHeight: '44px',
                  background: 'transparent', border: 'none',
                  fontSize: '12.5px', fontWeight: 700, color: colors.primary,
                  fontFamily: 'inherit',
                }}
              >
                <span aria-hidden="true" style={{
                  flexShrink: 0, width: 16, textAlign: 'center',
                  color: colors.muted, fontWeight: 700,
                }}>
                  {expanded ? '−' : '+'}
                </span>
                {faq.question}
              </button>
            </h3>
            {expanded && (
              <p style={{
                margin: 0, padding: '0 14px 12px 39px',
                fontSize: '12.5px', color: colors.secondary, lineHeight: 1.6,
              }}>
                {faq.answer}
              </p>
            )}
          </div>
        )
      })}
      <p style={{
        margin: '4px 0 0', padding: '10px 13px', borderRadius: '9px',
        background: colors.raised, border: `1px solid ${colors.border}`,
        fontSize: '12px', color: colors.muted, lineHeight: 1.6,
        display: 'flex', alignItems: 'flex-start', gap: '8px',
      }}>
        <Inbox size={13} strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0, marginTop: '2px' }} />
        <span>
          Still not sure where something went? Open the item in the meeting — every update, decision,
          image and follow-up task on it is listed there with who recorded it and when.
        </span>
      </p>
    </div>
  )
}
