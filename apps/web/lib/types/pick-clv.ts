/**
 * Typed interfaces for the pick_clv table (migration 0011).
 *
 * pick_clv was added after the last `supabase gen types` run, so the table is
 * absent from database.ts. These hand-maintained types replace the `as any`
 * casts in clv-compute and clv-summary until the project runs:
 *   npx supabase gen types typescript --project-id wdxqqoafigbnwfqturmv
 *
 * Fields mirror the CREATE TABLE in 0011_clv_tracking.sql exactly.
 */

export interface PickClvRow {
  pick_id: string;
  pick_time_novig_prob: number;
  closing_novig_prob: number | null;
  clv_edge: number | null;
  computed_at: string;
}

export interface PickClvInsert {
  pick_id: string;
  pick_time_novig_prob: number;
  closing_novig_prob?: number | null;
  clv_edge?: number | null;
  computed_at?: string;
}

/**
 * pick_clv joined with its parent pick (used by clv-summary).
 *
 * Supabase PostgREST returns foreign-table joins as an array when the
 * relationship isn't declared 1:1 in the schema. `pick_clv.pick_id` is a PK
 * (1:1 with picks), but without that declaration the client returns an array.
 * We normalise to a single-object shape after fetching.
 */
export interface PickClvWithPick extends PickClvRow {
  picks: {
    pick_date: string;
    market: string;
  } | null;
}

/** Raw shape returned by Supabase before normalisation (picks is an array). */
export interface PickClvWithPickRaw extends PickClvRow {
  picks: Array<{ pick_date: string; market: string }>;
}

/**
 * Supabase client helper: typed `.from('pick_clv')` accessor.
 *
 * Usage:
 *   import { pickClvFrom } from '@/lib/types/pick-clv';
 *   const { data } = await pickClvFrom(serviceClient).select('*').eq('pick_id', id);
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<Database> | SupabaseClient<any>;

export function pickClvFrom(client: AnyClient) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (client as SupabaseClient<any>).from('pick_clv');
}
