/**
 * Admin gate for operator-only surfaces (e.g., /admin/pipelines).
 *
 * Pattern (per scope-gate 2026-04-24 cycle 2, Proposal 3):
 *   - Admin identities come from the `ADMIN_USER_IDS` env var: a comma-separated
 *     list of auth.users UUIDs. No database column, no claim — one env var.
 *   - Non-admin callers get 404 (not 403) — operational internals must not leak
 *     existence. Callers should invoke `notFound()` from 'next/navigation' or
 *     return `new Response(null, { status: 404 })` from route handlers.
 *
 * This is the FIRST admin surface in the codebase; this helper establishes the
 * canonical pattern scope-gate named. All future admin surfaces use it.
 */
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import type { Database } from '@/lib/types/database';

function parseAdminIds(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/**
 * Returns the authenticated user id IF the caller is an admin, else null.
 * `null` result → caller SHOULD respond with 404.
 *
 * Env:
 *   ADMIN_USER_IDS — comma-separated auth.users UUIDs. Missing/empty → nobody is admin.
 */
export async function requireAdmin(): Promise<{ userId: string } | null> {
  const adminIds = parseAdminIds(process.env.ADMIN_USER_IDS);
  if (adminIds.size === 0) {
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'admin_gate_unconfigured',
      reason: 'ADMIN_USER_IDS env var is empty',
    }));
    return null;
  }

  const cookieStore = await cookies();
  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll() {},
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  if (!adminIds.has(user.id)) return null;

  return { userId: user.id };
}
