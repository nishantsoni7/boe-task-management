import type { Metadata } from 'next'
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
  icons: {
    icon: '/branding/favicon.png',
    apple: '/branding/favicon.png',
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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
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