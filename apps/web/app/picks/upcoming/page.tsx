import { Suspense } from 'react';
import { SlateContent, SlateSkeleton, addDaysET, LOOKAHEAD_DAYS } from '@/components/picks/slate-content';
import { todayInET } from '@/lib/picks/load-slate';

export const dynamic = 'force-dynamic';

interface PicksUpcomingPageProps {
  searchParams: Promise<{ date?: string }>;
}

function clampUpcomingDate(raw: string | undefined): string {
  const today = todayInET();
  const min = addDaysET(today, 1);
  const max = addDaysET(today, LOOKAHEAD_DAYS);
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return min;
  if (raw < min) return min;
  if (raw > max) return max;
  return raw;
}

export default async function PicksUpcomingPage({ searchParams }: PicksUpcomingPageProps) {
  const params = await searchParams;
  const pickDate = clampUpcomingDate(params.date);

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <Suspense fallback={<SlateSkeleton />}>
        <SlateContent pickDate={pickDate} mode="upcoming" />
      </Suspense>
    </div>
  );
}
