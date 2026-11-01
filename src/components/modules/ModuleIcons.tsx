import { Armchair, ContactRound, Factory, Image as ImageIcon, Megaphone, Search, Tag, TrendingUp } from 'lucide-react'

// ── The module icons, drawn once ─────────────────────────────────────────────
//
// The launcher (src/app/modules/page.tsx) and the Control Center's Access
// screens show the same modules, so they draw the same icons from here. The
// hand-drawn ones were the launcher's own; the four Lucide ones are the
// launcher's choices for the newer modules. All share the 24-unit viewBox,
// 1.8 stroke and round caps the rest of BOE One uses, and take `size` so a
// row can draw them smaller than a card.

type IconProps = { size?: number }

const attrs = (size: number) => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true,
})

export function TaskIcon({ size = 26 }: IconProps) {
  return (
    <svg {...attrs(size)}>
      <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  )
}

export function BoxIcon({ size = 26 }: IconProps) {
  return (
    <svg {...attrs(size)}>
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.29 7 12 12 20.71 7" /><line x1="12" y1="22" x2="12" y2="12" />
    </svg>
  )
}

// Attendance & Payroll. The calendar stands for the month, which is the unit
// both halves of the module work in — a month of punches, and the payroll run
// computed from it. (The separate banknote icon went with the separate card.)
export function CalIcon({ size = 26 }: IconProps) {
  return (
    <svg {...attrs(size)}>
      <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  )
}

export function AssetIcon({ size = 26 }: IconProps) {
  return (
    <svg {...attrs(size)}>
      <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" />
      <path d="M7 8h.01M11 8h4M7 12h.01M11 12h4" />
    </svg>
  )
}

export function MembersIcon({ size = 26 }: IconProps) {
  return (
    <svg {...attrs(size)}>
      <circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
    </svg>
  )
}

export function ControlCenterIcon({ size = 26 }: IconProps) {
  return (
    <svg {...attrs(size)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07M8.46 8.46a5 5 0 0 0 0 7.07" />
    </svg>
  )
}

export function PerformanceIcon({ size = 26 }: IconProps) {
  return (
    <svg {...attrs(size)}>
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" />
    </svg>
  )
}

export function FinanceIcon({ size = 26 }: IconProps) {
  return (
    <svg {...attrs(size)}>
      <line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  )
}

export function OrdersIcon({ size = 26 }: IconProps) {
  return (
    <svg {...attrs(size)}>
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <line x1="9" y1="12" x2="15" y2="12" /><line x1="9" y1="16" x2="13" y2="16" />
    </svg>
  )
}

export function ReviewOutreachIcon({ size = 26 }: IconProps) {
  return (
    <svg {...attrs(size)}>
      <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
      <path d="M9.5 11.5h5M9.5 14h3" />
    </svg>
  )
}

export function MeetingsIcon({ size = 26 }: IconProps) {
  return (
    <svg {...attrs(size)}>
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="16" y1="2" x2="16" y2="6" />
      <path d="M8 13h5M8 17h8" />
    </svg>
  )
}

export function ShowroomIcon({ size = 26 }: IconProps) {
  return (
    <svg {...attrs(size)}>
      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h2v2h-2zM18 14h3M14 18h2M18 18h3M14 21h5" />
    </svg>
  )
}

/**
 * The icon for a permission module key, at a given size. The launcher keys
 * its cards differently (tasks, samples, assets, members, showroom,
 * customer_reviews, attendance_payroll); this map speaks the permission
 * engine's keys, which is what the Control Center holds.
 */
export function ModuleIcon({ moduleKey, size = 18 }: { moduleKey: string; size?: number }) {
  switch (moduleKey) {
    case 'task_management': return <TaskIcon size={size} />
    case 'orders': return <OrdersIcon size={size} />
    case 'sample_tracking': return <BoxIcon size={size} />
    case 'attendance': case 'payroll': case 'attendance_payroll': return <CalIcon size={size} />
    case 'showroom_qr': return <ShowroomIcon size={size} />
    case 'assets_access': return <AssetIcon size={size} />
    case 'employee_records': return <MembersIcon size={size} />
    case 'performance': return <PerformanceIcon size={size} />
    case 'finance': return <FinanceIcon size={size} />
    case 'meetings': return <MeetingsIcon size={size} />
    case 'customer_review_requests': return <ReviewOutreachIcon size={size} />
    case 'image_editor': return <ImageIcon size={size} strokeWidth={1.8} aria-hidden />
    case 'exhibition_leads': return <ContactRound size={size} strokeWidth={1.8} aria-hidden />
    case 'vendors': return <Factory size={size} strokeWidth={1.8} aria-hidden />
    case 'inventory': return <Armchair size={size} strokeWidth={1.8} aria-hidden />
    case 'sales': return <TrendingUp size={size} strokeWidth={1.8} aria-hidden />
    case 'marketing': return <Megaphone size={size} strokeWidth={1.8} aria-hidden />
    case 'pricing': return <Tag size={size} strokeWidth={1.8} aria-hidden />
    case 'seo': return <Search size={size} strokeWidth={1.8} aria-hidden />
    default: return <ControlCenterIcon size={size} />
  }
}
