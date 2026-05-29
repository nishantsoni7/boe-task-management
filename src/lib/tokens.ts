// ─── BOE Design tokens (JS mirror of CSS @theme) ─────────────────────────────
// Use CSS classes from globals.css wherever possible.
// Import from here only when you need a token in a dynamic inline style
// (e.g. a border color derived from data at runtime).

export const colors = {
  // Surfaces
  void:    '#F4F5F7',
  base:    '#FFFFFF',
  raised:  '#F8F9FB',
  float:   '#EEF0F4',
  hover:   '#E8EBF0',

  // Text
  primary:   '#111318',
  secondary: '#4A5261',
  tertiary:  '#6B7384',
  muted:     '#8C94A6',

  // Accents
  amber: '#E8A030',
  red:   '#D94F4F',
  green: '#45A870',
  blue:  '#5585E8',

  // Borders
  border:     'rgba(0,0,0,0.08)',
  borderSoft: 'rgba(0,0,0,0.13)',
  borderMed:  'rgba(0,0,0,0.18)',

  // Tinted backgrounds (alert states)
  amberTint: 'rgba(232,160,48,0.08)',
  redTint:   'rgba(217,79,79,0.07)',
  greenTint: 'rgba(69,168,112,0.07)',
  blueTint:  'rgba(85,133,232,0.07)',
} as const

export const font = {
  display: 'var(--font-display, Syne, sans-serif)',
  body:    'var(--font-body, DM Sans, sans-serif)',
  mono:    'var(--font-mono, DM Mono, monospace)',
} as const

export const radius = {
  sm: '5px',
  md: '8px',
  lg: '10px',
} as const