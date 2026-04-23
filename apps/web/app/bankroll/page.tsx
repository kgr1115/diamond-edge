import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import type { Database } from '@/lib/types/database';
import { BankrollDashboardClient } from './bankroll-client';

export const dynamic = 'force-dynamic';

async function getAuth() {
  const cookieStore = await cookies();
  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll() {},
      },
    }
  );
  const { data: { user } } = await supabase.auth.getUser();
  return { user };
}

export default async function BankrollPage() {
  const { user } = await getAuth();
  if (!user) {
    redirect('/login?redirect=/bankroll');
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-white mb-6">Bankroll Tracker</h1>
      <BankrollDashboardClient />
    </div>
  );
}
