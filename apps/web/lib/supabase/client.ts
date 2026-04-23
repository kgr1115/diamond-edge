'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { Database } from '@/lib/types/database';

/**
 * Browser-side Supabase client for use in Client Components.
 * Reads public env vars only — no secrets reach the browser.
 */
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
