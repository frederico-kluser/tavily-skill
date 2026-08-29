// Credit estimation.
//
// Brave is metered per successful request. On the 2026 Search plan that is
// $5.00 per 1,000 requests (~$0.005 each); grandfathered "Free" keys get a
// monthly quota instead. Either way one search is one unit, so we model it as
// one credit and the estimator is trivially exact.
//
// Failed requests — 422, 429 — are NOT billed, which is what makes the free
// key-validation probe in providers/brave.mjs possible.

const EXPENSIVE_OK = process.env.SURF_ALLOW_EXPENSIVE === '1';

function estimateBrave(op) {
  return op === 'search' ? 1 : 0;
}

export function estimateCreditsForChain(operation, _args, chain) {
  let worst = 0;
  for (const p of chain) {
    const est = p === 'brave' ? estimateBrave(operation) : 0;
    if (Number.isFinite(est) && est > worst) worst = est;
  }
  return worst;
}

/**
 * Kept as a safety net for future expensive operations. With Brave as the only
 * backend the maximum estimate for any single call is 1, so this can no longer
 * fire on a plain search — the real cost control is the per-run fan-out ceiling
 * (--sub-agents) and the rate limiter, not this guard.
 */
export function guardExpensive(operation, args, chain, flags) {
  if (EXPENSIVE_OK || flags['confirm-expensive']) return;
  const estimate = estimateCreditsForChain(operation, args, chain);
  if (estimate > 10) {
    const err = new Error(
      `This '${operation}' is estimated at ~${estimate} credits. Re-run with --confirm-expensive (or set SURF_ALLOW_EXPENSIVE=1) after user approval.`
    );
    err.code = 'EXPENSIVE_BLOCKED';
    throw err;
  }
}
