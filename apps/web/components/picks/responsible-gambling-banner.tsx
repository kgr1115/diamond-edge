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

interface Helpline {
  display: string;
  tel: string;
}

// TODO(legal-review): confirm per-state helpline numbers before production deploy
export const STATE_HELPLINES: Record<string, Helpline> = {
  AZ: { display: '1-800-NEXT-STEP (1-800-639-8783)', tel: 'tel:18006398783' },
  CO: { display: '1-800-GAMBLER (1-800-426-2537)', tel: 'tel:18004262537' },
  IL: { display: '1-800-GAMBLER (1-800-426-2537)', tel: 'tel:18004262537' },
  IN: { display: '1-800-9-WITH-IT (1-800-994-8448)', tel: 'tel:18009948448' },
  IA: { display: '1-800-BETS-OFF (1-800-238-7633)', tel: 'tel:18002387633' },
  MA: { display: '1-800-327-5050', tel: 'tel:18003275050' },
  MI: { display: '1-800-GAMBLER (1-800-426-2537)', tel: 'tel:18004262537' },
  NJ: { display: '1-800-GAMBLER (1-800-426-2537)', tel: 'tel:18004262537' },
  NY: { display: '1-877-8-HOPENY (1-877-846-7369)', tel: 'tel:18778467369' },
  OH: { display: '1-800-589-9966', tel: 'tel:18005899966' },
  PA: { display: '1-800-GAMBLER (1-800-426-2537)', tel: 'tel:18004262537' },
  TN: { display: '1-800-889-9789 (TN REDLINE)', tel: 'tel:18008899789' },
};

export const FALLBACK_HELPLINE: Helpline = {
  display: '1-800-MY-RESET (1-800-697-3738)',
  tel: 'tel:18006973738',
};

export function resolveHelpline(geoState?: string | null): Helpline {
  if (geoState && STATE_HELPLINES[geoState]) {
    return STATE_HELPLINES[geoState];
  }
  return FALLBACK_HELPLINE;
}

export function ResponsibleGamblingBanner({ surface, geoState }: ResponsibleGamblingBannerProps) {
  const helpline = resolveHelpline(geoState);

  if (surface === 'banner') {
    return (
      <div className="bg-amber-950/40 border border-amber-900/60 rounded px-4 py-2 text-xs text-amber-300">
        Diamond Edge provides information only — not financial advice. If gambling affects your life,
        call{' '}
        <a href={helpline.tel} className="underline">
          {helpline.display}
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
      <a href={helpline.tel} className="underline hover:text-gray-300">
        {helpline.display}
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
