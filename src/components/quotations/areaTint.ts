import type { CSSProperties } from 'react'

/**
 * Areas of a quotation (were "room types"; owner, 25 Nov 2026: "not every quotation will have room setup, so it should be editable to outdoor,
 * indoor, Private Dining area or any other area. Each sections should have some light variation to keep it slightly differentiable from others.
 * But by default it will not be active"). Each area gets one of these light tints, in the order the areas are on the page; text on them stays
 * charcoal (above 11 : 1 on every tint).
 */
export const AREA_TINTS = [
  { tint: '#FAF5EE', line: '#EBDDCB', strong: '#D9BE98' },
  { tint: '#F2F6F0', line: '#D5E2CE', strong: '#A9C29C' },
  { tint: '#EFF4F9', line: '#CFDDEB', strong: '#9DB7D3' },
  { tint: '#F6F2F8', line: '#E0D5E8', strong: '#BFA9CF' },
  { tint: '#FBF1EF', line: '#EED3CC', strong: '#DDA597' },
] as const

/** The CSS variables an area's band, stripe and foot read (`--area-tint`, `--area-line`, `--area-strong`). */
export function tintStyle(index: number): CSSProperties {
  const n = AREA_TINTS.length
  const t = AREA_TINTS[((index % n) + n) % n]
  return { '--area-tint': t.tint, '--area-line': t.line, '--area-strong': t.strong } as CSSProperties
}

/** What the area name box suggests; any other name can be typed. */
export const AREA_SUGGESTIONS = ['Indoor', 'Outdoor', 'Private dining area', 'Restaurant', 'Lobby', 'Bedroom', 'Living room', 'Terrace', 'Pool side', 'Banquet hall'] as const
