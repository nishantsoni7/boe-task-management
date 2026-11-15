'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AppLink as Link } from '@/components/ui/AppLink'
import { ChevronRight, Hash, KeyRound, Megaphone, Search, ShieldCheck, UserPlus } from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import {
  COMMON_JOBS, MAIN_PATH, NAV_HUBS, NAV_SECTIONS, searchSections,
} from '@/lib/controlCenter/navModel'
import { MODULE_ENFORCEMENT, moduleEnforcement, ENFORCEMENT_BADGE_LABEL } from '@/lib/permissions/enforcement'
import { ENGINE_GATED_MODULE_KEYS } from '@/lib/permissions/moduleVisibility'
import { isSelfServiceModule } from '@/lib/moduleAccess'
import type { ControlCenterAppModule, ControlCenterDepartment } from '@/hooks/queries/useControlCenterData'
import { CcBadge, cc } from './CcPrimitives'
import { HUB_ICON } from './hubIcons'

// CONTROL CENTER HOME: the way to every setting, not a dashboard of work.
//
//   • A search box that narrows the directory as you type; Enter opens the first match.
//   • The directory: every setting, grouped by the area it belongs to, one click from here.
//   • Setup checks: what is wrong with the Control Center's own settings, drawn only when
//     something is. Every one is derived from lists already loaded; nothing is fetched for it.
//   • Common jobs, and the folded list of modules whose saved access is not fully applied.
//
// PENDING WORK IS NOT HERE (owner, 2026-11-15): approvals, payments to allocate and change
// requests show on the dashboard of the module that owns them.

const JOB_ICON: Record<string, typeof Search> = {
  'add-employee': UserPlus, 'reset-password': KeyRound, 'change-access': ShieldCheck, announce: Megaphone, 'next-number': Hash,
}

/** The words of a query, found in a label: `{ text, hit }` pieces, in order, to draw with the hit marked. */
export function highlightParts(label: string, query: string): { text: string; hit: boolean }[] {
  const low = label.toLowerCase()
  const spans: [number, number][] = []
  for (const word of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    const at = low.indexOf(word)
    if (at > -1) spans.push([at, at + word.length])
  }
  spans.sort((a, b) => a[0] - b[0])
  const out: { text: string; hit: boolean }[] = []
  let from = 0
  for (const [start, end] of spans) {
    if (start < from) continue
    if (start > from) out.push({ text: label.slice(from, start), hit: false })
    out.push({ text: label.slice(start, end), hit: true })
    from = end
  }
  if (from < label.length) out.push({ text: label.slice(from), hit: false })
  return out.length > 0 ? out : [{ text: label, hit: false }]
}

function Marked({ label, query }: { label: string; query: string }) {
  return <>{highlightParts(label, query).map((p, i) => p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>)}</>
}

// ── Access enforcement ────────────────────────────────────────────────────────

type EnforcementSummary = { enforced: string[]; partial: string[]; prepared: string[] }

/**
 * Which modules the permission engine actually decides, per module, from the
 * one source that answers that question (src/lib/permissions/enforcement.ts).
 * Attendance and Payroll are admin-only by product decision and are not
 * counted — there is no grant to enforce.
 */
function summarizeEnforcement(): EnforcementSummary {
  const keys = new Set<string>([...ENGINE_GATED_MODULE_KEYS, ...Object.keys(MODULE_ENFORCEMENT)])
  const out: EnforcementSummary = { enforced: [], partial: [], prepared: [] }
  for (const key of keys) {
    if (isSelfServiceModule(key)) continue
    const state = moduleEnforcement(key).state
    if (state === 'enforced') out.enforced.push(key)
    else if (state === 'partial') out.partial.push(key)
    else if (state === 'prepared') out.prepared.push(key)
  }
  return out
}

