'use client'

import { usePathname } from 'next/navigation'
import { Bell, Columns3, ListChecks, Pin, PinOff } from 'lucide-react'
import { BoeBrandIcon } from '@/components/layout/BoeBrandIcon'
import { ModulePageSkeleton } from '@/components/layout/ModulePageSkeleton'
import { railShellClass, useSidebarPinned } from '@/components/layout/RailControls'
import layout from '@/components/layout/salesLayout.module.css'
import b from './leadBoard.module.css'
import k from './salesChecking.module.css'

// What a Sales page shows while the permission check is still running (owner, 2026-11-14), instead of the full-screen spinner:
// the Sales sidebar and header with the page's own title, and grey blocks where the page will be, so the page is on screen
// from the first paint and the real page takes over in place.
//
// IT IS GIVEN TO ModuleGuard AS `checking`, WHICH SHOWS IT ONLY WHILE THE CHECK IS RUNNING. Once the check has said no the guard
// goes back to the spinner. It READS NOTHING and DRAWS NO ACTION: no query, no data, no person's name, no button or link, and
// none of the items that depend on what somebody may do (Team, Lead Master). It is not SalesLayout on purpose: that starts the
// unread-notifications read when it mounts, which is a request before access is decided. It uses the same classes as the real
// shell so nothing jumps when the page replaces it; keep the two in step.

const TITLES: Record<string, string> = {
  '/sales/my-day': 'My day',
  '/sales/board': 'Lead Board',
  '/sales/team': 'Team',
  '/sales/lead-master': 'Lead Master',
  '/sales/lead-master/new': 'Add lead',
  '/sales/lead-master/filtered-chats': 'Filtered chats',
  '/sales/import': 'Import from ClickUp',
  '/sales/notifications': 'Notifications',
}

export const checkingTitle = (pathname: string) => TITLES[pathname.replace(/\/+$/, '')] ?? 'Sales'

const NAV = [
  { href: '/sales/my-day', label: 'My day', icon: ListChecks },
  { href: '/sales/board', label: 'Lead Board', icon: Columns3 },
] as const

const COLUMNS = ['New', 'Under Process', 'Visit / Meeting', 'Potential Clients', 'Negotiation'] as const

function BoardBlocks() {
  return (
    <div className={b.wrap}>
      <div className={b.bar}><span className={`${k.skelBlock} ${k.skelSearch}`} /></div>
      <div className={b.cols}>
        {COLUMNS.map((name, i) => (
          <section key={name} className={`${b.col}${i === 0 ? ` ${b.colCurrent}` : ''}`}>
            <header className={b.colHead}><h2 className={b.colName}>{name}</h2><span className={k.skelBlock} style={{ width: 26, height: 18 }} /></header>
            <div className={b.colList}>
              {[0, 1, 2, 3, 4].map(n => (
                // The real card's own class, so the blocks are exactly as tall as a card; it cannot be pressed.
                <div key={n} className={b.card} style={{ cursor: 'default', pointerEvents: 'none' }}>
                  <span className={k.skelBlock} style={{ width: '62%', height: 13, margin: '2px 0' }} />
                  <span className={k.skelBlock} style={{ width: '48%', height: 12, margin: '3px 0' }} />
                  <div className={b.cardMid}><span className={k.skelBlock} style={{ width: 48, height: 22 }} /><span className={k.skelBlock} style={{ width: 84, height: 12 }} /></div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

export function SalesCheckingFrame() {
  const pathname = usePathname() ?? ''
  const [pinned] = useSidebarPinned()
  const title = checkingTitle(pathname)
  const board = pathname.replace(/\/+$/, '') === '/sales/board'
  const lit = (href: string) => pathname === href || pathname.startsWith(`${href}/`)

  return (
    <div className={railShellClass(pinned)}>
      <aside className="boe-sidebar" aria-hidden="true">
        <div className="boe-sidebar-brand" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <BoeBrandIcon />
            <div className="boe-rail-label">
              <div className="boe-sidebar-brand-name">BOE One</div>
              <div className="boe-sidebar-brand-sub">Sales</div>
            </div>
          </div>
        </div>
        <div className="boe-sidebar-section">
          {NAV.map(item => {
            const Icon = item.icon
            const active = lit(item.href)
            return (
              <div key={item.href} className={`boe-nav-item${active ? ' active' : ''}`} style={{ fontWeight: active ? 500 : 400, fontSize: 13.5, marginBottom: '2px' }}>
                <span style={{ color: active ? '#37352F' : '#8A8782', display: 'flex', alignItems: 'center' }}><Icon size={15} strokeWidth={1.8} /></span>
                <span className="boe-rail-label">{item.label}</span>
              </div>
            )
          })}
          <div className={`boe-nav-item${pathname === '/sales/notifications' ? ' active' : ''}`} style={{ marginBottom: '2px' }}>
            <span style={{ color: '#686D6C', display: 'flex', alignItems: 'center' }}><Bell size={15} strokeWidth={1.8} /></span>
            <span className="boe-rail-label">Notifications</span>
          </div>
        </div>
        <div className="boe-sidebar-foot">
          <div className="boe-nav-item boe-nav-item--quiet boe-rail-pin" style={{ marginBottom: '2px' }}>
            <span style={{ color: '#686D6C', display: 'flex', alignItems: 'center' }}>{pinned ? <PinOff size={14} strokeWidth={1.8} /> : <Pin size={14} strokeWidth={1.8} />}</span>
            <span className="boe-rail-label">{pinned ? 'Unpin menu' : 'Pin menu open'}</span>
          </div>
        </div>
      </aside>

      <div className={`boe-main-content${board ? ` ${layout.fill}` : ''}`}>
        <div className="boe-page-header" aria-hidden="true">
          <div className="boe-page-title-group"><div className="boe-page-title">{title}</div></div>
        </div>
        <div className={`boe-page-body ${layout.pageBody}${board ? ` ${layout.fillBody}` : ''}`}>
          <div role="status" aria-busy="true" aria-label={`Loading ${title}`} style={board ? { display: 'contents' } : undefined}>
            {board ? <BoardBlocks /> : <ModulePageSkeleton variant="list" label={`Loading ${title}`} />}
          </div>
        </div>
      </div>

      <nav className={`boe-mobile-bottom-nav ${layout.bottomNav}`} aria-hidden="true">
        {NAV.map(item => {
          const Icon = item.icon
          return (
            <div key={item.href} className={layout.bottomItem} aria-current={lit(item.href) ? 'page' : undefined}>
              <Icon size={20} strokeWidth={1.8} />{item.label}
            </div>
          )
        })}
      </nav>
    </div>
  )
}
