import type { Metadata, Viewport } from 'next'
import './globals.css'
import { Nav } from '@/components/Nav'
import { RegisterServiceWorker } from '@/components/RegisterServiceWorker'
import { t } from '@/i18n/pl'

export const metadata: Metadata = { title: t.appName, manifest: '/manifest.webmanifest' }
export const viewport: Viewport = { width: 'device-width', initialScale: 1, maximumScale: 1 }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pl">
      <body className="mx-auto max-w-xl">
        <Nav />
        <main className="p-4">{children}</main>
        <RegisterServiceWorker />
      </body>
    </html>
  )
}
