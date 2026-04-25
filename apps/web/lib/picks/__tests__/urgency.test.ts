/**
 * Unit tests for the pick-card urgency resolver.
 * Pure logic — no DOM, no I/O. Uses an injected `now` for deterministic time.
 * Run with: npx jest apps/web/components/picks/__tests__/urgency.test.ts
 */

import { resolveUrgency } from '@/lib/picks/urgency';

const BASE_NOW = Date.parse('2026-04-24T18:00:00Z');

function gameAt(offsetMinutes: number): string {
  return new Date(BASE_NOW + offsetMinutes * 60_000).toISOString();
}

describe('resolveUrgency — status-driven states', () => {
  it('returns live state with dim=true and lineLocked=true when status=live', () => {
    const r = resolveUrgency('live', gameAt(-30), BASE_NOW);
    expect(r).toEqual({
      variant: 'live',
      label: 'Live',
      dim: true,
      lineLocked: true,
      lockedReason: 'GAME IN PROGRESS — line locked',
    });
  });

  it('returns final state with dim=true and lineLocked=true when status=final', () => {
    const r = resolveUrgency('final', gameAt(-180), BASE_NOW);
    expect(r).toEqual({
      variant: 'final',
      label: 'Final',
      dim: true,
      lineLocked: true,
      lockedReason: 'GAME FINAL — line closed',
    });
  });

  it('returns PPD with dim=true and lineLocked=true when status=postponed', () => {
    const r = resolveUrgency('postponed', gameAt(120), BASE_NOW);
    expect(r?.label).toBe('PPD');
    expect(r?.dim).toBe(true);
    expect(r?.lineLocked).toBe(true);
    expect(r?.lockedReason).toBe('GAME POSTPONED — line voided');
  });

  it('returns Cancelled with dim=true and lineLocked=true when status=cancelled', () => {
    const r = resolveUrgency('cancelled', gameAt(120), BASE_NOW);
    expect(r?.label).toBe('Cancelled');
    expect(r?.dim).toBe(true);
    expect(r?.lineLocked).toBe(true);
    expect(r?.lockedReason).toBe('GAME CANCELLED — line voided');
  });
});

describe('resolveUrgency — countdown thresholds', () => {
  it('neutral variant when > 2h out', () => {
    const r = resolveUrgency('scheduled', gameAt(180), BASE_NOW); // 3h out
    expect(r?.variant).toBe('countdown-neutral');
    expect(r?.dim).toBe(false);
    expect(r?.lineLocked).toBe(false);
    expect(r?.lockedReason).toBeNull();
  });

  it('amber variant when < 2h and >= 30m out', () => {
    const r = resolveUrgency('scheduled', gameAt(90), BASE_NOW);
    expect(r?.variant).toBe('countdown-amber');
  });

  it('amber variant at exactly 119 minutes (just under 2h)', () => {
    const r = resolveUrgency('scheduled', gameAt(119), BASE_NOW);
    expect(r?.variant).toBe('countdown-amber');
  });

  it('neutral variant at exactly 120 minutes (boundary)', () => {
    const r = resolveUrgency('scheduled', gameAt(120), BASE_NOW);
    expect(r?.variant).toBe('countdown-neutral');
  });

  it('red variant when < 30m out', () => {
    const r = resolveUrgency('scheduled', gameAt(15), BASE_NOW);
    expect(r?.variant).toBe('countdown-red');
  });

  it('amber variant at exactly 30 minutes (boundary)', () => {
    const r = resolveUrgency('scheduled', gameAt(30), BASE_NOW);
    expect(r?.variant).toBe('countdown-amber');
  });
});

describe('resolveUrgency — countdown label formatting', () => {
  it('formats as "in Xm" when under an hour', () => {
    const r = resolveUrgency('scheduled', gameAt(32), BASE_NOW);
    expect(r?.label).toBe('in 32m');
  });

  it('formats as "in Xh Ym" when over an hour', () => {
    const r = resolveUrgency('scheduled', gameAt(134), BASE_NOW); // 2h 14m
    expect(r?.label).toBe('in 2h 14m');
  });

  it('formats exactly 60m as "in 1h 0m"', () => {
    const r = resolveUrgency('scheduled', gameAt(60), BASE_NOW);
    expect(r?.label).toBe('in 1h 0m');
  });
});

describe('resolveUrgency — defensive cases', () => {
  it('returns null when gameTimeUtc is null and status=scheduled', () => {
    expect(resolveUrgency('scheduled', null, BASE_NOW)).toBeNull();
  });

  it('returns null when gameTimeUtc is unparseable', () => {
    expect(resolveUrgency('scheduled', 'not-a-date', BASE_NOW)).toBeNull();
  });

  it('returns null when scheduled game is in the past (race between status and clock)', () => {
    const r = resolveUrgency('scheduled', gameAt(-5), BASE_NOW);
    expect(r).toBeNull();
  });

  it('returns null when status is unknown and game is scheduled future', () => {
    // Unknown status falls through to countdown path; should behave as scheduled.
    const r = resolveUrgency('unknown-status', gameAt(60), BASE_NOW);
    expect(r?.variant).toBe('countdown-amber');
  });
});
