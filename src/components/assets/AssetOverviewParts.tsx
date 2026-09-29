'use client'

import { useMemo, useState } from 'react'
import { colors } from '@/lib/tokens'
import type {
  AssetSummary,
  AttentionGroup,
  CategoryCounts,
  PersonHoldings,
} from '@/lib/assets/overview'

// The pieces of the owner's Asset overview that are not the asset table
// itself: the four counts, the lens switch, and the three lenses that are not
// a flat list. Each lens is a DIFFERENT QUESTION about the same rows — none of
// them repeats the table; each one drills into it with a filter.

export type OverviewLens = 'list' | 'attention' | 'people' | 'categories'

// ─── Counts ──────────────────────────────────────────────────────────────────

/**
 * Four numbers, each a button that shows the rows behind it. Deliberately
 * compact: an owner reads them in one glance, and a tile that cannot be
 * opened is decoration.
 */
export function OverviewCounts({ summary, onOpen, isMobile }: {
  summary: AssetSummary
  onOpen: (target: 'active' | 'assigned' | 'available' | 'attention') => void
  isMobile?: boolean
}) {
  const tiles: { key: 'active' | 'assigned' | 'available' | 'attention'; label: string; value: number; hint?: string; alert?: boolean }[] = [
    {
      key: 'active', label: 'Active assets', value: summary.active,
      hint: summary.outOfService > 0 ? `${summary.outOfService} retired not counted` : undefined,
    },
    { key: 'assigned',  label: 'Assigned',  value: summary.assigned },
    { key: 'available', label: 'Available', value: summary.available },
    { key: 'attention', label: 'Needs attention', value: summary.needsAttention, alert: summary.needsAttention > 0 },
  ]
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: isMobile ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))',
      gap: '10px',
    }}>
      {tiles.map(t => (
        <button
          key={t.key}
          className="boe-card"
          onClick={() => onOpen(t.key)}
          style={{
            padding: isMobile ? '10px 12px' : '12px 16px', textAlign: 'left', cursor: 'pointer',
            border: `1px solid ${t.alert ? 'rgba(217,79,79,0.35)' : colors.border}`,
            display: 'flex', flexDirection: 'column', gap: '2px', font: 'inherit',
          }}
        >
          <span style={{ fontSize: '11px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {t.label}
          </span>
          <span style={{ fontSize: isMobile ? '20px' : '22px', fontWeight: 700, color: t.alert ? '#C13030' : colors.primary, lineHeight: 1.2 }}>
            {t.value}
          </span>
          {t.hint && <span style={{ fontSize: '10.5px', color: colors.muted }}>{t.hint}</span>}
        </button>
      ))}
    </div>
  )
}

// ─── Lens switch ─────────────────────────────────────────────────────────────

