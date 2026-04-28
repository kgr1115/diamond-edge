'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/picks/today',    label: 'Today',    match: (p: string) => p === '/picks/today' },
  { href: '/picks/upcoming', label: 'Upcoming', match: (p: string) => p.startsWith('/picks/upcoming') },
  { href: '/history',        label: 'History',  match: (p: string) => p.startsWith('/history') },
];

export function SlateNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Slate views" className="mb-6">
      <ul className="flex gap-1 sm:gap-2 border-b border-gray-800">
        {TABS.map((tab) => {
          const active = tab.match(pathname);
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={`inline-block px-3 sm:px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                  active
                    ? 'text-white border-emerald-500'
                    : 'text-gray-400 border-transparent hover:text-gray-200 hover:border-gray-700'
                }`}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
