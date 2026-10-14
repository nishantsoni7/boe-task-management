// ─── BOE Design tokens (JS mirror of the CSS custom properties) ──────────────
// The source of truth is the :root block in app/globals.css (--boe-*).
// Use CSS classes / var(--boe-*) wherever possible. Import from here only when
// you need a token in a dynamic inline style (e.g. a colour derived from data).

export const colors = {
  // Surfaces
  void:    '#F7F5F1',   // page canvas
  base:    '#FFFFFF',   // content surface
  raised:  '#FBFAF8',
  float:   '#F1EEE9',
  hover:   '#ECE7E0',

  // Text
  primary:   '#303536',
  secondary: '#4C5352',
  tertiary:  '#686D6C',
  muted:     '#686D6C',

  // Brand / action
  brand:      '#B9472E',
  brandHover: '#9E3B25',
  brandInk:   '#963B27',
  brandTint:  '#F8EAE4',

  // Status foreground (text, icons, solid marks)
  amber: '#805B0D',   // waiting
  red:   '#B42332',   // error / destructive
  green: '#276247',   // completed
  blue:  '#335A86',   // working

  // Borders
  border:     '#E4DED7',
  borderSoft: '#CFC8BF',
  borderMed:  '#B9B2A9',
  borderInput: '#8C8379',  // form-control boundary, 3:1 on white and canvas (--boe-border-input)

  // Status backgrounds
  amberTint: '#FAF0DA',
  redTint:   '#FBE9EC',
  greenTint: '#E8F2EC',
  blueTint:  '#EAF0F8',
} as const

export const status = {
  pending:   { fg: '#595D5B', bg: '#EEECE8' },
  working:   { fg: '#335A86', bg: '#EAF0F8' },
  waiting:   { fg: '#805B0D', bg: '#FAF0DA' },
  blocked:   { fg: '#A12438', bg: '#FBE9EC' },
  completed: { fg: '#276247', bg: '#E8F2EC' },
} as const

export const font = {
  display: 'var(--font-display)',
  body:    'var(--font-body)',
  mono:    'var(--font-body)',
} as const

export const radius = {
  sm: '6px',
  md: '8px',
  lg: '12px',
} as const
