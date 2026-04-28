import { Suspense } from 'react';
import { SlateContent, SlateSkeleton } from '@/components/picks/slate-content';
import { todayInET } from '@/lib/picks/load-slate';

export const dynamic = 'force-dynamic';

export default function PicksTodayPage() {
  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <Suspense fallback={<SlateSkeleton />}>
        <SlateContent pickDate={todayInET()} mode="today" />
      </Suspense>
    </div>
  );
}
