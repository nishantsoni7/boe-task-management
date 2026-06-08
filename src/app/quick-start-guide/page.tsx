'use client'

import { useRouter } from 'next/navigation'
import { Briefcase } from 'lucide-react'
import { colors, font } from '@/lib/tokens'

// ── Shared style helpers ──────────────────────────────────────────────────────

const card: React.CSSProperties = {
  background: colors.base,
  border: `1px solid ${colors.border}`,
  borderRadius: '12px',
  padding: '28px 32px',
  marginBottom: '16px',
  boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
}

const sectionTitle: React.CSSProperties = {
  fontFamily: font.display,
  fontSize: '15px',
  fontWeight: 700,
  color: colors.primary,
  letterSpacing: '-0.01em',
  marginBottom: '14px',
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
}

const sectionNumber: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  height: 24,
  borderRadius: '6px',
  background: '#1A2035',
  color: '#E8A030',
  fontSize: '11px',
  fontWeight: 800,
  flexShrink: 0,
}

const bodyText: React.CSSProperties = {
  fontSize: '13.5px',
  color: colors.secondary,
  lineHeight: 1.7,
}

const bulletList: React.CSSProperties = {
  margin: '0',
  paddingLeft: '18px',
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
}

const rule: React.CSSProperties = {
  fontSize: '13.5px',
  color: colors.secondary,
  lineHeight: 1.6,
  margin: 0,
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <span style={{
      display: 'inline-block',
      fontSize: '11.5px', fontWeight: 700,
      color, background: bg,
      borderRadius: '6px',
      padding: '2px 10px',
      marginRight: '4px',
      letterSpacing: '0.01em',
    }}>
      {label}
    </span>
  )
}

// ── Highlight box ─────────────────────────────────────────────────────────────

function Highlight({ children, accent = '#2563EB' }: { children: React.ReactNode; accent?: string }) {
  return (
    <div style={{
      borderLeft: `3px solid ${accent}`,
      background: `${accent}08`,
      borderRadius: '0 8px 8px 0',
      padding: '10px 14px',
      margin: '10px 0',
      fontSize: '13px',
      color: colors.secondary,
      lineHeight: 1.6,
    }}>
      {children}
    </div>
  )
}

// ── Example box ──────────────────────────────────────────────────────────────

