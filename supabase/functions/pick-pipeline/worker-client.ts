/**
 * HTTP client for the Fly.io worker /predict and /rationale endpoints.
 *
 * The worker base URL and API key are read from Supabase Vault at runtime
 * via Deno.env.get(). See docs/infra/secrets-manifest.md — Supabase Vault section.
 *
 * Timeout budget per the TASK-010-pre spec:
 *   - Total Edge Function budget: 30 seconds
 *   - Worker warm response: < 1 second
 *   - Worker cold start: < 7 seconds
 * We use a 25-second abort timeout to leave headroom for DB writes.
 */

import type {
  PickCandidate,
  PredictRequest,
  PredictResponse,
  RationaleRequest,
  RationaleResponse,
} from './types.ts';

const WORKER_TIMEOUT_MS = 25_000;

function getWorkerBase(): string {
  const url = Deno.env.get('MODEL_ENDPOINT_URL');
  if (!url) throw new Error('MODEL_ENDPOINT_URL not set in Supabase Vault');
  return url.replace(/\/$/, '');
}

function getWorkerApiKey(): string {
  const key = Deno.env.get('WORKER_API_KEY');
  if (!key) throw new Error('WORKER_API_KEY not set in Supabase Vault');
  return key;
}

/**
 * Call the Fly.io worker /predict endpoint.
 *
 * Returns an array of PickCandidates for the given game and markets.
 * On timeout or non-2xx: throws — caller is responsible for logging and
 * skipping this game (not aborting the entire pipeline).
 */
export async function callPredict(request: PredictRequest): Promise<PickCandidate[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WORKER_TIMEOUT_MS);

  try {
    const res = await fetch(`${getWorkerBase()}/predict`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getWorkerApiKey()}`,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Worker /predict returned ${res.status}: ${body}`);
    }

    const data: PredictResponse = await res.json();
    return data.candidates ?? [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call the Fly.io worker /rationale endpoint.
 *
 * The worker proxies the Claude API call, selects the appropriate model
 * based on tier (Haiku for pro, Sonnet for elite), and returns the
 * rationale text and metadata.
 *
 * On timeout or non-2xx: throws — caller should write the pick with
 * rationale_id = null rather than dropping the pick entirely.
 */
export async function callRationale(request: RationaleRequest): Promise<RationaleResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WORKER_TIMEOUT_MS);

  try {
    const res = await fetch(`${getWorkerBase()}/rationale`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getWorkerApiKey()}`,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Worker /rationale returned ${res.status}: ${body}`);
    }

    return res.json();
  } finally {
    clearTimeout(timer);
  }
}
