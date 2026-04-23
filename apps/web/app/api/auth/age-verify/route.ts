import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';

const AGE_VERIFY_SCHEMA = z.object({
  date_of_birth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date_of_birth must be in YYYY-MM-DD format'),
  method: z.literal('dob_entry'),
});

/** Same 403 shape for both "invalid format" and "age < 21" — per age-gate-spec.md */
const AGE_GATE_FAILED = NextResponse.json(
  { error: { code: 'AGE_GATE_FAILED', message: 'Age verification failed.' } },
  { status: 403 }
);

/**
 * Compute age in whole years from a date-of-birth string ('YYYY-MM-DD').
 * Returns null if the DOB is unparseable or implausible (future date, > 120 years ago).
 */
function computeAge(dobString: string): number | null {
  const dob = new Date(dobString + 'T00:00:00Z');
  if (isNaN(dob.getTime())) return null;

  const today = new Date();
  const todayUTC = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  );

  if (dob >= todayUTC) return null; // future date
  if (todayUTC.getUTCFullYear() - dob.getUTCFullYear() > 120) return null; // implausible

  let age = todayUTC.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = todayUTC.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && todayUTC.getUTCDate() < dob.getUTCDate())) {
    age--;
  }
  return age;
}

/** SHA-256 of IP address — stored in audit log instead of raw IP for privacy. */
async function hashIp(ip: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(ip);
  const buffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Auth check — must be authenticated to verify age
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } },
      { status: 401 }
    );
  }

  // 2. Parse + validate request body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return AGE_GATE_FAILED; // malformed JSON → same 403 (no info leakage)
  }

  const parsed = AGE_VERIFY_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return AGE_GATE_FAILED; // invalid schema → same 403 (no info leakage)
  }

  const { date_of_birth, method } = parsed.data;

  // 3. Check for existing verification — immutable after pass per age-gate-spec.md
  const { data: profile } = await supabase
    .from('profiles')
    .select('age_verified, date_of_birth')
    .eq('id', user.id)
    .single();

  if (profile?.age_verified) {
    // Already verified — idempotent success
    return NextResponse.json({ verified: true, age_verified_at: null }, { status: 200 });
  }

  // 4. Compute age server-side (never trust client)
  const age = computeAge(date_of_birth);
  const passed = age !== null && age >= 21;

  // 5. Write audit log (service role — bypasses RLS on age_gate_logs)
  const serviceClient = createServiceRoleClient();
  const ipRaw =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown';
  const ipHash = await hashIp(ipRaw);

  const { error: logError } = await serviceClient.from('age_gate_logs').insert({
    user_id: user.id,
    ip_hash: ipHash,
    passed,
    method,
  });

  if (logError) {
    // Audit log failure is loud — this is a compliance requirement
    console.error({ event: 'age_gate_log_write_failed', user_id: user.id, error: logError });
  }

  // 6. Handle failure — return 403 without updating profile
  if (!passed) {
    console.info({ event: 'age_gate_failed', user_id: user.id });
    return AGE_GATE_FAILED;
  }

  // 7. Update profile (service role to ensure write succeeds even if RLS prevents it)
  const now = new Date().toISOString();
  const { error: updateError } = await serviceClient
    .from('profiles')
    .update({
      age_verified: true,
      age_verified_at: now,
      date_of_birth,
      updated_at: now,
    })
    .eq('id', user.id);

  if (updateError) {
    console.error({ event: 'age_gate_profile_update_failed', user_id: user.id, error: updateError });
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Age verification could not be saved. Please try again.' } },
      { status: 500 }
    );
  }

  console.info({ event: 'age_gate_passed', user_id: user.id });

  return NextResponse.json({ verified: true, age_verified_at: now }, { status: 200 });
}
