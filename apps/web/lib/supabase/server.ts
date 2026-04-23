import { createServerClient } from '@supabase/ssr';
import type { CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { Database } from '@/lib/types/database';

/**
 * Server-side Supabase client for use in Server Components, Route Handlers,
 * and Server Actions. Uses the anon key by default — RLS is the security boundary.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // setAll called from a Server Component — cookies cannot be set.
            // This is expected when a server component renders without a wrapping
            // middleware that can mutate cookies. Supabase handles this gracefully.
          }
        },
      },
    }
  );
}

/**
 * Service-role client for server-side jobs that bypass RLS (webhooks, cron, migrations).
 * NEVER import this in client bundles. NEVER return service-role data to the client directly.
 */
export function createServiceRoleClient() {
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: {
        getAll() { return []; },
        setAll() { /* no-op — service role client does not need cookies */ },
      },
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}
