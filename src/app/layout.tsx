import type { Metadata, Viewport } from 'next'
import { preconnect } from 'react-dom'
import localFont from 'next/font/local'
import { Providers } from '@/components/layout/Providers'
import './globals.css'

// ── Fonts: Manrope (headings) + Inter (everything else), self-hosted ──────────
//
// Both are variable fonts committed under ./fonts, so the build never reaches
// the network for type — the failure that once removed Syne (a Google fetch
// that did not resolve on the production builder) cannot recur. Only the latin
// file is preloaded. The latin-ext files, which carry the rupee sign (U+20B9),
// are declared with a unicode-range in globals.css and are fetched only when a
// page actually renders one of those glyphs. next/font also emits a
// size-adjusted fallback face, so the swap from system sans to Inter/Manrope
// does not move the layout.

const manrope = localFont({
  src: './fonts/Manrope-latin-var.woff2',
  weight: '600 700',
  variable: '--font-manrope',
  display: 'swap',
})

const inter = localFont({
  src: './fonts/Inter-latin-var.woff2',
  weight: '400 600',
  variable: '--font-inter',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'BOE One',
  description: 'Best of Exports — BOE One',
  manifest: '/manifest.json',
  applicationName: 'BOE One',
  icons: {
    icon: [
      { url: '/brand/svg/favicon.svg?v=1', type: 'image/svg+xml' },
      { url: '/brand/icons/favicon.ico?v=1', sizes: 'any' },
    ],
    apple: [{ url: '/brand/icons/icon-180.png?v=1', sizes: '180x180' }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'BOE One',
  },
  other: {
    'mobile-web-app-capable': 'yes',
  },
}

// The browser chrome colour is the BOE One charcoal (brand-tokens.css).
export const viewport: Viewport = {
  themeColor: '#303536',
}

// ── Open the database connection while the page is still loading ─────────────
//
// Every screen reads its data straight from the browser, so the first request
// of every page load has to open a connection to the database host first: a DNS
// lookup, a TCP handshake and a TLS handshake, roughly three round trips, spent
// only after the JavaScript has downloaded, parsed and started. This hint lets
// the browser do that work while it is still reading the HTML and the scripts,
// so the first query leaves on an open connection.
//
// "anonymous" is deliberate: the data client's fetches are cross-origin, sent
// without cookies, and a browser keeps those on their own connection pool — a
// preconnect without it would open a connection the requests never use.
//
// It is a hint, never a dependency: with no URL configured it does nothing, and
// a browser that ignores it behaves exactly as before.
const DATA_ORIGIN = process.env.NEXT_PUBLIC_SUPABASE_URL

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  if (DATA_ORIGIN) preconnect(DATA_ORIGIN, { crossOrigin: 'anonymous' })

  return (
    <html
      lang="en"
      className={`${manrope.variable} ${inter.variable}`}
    >
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}