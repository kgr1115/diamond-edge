/**
 * Surface 1 — Responsible gambling banner for picks pages.
 * Per docs/compliance/copy/responsible-gambling.md Surface 1.
 *
 * Accepts a surface prop to choose between the slim banner (top of slate)
 * and the footer disclaimer (sticky footer on pick pages).
 */

interface ResponsibleGamblingBannerProps {
  surface: 'banner' | 'footer';
  /** User's declared state code (e.g. 'NY') for state-specific helpline injection. */
  geoState?: string | null;
}

const STATE_HELPLINES: Record<string, string> = {
  NY: '1-877-8-HOPENY (467-369)',
  NJ: '1-800-GAMBLER (426-2537)',
  PA: '1-800-GAMBLER',
  OH: '1-800-589-9966',
  MI: '1-800-270-7117',
  IL: '1-800-GAMBLER',
  CO: '1-800-522-4700',
  MA: '1-800-327-5050',
};

function getHelpline(geoState?: string | null): string {
  if (geoState && STATE_HELPLINES[geoState]) {
    return STATE_HELPLINES[geoState];
  }
  return '1-800-522-4700';
}

export function ResponsibleGamblingBanner({ surface, geoState }: ResponsibleGamblingBannerProps) {
  const helpline = getHelpline(geoState);

  if (surface === 'banner') {
    return (
      <div className="bg-amber-950/40 border border-amber-900/60 rounded px-4 py-2 text-xs text-amber-300">
        Diamond Edge provides information only — not financial advice. If gambling affects your life,
        call{' '}
        <a href="tel:18005224700" className="underline">
          {helpline}
        </a>
        .
      </div>
    );
  }

  // footer variant
  return (
    <div className="border-t border-gray-800 mt-8 pt-4 text-xs text-gray-500 leading-relaxed">
      Diamond Edge is an information and analysis service. We do not place bets or hold funds. Sports
      betting involves real financial risk. Past pick performance does not guarantee future results. If
      you or someone you know is struggling with problem gambling, free, confidential help is available
      24/7 at{' '}
      <a href="tel:18005224700" className="underline hover:text-gray-300">
        {helpline}
      </a>{' '}
      or{' '}
      <a
        href="https://ncpgambling.org"
        target="_blank"
        rel="noopener noreferrer"
        className="underline hover:text-gray-300"
      >
        ncpgambling.org
      </a>
      .
    </div>
  );
}