export function LensTabs({ lens, onChange, attentionCount, peopleCount }: {
  lens: OverviewLens
  onChange: (lens: OverviewLens) => void
  attentionCount: number
  peopleCount: number
}) {
  const tabs: { key: OverviewLens; label: string }[] = [
    { key: 'list',       label: 'All assets' },
    { key: 'attention',  label: `Needs attention${attentionCount ? ` (${attentionCount})` : ''}` },
    { key: 'people',     label: `By person${peopleCount ? ` (${peopleCount})` : ''}` },
    { key: 'categories', label: 'By category' },
  ]
  return (
    <div role="tablist" aria-label="Asset views" style={{
      display: 'flex', gap: '4px', overflowX: 'auto', borderBottom: `1px solid ${colors.border}`,
      scrollbarWidth: 'none',
    }}>
      {tabs.map(t => {
        const active = lens === t.key
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.key)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap',
              padding: '8px 12px', fontSize: '12.5px', font: 'inherit',
              fontWeight: active ? 600 : 500,
              color: active ? colors.primary : colors.muted,
              borderBottom: `2px solid ${active ? '#DC1F2E' : 'transparent'}`,
              marginBottom: '-1px',
            }}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

function Empty({ message }: { message: string }) {
  return (
    <div className="boe-card" style={{ padding: '28px', textAlign: 'center', fontSize: '12px', color: colors.muted }}>
      {message}
    </div>
  )
}

// ─── Needs attention ─────────────────────────────────────────────────────────

const ATTENTION_TONE: Record<string, string> = {
  custody_mismatch:    'boe-badge-urgent',
  lost:                'boe-badge-urgent',
  awaiting_acceptance: 'boe-badge-pending',
  under_repair:        'boe-badge-pending',
  poor_condition:      'boe-badge-pending',
  warranty_expiring:   'boe-badge-pending',
}

/**
 * One row per asset, with every reason it is here. Each row opens that asset,
 * where the action that clears it lives.
 */
export function AttentionList({ groups, onOpenAsset, catalogueLine }: {
  groups: readonly AttentionGroup[]
  onOpenAsset: (assetId: string) => void
  catalogueLine: (group: AttentionGroup) => string
}) {
  if (groups.length === 0) {
    return <Empty message="Nothing needs attention. Every handover is accepted and no asset is lost, under repair or in poor condition." />
  }
  return (
    <div className="boe-card" style={{ overflow: 'hidden' }}>
      {groups.map((g, i) => (
        <div key={g.row.asset.id} style={{
          display: 'flex', alignItems: 'center', gap: '12px', padding: '11px 16px',
          borderTop: i === 0 ? 'none' : `1px solid ${colors.border}`, flexWrap: 'wrap',
        }}>
          <div style={{ flex: '1 1 240px', minWidth: 0 }}>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '4px' }}>
              {g.items.map(item => (
                <span key={item.reason} className={`boe-badge ${ATTENTION_TONE[item.reason] ?? 'boe-badge-pending'}`}
                  style={{ fontSize: '10px', whiteSpace: 'nowrap' }}>
                  {item.label}
                </span>
              ))}
            </div>
            <div style={{ fontSize: '13px', fontWeight: 600, color: colors.primary }}>
              {g.row.asset.asset_name}
              <span style={{ fontWeight: 400, color: colors.muted, fontFamily: 'monospace', fontSize: '11px', marginLeft: '8px' }}>
                {g.row.asset.asset_code}
              </span>
            </div>
            <div style={{ fontSize: '11.5px', color: colors.muted, marginTop: '1px' }}>
              {catalogueLine(g)} · {g.row.holderLabel}
            </div>
            {g.items.map(item => (
              <div key={item.reason} style={{ fontSize: '11.5px', color: colors.secondary, marginTop: '2px' }}>
                {item.detail}
              </div>
            ))}
          </div>
          <button
            className="boe-btn boe-btn-ghost"
            style={{ padding: '4px 12px', fontSize: '11.5px', flexShrink: 0 }}
            onClick={() => onOpenAsset(g.row.asset.id)}
          >
            Open
          </button>
        </div>
      ))}
    </div>
  )
}

// ─── By person ───────────────────────────────────────────────────────────────

