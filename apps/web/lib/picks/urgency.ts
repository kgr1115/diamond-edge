/**
 * Pick-card urgency resolver — time-to-first-pitch + game-state badge logic.
 * Pure so it can be unit-tested without a DOM.
 *
 * Thresholds (product tunables):
 *   - red:     < 30 minutes to first pitch
 *   - amber:   < 120 minutes (and >= 30)
 *   - neutral: >= 120 minutes
 * Non-scheduled statuses (live/final/postponed/cancelled) return a dim state
 * so the card can be de-emphasized — the market is no longer bettable.
 */

export type UrgencyVariant =
  | 'countdown-neutral'
  | 'countdown-amber'
  | 'countdown-red'
  | 'live'
  | 'final'
  | 'off';

export interface UrgencyState {
  variant: UrgencyVariant;
  label: string;
  /** True when the card should be visually de-emphasized (no longer bettable). */
  dim: boolean;
}

const AMBER_THRESHOLD_MIN = 120;
const RED_THRESHOLD_MIN = 30;

function formatCountdown(minutesUntil: number): string {
  const total = Math.max(0, Math.round(minutesUntil));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours <= 0) return `in ${minutes}m`;
  return `in ${hours}h ${minutes}m`;
}

export function resolveUrgency(
  status: string,
  gameTimeUtc: string | null,
  now: number,
): UrgencyState | null {
  if (status === 'live') return { variant: 'live', label: 'Live', dim: true };
  if (status === 'final') return { variant: 'final', label: 'Final', dim: true };
  if (status === 'postponed') return { variant: 'off', label: 'PPD', dim: true };
  if (status === 'cancelled') return { variant: 'off', label: 'Cancelled', dim: true };

  if (!gameTimeUtc) return null;
  const startMs = Date.parse(gameTimeUtc);
  if (Number.isNaN(startMs)) return null;

  const minutesUntil = (startMs - now) / 60000;
  if (minutesUntil <= 0) return null;

  let variant: UrgencyVariant = 'countdown-neutral';
  if (minutesUntil < RED_THRESHOLD_MIN) variant = 'countdown-red';
  else if (minutesUntil < AMBER_THRESHOLD_MIN) variant = 'countdown-amber';

  return { variant, label: formatCountdown(minutesUntil), dim: false };
}