function ExampleBox({ good, bad }: { good?: string; bad?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' }}>
      {good && (
        <div style={{
          background: '#F0FDF4', border: '1px solid #BBF7D0',
          borderRadius: '8px', padding: '10px 14px',
        }}>
          <span style={{ fontSize: '10.5px', fontWeight: 700, color: '#166534', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Good update
          </span>
          <div style={{ fontSize: '13px', color: '#166534', marginTop: '4px', lineHeight: 1.5 }}>
            {good}
          </div>
        </div>
      )}
      {bad && (
        <div style={{
          background: '#FEF2F2', border: '1px solid #FECACA',
          borderRadius: '8px', padding: '10px 14px',
        }}>
          <span style={{ fontSize: '10.5px', fontWeight: 700, color: '#991B1B', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Bad update
          </span>
          <div style={{ fontSize: '13px', color: '#991B1B', marginTop: '4px', lineHeight: 1.5 }}>
            {bad}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function QuickStartGuidePage() {
  const router = useRouter()

  return (
    <div style={{
      minHeight: '100vh',
      background: colors.void,
      padding: '0 0 80px',
    }}>

      {/* ── Sticky header ── */}
      <div style={{
        position: 'sticky',
        top: 0,
        zIndex: 10,
        background: colors.base,
        borderBottom: `1px solid ${colors.border}`,
        padding: '0 24px',
        height: '52px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: 26, height: 26, borderRadius: '7px',
            background: '#1A2035',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Briefcase size={12} color="#E8A030" strokeWidth={2} />
          </div>
          <span style={{ fontSize: '13px', fontWeight: 700, color: colors.primary, letterSpacing: '-0.01em' }}>
            Quick Start Guide
          </span>
          <span style={{
            fontSize: '10px', fontWeight: 700, color: colors.muted,
            background: colors.float, border: `1px solid ${colors.border}`,
            borderRadius: '999px', padding: '2px 8px', letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}>
            Version 1
          </span>
        </div>
        <button
          onClick={() => router.push('/dashboard')}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            fontSize: '12.5px', fontWeight: 600,
            color: colors.secondary,
            background: colors.float,
            border: `1px solid ${colors.border}`,
            borderRadius: '7px',
            padding: '6px 14px',
            cursor: 'pointer',
            transition: 'background 0.12s',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = colors.hover)}
          onMouseLeave={e => (e.currentTarget.style.background = colors.float)}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
          </svg>
          Back to Dashboard
        </button>
      </div>

      {/* ── Content ── */}
      <div style={{ maxWidth: '720px', margin: '0 auto', padding: '36px 24px 0' }}>

        {/* Hero */}
        <div style={{ marginBottom: '32px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', color: colors.muted, textTransform: 'uppercase', marginBottom: '8px' }}>
            BOE Internal Platform
          </div>
          <h1 style={{
            fontFamily: font.display,
            fontSize: '26px',
            fontWeight: 700,
            color: colors.primary,
            letterSpacing: '-0.02em',
            margin: '0 0 10px',
            lineHeight: 1.2,
          }}>
            BOE Task Management<br />Quick Start Guide
          </h1>
          <p style={{ margin: 0, fontSize: '14px', color: colors.tertiary, lineHeight: 1.65 }}>
            Version 1 guide for using tasks, updates, follow-ups, and daily work tracking correctly.
          </p>
        </div>

        {/* ── Section 1 ── */}
        <div style={card}>
          <div style={sectionTitle}>
            <span style={sectionNumber}>1</span>
            Why We Are Using This System
          </div>
          <ul style={bulletList}>
            {[
              'To avoid missed follow-ups',
              'To reduce WhatsApp confusion',
              'To make responsibility clear',
              'To track daily progress',
              'To help managers review work without asking repeatedly',
            ].map(item => (
              <li key={item} style={rule}>{item}</li>
            ))}
          </ul>
        </div>

        {/* ── Section 2 ── */}
        <div style={card}>
          <div style={sectionTitle}>
            <span style={sectionNumber}>2</span>
            What Every Task Must Have
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {[
              { label: 'Clear task title', desc: 'Short, specific, and descriptive.' },
              { label: 'Correct responsible person', desc: 'Assign only to the person doing the work.' },
              { label: 'Due date', desc: 'When the task must be completed.' },
              { label: 'Priority', desc: 'High, Medium, or Low.' },
              { label: 'Proper note with full context', desc: 'Enough detail so the person knows exactly what to do.' },
              { label: 'Attachments if needed', desc: 'Supporting files, images, or references.' },
            ].map(({ label, desc }) => (
              <div key={label} style={{
                display: 'flex', gap: '10px',
                padding: '10px 12px',
                background: colors.raised,
                borderRadius: '8px',
                border: `1px solid ${colors.border}`,
              }}>
                <span style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: '#E8A030', flexShrink: 0, marginTop: '6px',
                }} />
                <div>
                  <div style={{ fontSize: '13.5px', fontWeight: 600, color: colors.primary, lineHeight: 1.3 }}>{label}</div>
                  <div style={{ fontSize: '12.5px', color: colors.tertiary, marginTop: '2px' }}>{desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Section 3 ── */}
        <div style={card}>
          <div style={sectionTitle}>
            <span style={sectionNumber}>3</span>
            When You Receive a Task
          </div>
          <ol style={{ ...bulletList, paddingLeft: '20px' }}>
            {[
              'Open the task',
              'Read the full details',
              'Click Acknowledge',
              'Start work or update status',
              'Do not ignore assigned tasks',
            ].map((item, i) => (
              <li key={i} style={{ ...rule, fontWeight: item.startsWith('Do not') ? 600 : 400, color: item.startsWith('Do not') ? '#991B1B' : colors.secondary }}>
                {item}
              </li>
            ))}
          </ol>
        </div>

        {/* ── Section 4 ── */}
        <div style={card}>
          <div style={sectionTitle}>
            <span style={sectionNumber}>4</span>
            Task Status Meaning
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {[
              { label: 'Pending',    color: '#6B7280', bg: '#F3F4F6', desc: 'Task is assigned but not yet acknowledged.' },
              { label: 'Working',    color: '#1D4ED8', bg: '#EFF6FF', desc: 'Work has started.' },
              { label: 'Waiting On', color: '#92400E', bg: '#FFFBEB', desc: 'Work is paused because input is needed from someone else. Examples: client, vendor, design, purchase, production, management, transport.' },
              { label: 'Blocked',    color: '#991B1B', bg: '#FEF2F2', desc: 'Work cannot move forward because there is a serious issue that needs help or a decision.' },
              { label: 'Completed',  color: '#166534', bg: '#F0FDF4', desc: 'Task is fully done. Do not mark complete if only partially done.' },
            ].map(({ label, color, bg, desc }) => (
              <div key={label} style={{
                display: 'flex', alignItems: 'flex-start', gap: '12px',
                padding: '12px 14px',
                background: colors.raised,
                border: `1px solid ${colors.border}`,
                borderRadius: '8px',
              }}>
                <StatusBadge label={label} color={color} bg={bg} />
                <p style={{ ...bodyText, margin: 0, flex: 1 }}>{desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* ── Section 5 ── */}
        <div style={card}>
          <div style={sectionTitle}>
            <span style={sectionNumber}>5</span>
            Waiting On Rules
          </div>
          <p style={bodyText}>
            Use <strong>Waiting On</strong> when the task depends on another person, department, vendor, or client.
            Always mention who or what you are waiting for.
          </p>
          <Highlight accent="#92400E">
            <strong>Example:</strong> Waiting on client approval for final fabric shade.
          </Highlight>
        </div>

        {/* ── Section 6 ── */}
        <div style={card}>
          <div style={sectionTitle}>
            <span style={sectionNumber}>6</span>
            Blocked Rules
          </div>
          <p style={bodyText}>
            Use <strong>Blocked</strong> only when normal work cannot continue and management help is required.
          </p>
          <Highlight accent="#991B1B">
            <strong>Example:</strong> Production cannot start because final size and material are not confirmed.
          </Highlight>
        </div>

        {/* ── Section 7 ── */}
        <div style={card}>
          <div style={sectionTitle}>
            <span style={sectionNumber}>7</span>
            Daily Updates
          </div>
          <p style={{ ...bodyText, marginBottom: '10px' }}>
            Every active task should have a clear, meaningful update.
          </p>
          <ExampleBox
            good="Spoke to client. Waiting for final layout confirmation by tomorrow afternoon."
            bad={'Done\nOk\nIn process\nWill check'}
          />
        </div>

        {/* ── Section 8 ── */}
        <div style={card}>
          <div style={sectionTitle}>
            <span style={sectionNumber}>8</span>
            End-of-Day Work Log
          </div>
          <p style={{ ...bodyText, marginBottom: '12px' }}>
            Before leaving the office, every team member must check their task list and update:
          </p>
          <ul style={bulletList}>
            {[
              'What was completed today',
              'What is still pending',
              'What is waiting on someone else',
              'What needs manager help',
              'Any task that has no progress',
            ].map(item => (
              <li key={item} style={rule}>{item}</li>
            ))}
          </ul>
        </div>

        {/* ── Section 9 ── */}
        <div style={card}>
          <div style={sectionTitle}>
            <span style={sectionNumber}>9</span>
            Manager Review
          </div>
          <p style={{ ...bodyText, marginBottom: '12px' }}>
            Managers will regularly check:
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '8px' }}>
            {[
              'Tasks not acknowledged',
              'Overdue tasks',
              'Tasks with no update',
              'Waiting On tasks',
              'Blocked tasks',
              'End-of-day updates',
            ].map(item => (
              <div key={item} style={{
                background: colors.raised,
                border: `1px solid ${colors.border}`,
                borderRadius: '8px',
                padding: '9px 12px',
                fontSize: '13px',
                fontWeight: 500,
                color: colors.secondary,
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#E8A030', flexShrink: 0 }} />
                {item}
              </div>
            ))}
          </div>
        </div>

        {/* ── Section 10 ── */}
        <div style={{ ...card, borderLeft: '3px solid #E8A030', borderRadius: '0 12px 12px 12px' }}>
          <div style={sectionTitle}>
            <span style={sectionNumber}>10</span>
            Basic Rules for Everyone
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {[
              { text: 'Do not keep work only on WhatsApp',                     warn: true  },
              { text: 'Do not mark tasks complete without finishing the work',  warn: true  },
              { text: 'Do not leave tasks without updates',                     warn: true  },
              { text: 'Mention clear reasons when work is delayed',             warn: false },
              { text: 'Use the system daily',                                   warn: false },
              { text: 'Keep updates short but meaningful',                      warn: false },
            ].map(({ text, warn }) => (
              <div key={text} style={{
                display: 'flex', alignItems: 'center', gap: '10px',
                padding: '9px 12px',
                background: warn ? '#FEF2F2' : colors.raised,
                border: `1px solid ${warn ? '#FECACA' : colors.border}`,
                borderRadius: '8px',
                fontSize: '13.5px',
                fontWeight: warn ? 600 : 400,
                color: warn ? '#991B1B' : colors.secondary,
              }}>
                {warn
                  ? <span style={{ fontSize: '14px', flexShrink: 0 }}>✕</span>
                  : <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#45A870', flexShrink: 0 }} />
                }
                {text}
              </div>
            ))}
          </div>
        </div>

        {/* ── Section 11 ── */}
        <div style={{ ...card, background: '#1A2035', border: 'none' }}>
          <div style={{ ...sectionTitle, color: '#fff' }}>
            <span style={{ ...sectionNumber, background: '#E8A030', color: '#1A2035' }}>11</span>
            Launch Week Focus
          </div>
          <p style={{ ...bodyText, color: 'rgba(255,255,255,0.65)', marginBottom: '16px' }}>
            For the first week, we will focus on only these core features:
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '8px' }}>
            {[
              'Task creation',
              'Task assignment',
              'Acknowledgement',
              'Status updates',
              'Waiting On',
              'Blocked',
              'Daily updates',
              'Manager review',
            ].map(item => (
              <div key={item} style={{
                background: 'rgba(232,160,48,0.1)',
                border: '1px solid rgba(232,160,48,0.2)',
                borderRadius: '8px',
                padding: '9px 12px',
                fontSize: '13px',
                fontWeight: 500,
                color: '#E8A030',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#E8A030', flexShrink: 0 }} />
                {item}
              </div>
            ))}
          </div>
        </div>

        {/* ── Bottom CTA ── */}
        <div style={{ textAlign: 'center', marginTop: '32px' }}>
          <button
            onClick={() => router.push('/dashboard')}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '8px',
              fontSize: '13.5px', fontWeight: 600,
              color: '#fff',
              background: '#1A2035',
              border: 'none',
              borderRadius: '9px',
              padding: '11px 24px',
              cursor: 'pointer',
              transition: 'opacity 0.15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
          >
            Go to Dashboard
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
            </svg>
          </button>
          <p style={{ fontSize: '12px', color: colors.muted, marginTop: '12px' }}>
            BOE Internal Platform — Version 1
          </p>
        </div>

      </div>
    </div>
  )
}
