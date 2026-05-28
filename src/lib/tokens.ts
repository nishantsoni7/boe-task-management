// ─── BOE Design tokens (JS mirror of CSS @theme) ─────────────────────────────
// Use CSS classes from globals.css wherever possible.
// Import from here only when you need a token in a dynamic inline style
// (e.g. a border color derived from data at runtime).

export const colors = {
  // Surfaces
  void:    '#0A0B0D',
  base:    '#0D0F12',
  raised:  '#161820',
  float:   '#1C1F28',
  hover:   '#20232D',

  // Text
  primary:   '#E8EAF0',
  secondary: '#7E8698',
  tertiary:  '#5C6377',
  muted:     '#42475A',

  // Accents
  amber: '#E8A030',
  red:   '#D94F4F',
  green: '#45A870',
  blue:  '#5585E8',

  // Borders
  border:     'rgba(255,255,255,0.045)',
  borderSoft: 'rgba(255,255,255,0.08)',
  borderMed:  'rgba(255,255,255,0.13)',

  // Tinted backgrounds (alert states)
  amberTint: 'rgba(232,160,48,0.07)',
  redTint:   'rgba(217,79,79,0.065)',
  greenTint: 'rgba(69,168,112,0.065)',
  blueTint:  'rgba(85,133,232,0.065)',
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