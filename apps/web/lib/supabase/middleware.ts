import { createServerClient } from '@supabase/ssr';
import type { CookieOptions } from '@supabase/ssr';
import { NextRequest, NextResponse } from 'next/server';
import type { Database } from '@/lib/types/database';

/**
 * Called from middleware.ts to refresh the Supabase Auth session cookie on every request.
 * This is required so server-side auth reads a current, non-expired session.
 *
 * Follows the official @supabase/ssr middleware pattern.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANT: do not write any logic between createServerClient and supabase.auth.getUser().
  // Any code here could cause a split-brain between the server and browser session state.
  await supabase.auth.getUser();

  return supabaseResponse;
}