function titleCase(key: string): string {
  return key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

// ── The page ──────────────────────────────────────────────────────────────────

const SETTINGS = NAV_SECTIONS.filter(s => s.hub.id !== 'home')
const AREAS = NAV_HUBS.filter(h => h.id !== 'home')

export function HomeDirectory({ members, depts, modules, peopleInDept }: {
  members: UserProfile[]
  depts: ControlCenterDepartment[]
  modules: ControlCenterAppModule[]
  peopleInDept: (key: string) => number
}) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const q = query.trim()
  const found = useMemo(() => (q ? searchSections(q).filter(s => s.hub.id !== 'home') : null), [q])

  const live = members.filter(m => !m.is_deleted)
  const activeMembers = live.filter(m => m.is_active)
  const activeDepts = depts.filter(d => d.is_active)

  // Beside a setting, only what is already loaded: counts, not reads.
  const chips: Record<string, string> = {
    employees: `${activeMembers.length} active`,
    departments: `${activeDepts.length} active`,
    'by-module': `${modules.length} modules`,
  }

  // Setup checks: real conditions in loaded data, nothing predicted.
  const knownDept = new Set(depts.map(d => d.department_key))
  const withoutDepartment = activeMembers.filter(m => !m.team || !knownDept.has(m.team))
  const inactiveWithPeople = depts.filter(d => !d.is_active && peopleInDept(d.department_key) > 0)
  const customEmpty = modules.filter(m => m.visibility_type === 'custom' && (m.allowed_user_ids?.length ?? 0) === 0)
  const checks: { key: string; text: React.ReactNode; where: string; href: string; count: number }[] = []
  if (withoutDepartment.length > 0) {
    checks.push({
      key: 'no-dept', count: withoutDepartment.length, where: 'People › Employees', href: `${MAIN_PATH}/people`,
      text: <>Active {withoutDepartment.length === 1 ? 'employee has' : 'employees have'} no department</>,
    })
  }
  for (const d of inactiveWithPeople) {
    checks.push({
      key: `inactive-${d.department_key}`, count: peopleInDept(d.department_key), where: 'People › Departments',
      href: `${MAIN_PATH}?tab=departments`,
      text: <><strong>{d.department_name}</strong> is inactive but still has people assigned</>,
    })
  }
  for (const m of customEmpty) {
    checks.push({
      key: `custom-${m.module_key}`, count: 0, where: 'Access › By module', href: `${MAIN_PATH}/permissions/modules`,
      text: <><strong>{m.module_name}</strong> is set to Custom with nobody in it, so only administrators can see it</>,
    })
  }

  // Which modules saved permissions do not fully decide yet: reference, folded.
  const enforcement = summarizeEnforcement()
  const notEnforced = [...enforcement.partial, ...enforcement.prepared]
  const moduleName = (key: string) => modules.find(m => m.module_key === key)?.module_name ?? titleCase(key)

  const help = found
    ? found.length > 0
      ? `${found.length} ${found.length === 1 ? 'setting matches. Press Enter to open it.' : 'settings match. Press Enter to open the first.'}`
      : 'Nothing matches yet.'
    : `${SETTINGS.length} settings in ${AREAS.length} areas. Type to narrow the list, then press Enter to open the first match.`

  const go = () => { if (found && found.length > 0) router.push(found[0].href) }

  return (
    <div className={cc.homeWrap}>
      <div className={cc.hero}>
        <Search size={20} strokeWidth={2} aria-hidden="true" />
        <input
          className={cc.heroInput}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); go() }
            else if (e.key === 'Escape') setQuery('')
          }}
          placeholder="Find a setting, e.g. password"
          aria-label="Find a setting"
          autoComplete="off"
        />
        <span className={cc.kbd}>Ctrl K</span>
      </div>
      <p className={cc.heroHelp} role="status">{help}</p>

      <div className={`${cc.homeGrid}${checks.length === 0 ? ` ${cc.homeGridNoSetup}` : ''}`}>
        <div className={cc.gDir}>
          <div className={cc.dirHead}>
            <h2 className={cc.dirTitle}>All settings</h2>
            <span className={cc.dirNote}>{q ? `Matching “${q}”` : 'Each one is a single click away'}</span>
          </div>

          {found ? (
            found.length === 0 ? (
              <div className={cc.noMatch}>
                <b>No setting matches “{q}”</b>
                Try a shorter word, or one of these:
                <div className={cc.pills}>
                  {['password', 'order number', 'access', 'announcement'].map(w => (
                    <button key={w} type="button" className={cc.pill} onClick={() => setQuery(w)}>{w}</button>
                  ))}
                </div>
              </div>
            ) : (
              <div className={cc.results}>
                {found.map(s => (
                  <Link key={s.id} href={s.href} className={cc.item}>
                    <span className={cc.itemMain}>
                      <span className={cc.itemLine}><span className={cc.itemLabel}><Marked label={s.label} query={q} /></span></span>
                      <span className={cc.itemSub}>{s.description}</span>
                    </span>
                    <span className={cc.itemWhere}>{s.hub.label}</span>
                    <ChevronRight size={16} className={cc.itemGo} aria-hidden="true" />
                  </Link>
                ))}
              </div>
            )
          ) : (
            <div className={cc.dir}>
              {AREAS.map(hub => {
                const Icon = HUB_ICON[hub.id]
                return (
                  <section key={hub.id} className={`${cc.area}${hub.danger ? ` ${cc.areaDanger}` : ''}`} aria-labelledby={`area-${hub.id}`}>
                    <div className={cc.areaHead}>
                      <span className={cc.areaTile}><Icon size={20} strokeWidth={1.8} /></span>
                      <div>
                        <h3 id={`area-${hub.id}`} className={cc.areaName}>{hub.label}</h3>
                        <p className={cc.areaBlurb}>{hub.blurb}</p>
                      </div>
                    </div>
                    <div className={cc.areaItems}>
                      {hub.sections.map(s => (
                        <Link key={s.id} href={s.href} className={cc.item}>
                          <span className={cc.itemMain}>
                            <span className={cc.itemLine}>
                              <span className={cc.itemLabel}>{s.label}</span>
                              {chips[s.id] && <span className={cc.chip}>{chips[s.id]}</span>}
                            </span>
                            <span className={cc.itemSub}>{s.short}</span>
                          </span>
                          <ChevronRight size={16} className={cc.itemGo} aria-hidden="true" />
                        </Link>
                      ))}
                    </div>
                  </section>
                )
              })}
            </div>
          )}
        </div>

        {checks.length > 0 && (
          <div className={`${cc.panel} ${cc.gSetup}`}>
            <div className={cc.panelHead}>
              <h2 className={cc.panelTitle}>Setup checks <span className={cc.panelCount}>{checks.length}</span></h2>
            </div>
            {checks.map(c => (
              <Link key={c.key} href={c.href} className={cc.row}>
                {c.count > 0 && <span className={cc.bubble}>{c.count}</span>}
                <span className={cc.rowMain}><b>{c.text}</b><small>{c.where}</small></span>
                <ChevronRight size={16} className={cc.rowGo} aria-hidden="true" />
              </Link>
            ))}
          </div>
        )}

        <div className={`${cc.panel} ${cc.gJobs}`}>
          <div className={cc.panelHead}><h2 className={cc.panelTitle}>Common jobs</h2></div>
          {COMMON_JOBS.map(job => {
            const Icon = JOB_ICON[job.id] ?? Search
            return (
              <Link key={job.id} href={job.href} className={`${cc.row} ${cc.job}`}>
                <span className={cc.jobIcon}><Icon size={16} strokeWidth={1.9} aria-hidden="true" /></span>
                {job.label}
                <ChevronRight size={16} className={cc.rowGo} aria-hidden="true" />
              </Link>
            )
          })}
        </div>

        {/* Reference, not something to act on every day: a grant in a module the engine does not
            fully decide is saved but decides nothing, and an administrator handing out access
            deserves to know that here. */}
        <details className={`${cc.panel} ${cc.fold} ${cc.gFold}`}>
          <summary>
            Access enforcement{notEnforced.length > 0 ? `: ${notEnforced.length} not fully applied` : ''}
          </summary>
          <div className={cc.foldBody}>
            <p style={{ margin: '0 0 10px' }}>
              Modules where saved permissions are not yet fully applied by the engine. Every other module is enforced in the database and the screen.
            </p>
            {notEnforced.length === 0 ? (
              <p style={{ margin: 0 }}>Every module’s permissions are enforced.</p>
            ) : notEnforced.map(key => {
              const e = moduleEnforcement(key)
              return (
                <div key={key} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '6px 0' }}>
                  <span style={{ flex: 1, minWidth: 0 }}><strong>{moduleName(key)}</strong><br />{e.detail}</span>
                  <CcBadge tone={e.state === 'partial' ? 'amber' : 'gray'}>{ENFORCEMENT_BADGE_LABEL[e.state]}</CcBadge>
                </div>
              )
            })}
          </div>
        </details>
      </div>
    </div>
  )
}
