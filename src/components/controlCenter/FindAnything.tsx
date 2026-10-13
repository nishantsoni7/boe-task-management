'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Search, ArrowRight, User, Building2 } from 'lucide-react'
import { useAdminMembers, useDepartments } from '@/hooks/queries/useControlCenterData'
import { MAIN_PATH, NAV_SECTIONS, searchSections } from '@/lib/controlCenter/navModel'
import cc from './controlCenter.module.css'

// "Find anything" — one box that reaches every screen, every employee and every
// department in the Control Center.
//
// It exists because an administrator who does not know which group a setting
// lives in should not have to learn the map first. Typing "password", "next
// order number", "delete test order" or somebody's name lands on the right
// screen (or the right person's record) in two keystrokes. With nothing typed
// it doubles as the full directory.
//
// Employees and departments come from the same cached lists the rest of the
// Control Center reads, and are only requested once the box is first opened
// (this component mounts on open, not with the shell).

type Hit = {
  key: string
  group: 'Go to' | 'People' | 'Departments'
  label: string
  sub?: string
  hub?: string
  href: string
  icon: 'arrow' | 'user' | 'dept'
}

const MAX_PEOPLE = 6

export function FindAnything({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const members = useAdminMembers().data
  const depts = useDepartments().data
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const activeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const hits = useMemo<Hit[]>(() => {
    const q = query.trim().toLowerCase()
    const deptName = (key: string | null | undefined) =>
      depts?.find(d => d.department_key === key)?.department_name

    const screens = (q ? searchSections(q) : [...NAV_SECTIONS]).map<Hit>(s => ({
      key: `s:${s.id}`, group: 'Go to', label: s.label, sub: s.description, hub: s.hub.label,
      href: s.href, icon: 'arrow',
    }))
    if (!q) return screens

    const words = q.split(/\s+/)
    const people = (members ?? [])
      .filter(m => !m.is_deleted)
      .filter(m => {
        const hay = `${m.full_name ?? ''} ${m.email ?? ''}`.toLowerCase()
        return words.every(w => hay.includes(w))
      })
      .slice(0, MAX_PEOPLE)
      .map<Hit>(m => ({
        key: `p:${m.id}`, group: 'People', label: m.full_name ?? m.email ?? 'Unnamed',
        sub: [m.email, deptName(m.team), m.is_active ? null : 'Inactive'].filter(Boolean).join(' · '),
        href: `${MAIN_PATH}/people?member=${m.id}`, icon: 'user',
      }))

    const departments = (depts ?? [])
      .filter(d => words.every(w => d.department_name.toLowerCase().includes(w)))
      .map<Hit>(d => ({
        key: `d:${d.department_key}`, group: 'Departments', label: d.department_name,
        sub: d.is_active ? 'Active department' : 'Inactive department',
        href: `${MAIN_PATH}?tab=departments`, icon: 'dept',
      }))

    // Screens first when the words name one; people first when they name a
    // person and no screen. A name rarely matches both.
    return screens.length > 0 && people.length === 0 ? [...screens, ...departments]
      : [...people, ...screens, ...departments]
  }, [query, members, depts])

  useEffect(() => { activeRef.current?.scrollIntoView({ block: 'nearest' }) }, [cursor])

  function go(hit: Hit | undefined) {
    if (!hit) return
    onClose()
    router.push(hit.href)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, hits.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); go(hits[cursor]) }
  }

  return (
    <div className={cc.findOverlay} onClick={onClose}>
      <div
        className={cc.findBox}
        role="dialog"
        aria-modal="true"
        aria-label="Find anything in the Control Center"
        onClick={e => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className={cc.findInputRow}>
          <Search size={16} strokeWidth={2} />
          <input
            ref={inputRef}
            className={cc.findInput}
            placeholder="Find a screen, a person or a department…"
            aria-label="Find anything"
            value={query}
            onChange={e => { setQuery(e.target.value); setCursor(0) }}
          />
          <span className={cc.kbd}>Esc</span>
        </div>

        <div className={cc.findList} role="listbox">
          {hits.length === 0 ? (
            <div className={cc.findEmpty}>
              Nothing matches “{query}”. Try a person’s name, or a word like “password”, “access” or “order number”.
            </div>
          ) : hits.map((hit, i) => (
            <div key={hit.key}>
              {(i === 0 || hits[i - 1].group !== hit.group) && <div className={cc.findGroup}>{hit.group}</div>}
              <button
                ref={i === cursor ? activeRef : undefined}
                role="option"
                aria-selected={i === cursor}
                className={`${cc.findRow}${i === cursor ? ` ${cc.findRowActive}` : ''}`}
                onMouseMove={() => setCursor(i)}
                onClick={() => go(hit)}
              >
                {hit.icon === 'user' ? <User size={15} /> : hit.icon === 'dept' ? <Building2 size={15} /> : <ArrowRight size={15} />}
                <span className={cc.findRowMain}>
                  <div className={cc.findRowLabel}>{hit.label}</div>
                  {hit.sub && <div className={cc.findRowSub}>{hit.sub}</div>}
                </span>
                {hit.hub && <span className={cc.findRowHub}>{hit.hub}</span>}
              </button>
            </div>
          ))}
        </div>

        <div className={cc.findFoot}>
          <span><span className={cc.kbd}>↑</span> <span className={cc.kbd}>↓</span> move</span>
          <span><span className={cc.kbd}>Enter</span> open</span>
        </div>
      </div>
    </div>
  )
}
