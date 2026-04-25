import { notFound } from 'next/navigation';
import { paidTiersEnabled } from '@/lib/feature-flags';

export default function GeoBlockedLayout({ children }: { children: React.ReactNode }) {
  if (!paidTiersEnabled()) notFound();
  return children;
}
