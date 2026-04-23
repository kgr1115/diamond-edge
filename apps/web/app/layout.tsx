import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { GlobalFooter } from '@/components/layout/global-footer';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Diamond Edge — MLB Betting Picks',
  description:
    'Statistically-grounded, AI-explained MLB betting picks. Moneyline, run line, totals, and props.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.className} bg-gray-950 text-gray-100 min-h-screen flex flex-col`}>
        <main className="flex-1">{children}</main>
        <GlobalFooter />
      </body>
    </html>
  );
}