export function PeopleList({ people, onSelect }: {
  people: readonly PersonHoldings[]
  /** Show that person's assets in the list. */
  onSelect: (employeeId: string) => void
}) {
  const [query, setQuery] = useState('')
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? people.filter(p => p.name.toLowerCase().includes(q)) : people
  }, [people, query])

  if (people.length === 0) return <Empty message="Nobody holds an asset at the moment." />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {people.length > 6 && (
        <input
          className="boe-input"
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Find a person"
          aria-label="Find a person"
          style={{ maxWidth: '320px', fontSize: '13px' }}
        />
      )}
      {shown.length === 0 ? <Empty message="No one by that name holds an asset." /> : (
        <div className="boe-card" style={{ overflow: 'hidden' }}>
          {shown.map((p, i) => (
            <button
              key={p.employeeId}
              onClick={() => onSelect(p.employeeId)}
              style={{
                display: 'flex', alignItems: 'center', gap: '12px', width: '100%', textAlign: 'left',
                padding: '11px 16px', background: 'none', border: 'none', cursor: 'pointer', font: 'inherit',
                borderTop: i === 0 ? 'none' : `1px solid ${colors.border}`,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: colors.primary }}>{p.name}</div>
                <div style={{ fontSize: '11.5px', color: colors.muted, marginTop: '1px' }}>
                  {p.categories.map(c => c.count > 1 ? `${c.name} ×${c.count}` : c.name).join(' · ')}
                </div>
              </div>
              {p.awaitingAcceptance > 0 && (
                <span className="boe-badge boe-badge-pending" style={{ fontSize: '10px', whiteSpace: 'nowrap' }}>
                  {p.awaitingAcceptance} not accepted
                </span>
              )}
              <span style={{ fontSize: '15px', fontWeight: 700, color: colors.primary, minWidth: '24px', textAlign: 'right' }}>
                {p.total}
              </span>
              <span aria-hidden style={{ color: colors.muted }}>›</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── By category ─────────────────────────────────────────────────────────────

/**
 * Counts by status, every number a link to exactly those rows. Columns add up
 * to the total, so nothing is hidden between them.
 */
export function CategoryCountsTable({ rows, onSelect, isMobile }: {
  rows: readonly CategoryCounts[]
  onSelect: (categoryKey: string, status?: 'assigned' | 'available') => void
  isMobile?: boolean
}) {
  if (rows.length === 0) return <Empty message="No assets recorded yet." />

  const Num = ({ n, onClick, strong }: { n: number; onClick?: () => void; strong?: boolean }) =>
    n === 0 || !onClick
      ? <span style={{ color: n === 0 ? colors.muted : colors.secondary }}>{n}</span>
      : (
        <button onClick={onClick} style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit',
          color: colors.primary, fontWeight: strong ? 700 : 600, textDecoration: 'underline',
          textUnderlineOffset: '3px', textDecorationColor: colors.border,
        }}>{n}</button>
      )

  if (isMobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {rows.map(c => (
          <div key={c.categoryKey} className="boe-card" style={{ padding: '12px 14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
              <button onClick={() => onSelect(c.categoryKey)} style={{
                background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit',
                fontWeight: 600, fontSize: '13.5px', color: colors.primary, textAlign: 'left',
              }}>{c.name}</button>
              <span style={{ fontSize: '15px', fontWeight: 700, color: colors.primary }}>{c.total}</span>
            </div>
            <div style={{ display: 'flex', gap: '14px', marginTop: '6px', fontSize: '12px', color: colors.muted, flexWrap: 'wrap' }}>
              <span>Assigned <Num n={c.assigned} onClick={() => onSelect(c.categoryKey, 'assigned')} /></span>
              <span>Available <Num n={c.available} onClick={() => onSelect(c.categoryKey, 'available')} /></span>
              {c.other > 0 && <span>Repair / lost <Num n={c.other} /></span>}
              {c.outOfService > 0 && <span>Retired <Num n={c.outOfService} /></span>}
            </div>
          </div>
        ))}
      </div>
    )
  }

  const th = (label: string, align: 'left' | 'right' = 'right') => (
    <th style={{
      padding: '10px 16px', textAlign: align, fontSize: '11px', fontWeight: 600, color: colors.muted,
      textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
    }}>{label}</th>
  )
  const td = { padding: '10px 16px', textAlign: 'right' as const }

  return (
    <div className="boe-card" style={{ overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ background: colors.raised, borderBottom: `1px solid ${colors.border}` }}>
              {th('Category', 'left')}{th('Total')}{th('Assigned')}{th('Available')}{th('Repair / Lost')}{th('Retired')}
            </tr>
          </thead>
          <tbody>
            {rows.map(c => (
              <tr key={c.categoryKey} style={{ borderBottom: `1px solid ${colors.border}` }}>
                <td style={{ padding: '10px 16px' }}>
                  <button onClick={() => onSelect(c.categoryKey)} style={{
                    background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit',
                    fontWeight: 600, color: colors.primary, textAlign: 'left',
                  }}>{c.name}</button>
                </td>
                <td style={td}><Num n={c.total} onClick={() => onSelect(c.categoryKey)} strong /></td>
                <td style={td}><Num n={c.assigned} onClick={() => onSelect(c.categoryKey, 'assigned')} /></td>
                <td style={td}><Num n={c.available} onClick={() => onSelect(c.categoryKey, 'available')} /></td>
                <td style={td}><Num n={c.other} /></td>
                <td style={td}><Num n={c.outOfService} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
