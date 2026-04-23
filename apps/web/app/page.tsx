import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import type { Database } from '@/lib/types/database';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const cookieStore = await cookies();
  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll() { /* read-only in Server Component */ },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect('/signup');
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('age_verified_at')
    .eq('id', user.id)
    .single();

  if (!profile?.age_verified_at) {
    redirect('/age-gate');
  }

  redirect('/picks/today');
}
