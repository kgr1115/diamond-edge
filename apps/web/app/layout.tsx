import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { GlobalFooter } from '@/components/layout/global-footer';
import { TopNav } from '@/components/layout/top-nav';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Diamond Edge — MLB Betting Picks',
  description:
    'Statistically-grounded MLB betting picks. Moneyline, run line, totals, and props.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.className} bg-gray-950 text-gray-100 min-h-screen flex flex-col`}>
        <TopNav />
        <main className="flex-1">{children}</main>
        <GlobalFooter />
      </body>
    </html>
  );
}
