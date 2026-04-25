'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';
import type { Database } from '@/lib/types/database';

type Tier = 'anon' | 'free' | 'pro' | 'elite';

interface NavItem {
  href: string;
  label: string;
  minTier?: Tier;
  /** When true, hidden in portfolio mode (NEXT_PUBLIC_PAID_TIERS=false). */
  paidOnly?: boolean;
}

// NEXT_PUBLIC_ vars are inlined into the client bundle at build time.
const PAID_TIERS_ENABLED = process.env.NEXT_PUBLIC_PAID_TIERS === 'true';

const NAV_ITEMS: NavItem[] = [
  { href: '/picks/today', label: "Today's Picks" },
  { href: '/history',     label: 'History' },
  { href: '/bankroll',    label: 'Bankroll',                      paidOnly: true },
  { href: '/clv',         label: 'CLV',      minTier: 'elite',    paidOnly: true },
];

const TIER_RANK: Record<Tier, number> = { anon: 0, free: 1, pro: 2, elite: 3 };

function canSee(item: NavItem, userTier: Tier): boolean {
  if (item.paidOnly && !PAID_TIERS_ENABLED) return false;
  if (!item.minTier) return true;
  return TIER_RANK[userTier] >= TIER_RANK[item.minTier];
}

export function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [tier, setTier] = useState<Tier>('anon');
  const [email, setEmail] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    // Portfolio mode: skip the auth round-trip entirely. No session, no
    // profile lookup, no tier badge. Every viewer is anon-equivalent.
    if (!PAID_TIERS_ENABLED) {
      setLoaded(true);
      return;
    }

    const supabase = createBrowserClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );

    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (cancelled) return;
      if (!user) {
        setTier('anon');
        setEmail(null);
        setLoaded(true);
        return;
      }
      setEmail(user.email ?? null);

      const { data: profile } = await supabase
        .from('profiles')
        .select('subscription_tier')
        .eq('id', user.id)
        .single();
      if (cancelled) return;
      setTier((profile?.subscription_tier as Tier) ?? 'free');
      setLoaded(true);
    })();

    return () => { cancelled = true; };
  }, []);

  async function handleSignOut() {
    const supabase = createBrowserClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  // Routes where we suppress nav (pre-auth funnel)
  const hiddenOn = ['/age-gate', '/geo-blocked', '/login', '/signup'];
  if (hiddenOn.some((p) => pathname.startsWith(p))) return null;

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(href + '/');

  const visibleItems = NAV_ITEMS.filter((item) => canSee(item, tier));

  return (
    <nav
      className="sticky top-0 z-40 bg-gray-950/90 backdrop-blur-sm border-b border-gray-800"
      aria-label="Primary"
    >
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
        {/* Brand */}
        <Link href="/picks/today" className="flex items-center gap-2 font-bold text-white text-lg hover:text-gray-200 transition-colors">
          <span className="text-amber-400">◆</span>
          <span className="hidden sm:inline">Diamond Edge</span>
        </Link>

        {/* Desktop links */}
        <div className="hidden md:flex items-center gap-1">
          {visibleItems.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`text-sm px-3 py-1.5 rounded transition-colors ${
                  active
                    ? 'bg-gray-800 text-white font-semibold'
                    : 'text-gray-400 hover:text-white hover:bg-gray-900'
                }`}
                aria-current={active ? 'page' : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </div>

        {/* Right side: tier badge + sign in/out (paid-tier only) */}
        <div className="flex items-center gap-3">
          {PAID_TIERS_ENABLED && loaded && tier !== 'anon' && (
            <span
              className={`hidden sm:inline text-xs px-2 py-0.5 rounded font-medium ${
                tier === 'elite'
                  ? 'bg-amber-900/60 text-amber-300'
                  : tier === 'pro'
                    ? 'bg-blue-900/60 text-blue-300'
                    : 'bg-gray-800 text-gray-400'
              }`}
              title={email ?? ''}
            >
              {tier.toUpperCase()}
            </span>
          )}

          {PAID_TIERS_ENABLED && loaded && tier === 'anon' ? (
            <div className="flex items-center gap-2">
              <Link href="/login" className="text-sm text-gray-400 hover:text-white">
                Sign in
              </Link>
              <Link
                href="/signup"
                className="text-sm bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded"
              >
                Sign up
              </Link>
            </div>
          ) : PAID_TIERS_ENABLED && loaded ? (
            <button
              onClick={handleSignOut}
              className="hidden md:inline text-sm text-gray-400 hover:text-white"
            >
              Sign out
            </button>
          ) : null}

          {/* Mobile menu toggle */}
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="md:hidden text-gray-300 p-1 -mr-1"
            aria-label="Toggle menu"
            aria-expanded={menuOpen}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {menuOpen ? (
                <>
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </>
              ) : (
                <>
                  <line x1="4" y1="6" x2="20" y2="6" />
                  <line x1="4" y1="12" x2="20" y2="12" />
                  <line x1="4" y1="18" x2="20" y2="18" />
                </>
              )}
            </svg>
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <div className="md:hidden border-t border-gray-800 bg-gray-950">
          <div className="max-w-6xl mx-auto px-4 py-2 flex flex-col gap-1">
            {visibleItems.map((item) => {
              const active = isActive(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMenuOpen(false)}
                  className={`text-sm px-3 py-2 rounded transition-colors ${
                    active
                      ? 'bg-gray-800 text-white font-semibold'
                      : 'text-gray-400 hover:text-white hover:bg-gray-900'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
            {PAID_TIERS_ENABLED && loaded && tier !== 'anon' && (
              <button
                onClick={() => { setMenuOpen(false); handleSignOut(); }}
                className="text-sm px-3 py-2 rounded text-gray-400 hover:text-white hover:bg-gray-900 text-left"
              >
                Sign out
              </button>
            )}
          </div>
        </div>
      )}
    </nav>
  );
}
