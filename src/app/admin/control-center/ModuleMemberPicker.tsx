'use client'

// Module Visibility → Custom: the member picker.
//
// One control, three states, no new screen: a search box, the chips for whoever
// is already selected, and a short filtered list to click. It lives beside the
// Allowed Departments checkbox list in the same modal and is deliberately the
// same size — granting a module to three people should cost the same number of
// clicks as granting it to three departments.
//
// It renders only what the caller hands it. Deciding which members are eligible
// (active, not deleted) belongs to the page that loads them and to
// /api/control-center/modules/[key], which re-validates the ids on save.

import { useMemo, useState } from 'react'

export type PickableMember = {
  id: string
  full_name: string | null
  email: string | null
  team: string | null
}

const MAX_VISIBLE = 8

export function ModuleMemberPicker({
  members,
  selectedIds,
  onToggle,
  onRemove,
}: {
  members: PickableMember[]
  selectedIds: string[]
  onToggle: (id: string) => void
  onRemove: (id: string) => void
}) {
  const [query, setQuery] = useState('')

  const byId = useMemo(
    () => new Map(members.map(m => [m.id, m])),
    [members],
  )

  // Selected first, so the chips above and the ticks below agree at a glance;
  // then the rest, capped, because this is a picker and not a directory.
  const matched = useMemo(() => {
    const q = query.trim().toLowerCase()
    const hit = (m: PickableMember) =>
      !q ||
      (m.full_name ?? '').toLowerCase().includes(q) ||
      (m.email ?? '').toLowerCase().includes(q) ||
      (m.team ?? '').toLowerCase().includes(q)
    return members.filter(hit)
  }, [members, query])

  const matches = useMemo(() => matched.slice(0, MAX_VISIBLE), [matched])
  /**
   * How many eligible people the cap is holding back.
   *
   * The cap itself is right — this is a picker, not a directory — but a SILENT
   * cap is not: somebody who cannot see a colleague in the list has no way to
   * tell whether the account is missing or merely further down, and concludes
   * the former. Saying so turns a dead end into a search.
   */
  const hidden = matched.length - matches.length

  const selected = selectedIds.map(id => byId.get(id)).filter((m): m is PickableMember => !!m)

  return (
    <>
      <label style={LABEL}>
        Members
        <span style={{ fontWeight: 400, color: '#8C94A6', marginLeft: 6 }}>
          {selected.length > 0 ? `${selected.length} selected` : 'none selected'}
        </span>
      </label>

      {/* Chips — the answer to "who has this?", readable without opening the list. */}
      {selected.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {selected.map(m => (
            <span
              key={m.id}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                background: '#F5F3FF', color: '#5B21B6',
                border: '1px solid #DDD6FE', borderRadius: 999,
                padding: '3px 6px 3px 10px', fontSize: 12.5, fontWeight: 600,
                maxWidth: '100%',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {m.full_name ?? m.email ?? m.id}
              </span>
              <button
                type="button"
                onClick={() => onRemove(m.id)}
                aria-label={`Remove ${m.full_name ?? m.email ?? 'member'}`}
                title="Remove"
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer',
                  color: '#7C5CD6', fontSize: 13, lineHeight: 1, padding: '0 2px',
                }}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <input
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Search members by name, email or department…"
        style={{ ...INPUT, marginBottom: 8 }}
      />

      <div style={{
        border: '1.5px solid #D1D5DB', borderRadius: 8,
        padding: '6px 8px', marginBottom: 8,
        maxHeight: 200, overflowY: 'auto',
      }}>
        {members.length === 0 ? (
          <div style={{ fontSize: 12.5, color: '#8C94A6', padding: '6px 4px' }}>No active members.</div>
        ) : matches.length === 0 ? (
          <div style={{ fontSize: 12.5, color: '#8C94A6', padding: '6px 4px' }}>
            No member matches “{query.trim()}”.
          </div>
        ) : (
          matches.map(m => {
            const isOn = selectedIds.includes(m.id)
            return (
              <label
                key={m.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9,
                  fontSize: 13, cursor: 'pointer', padding: '5px 4px', borderRadius: 6,
                  background: isOn ? '#FAF8FF' : 'transparent',
                }}
              >
                <input type="checkbox" checked={isOn} onChange={() => onToggle(m.id)} />
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.full_name ?? m.email ?? m.id}
                </span>
                {m.team && (
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: '#8C94A6', flexShrink: 0 }}>
                    {m.team}
                  </span>
                )}
              </label>
            )
          })
        )}

        {/* The cap, stated. Without this line a member beyond the eighth is
            indistinguishable from a member who does not exist. */}
        {hidden > 0 && (
          <div style={{ fontSize: 11.5, color: '#8C94A6', padding: '6px 4px 2px' }}>
            {hidden} more {hidden === 1 ? 'member' : 'members'} — type to narrow the list.
          </div>
        )}
      </div>

      <div style={{ fontSize: 11.5, color: '#8C94A6', marginBottom: 16 }}>
        {selected.length === 0
          ? 'No members selected — the module will be hidden from everyone except admins.'
          : `Only these ${selected.length === 1 ? 'member' : `${selected.length} members`} and admins can see and open the module.`}
      </div>
    </>
  )
}

// Matched to the modal's existing controls rather than imported, so this file
// stays a leaf the page can drop in without a circular import.
const LABEL: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 600,
  color: '#6B7384',
  marginBottom: 6,
}

const INPUT: React.CSSProperties = {
  width: '100%',
  padding: '9px 12px',
  fontSize: 13.5,
  border: '1.5px solid #D1D5DB',
  borderRadius: 8,
  outline: 'none',
  boxSizing: 'border-box',
}
