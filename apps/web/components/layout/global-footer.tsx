import Link from 'next/link';
import { FALLBACK_HELPLINE } from '@/components/picks/responsible-gambling-banner';

/**
 * Surface 4 — Site-wide footer with responsible gambling copy.
 * Per docs/compliance/copy/responsible-gambling.md Surface 4.
 * Present on every page, every session.
 */
export function GlobalFooter() {
  return (
    <footer className="border-t border-gray-800 bg-gray-950 py-6 px-4 mt-auto">
      <div className="max-w-6xl mx-auto space-y-3">
        <p className="text-xs text-gray-400 leading-relaxed">
          Diamond Edge is an information service. We do not place bets or hold funds on your behalf.{' '}
          <strong className="text-gray-300">21+ only.</strong> Available only where DraftKings and FanDuel legally
          operate. Problem gambling? Call{' '}
          <a href={FALLBACK_HELPLINE.tel} className="underline hover:text-white">
            {FALLBACK_HELPLINE.display}
          </a>{' '}
          (24/7, free, confidential).
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
          <Link href="/terms" className="hover:text-gray-300">
            Terms of Service
          </Link>
          <Link href="/privacy" className="hover:text-gray-300">
            Privacy Policy
          </Link>
          <Link href="/responsible-gambling" className="hover:text-gray-300">
            Responsible Gambling
          </Link>
          <span className="text-gray-600">© {new Date().getFullYear()} Diamond Edge</span>
        </div>
      </div>
    </footer>
  );
}
