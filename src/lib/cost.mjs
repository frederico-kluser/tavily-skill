// Credit estimation. We model all providers on a unified "credit" scale
// (Tavily uses real credits; Parallel uses processor tiers we map; Brave is
// metered in USD per query, which we model as 1 credit per search).

import { clamp, ceilDiv } from './flags.mjs';

const EXPENSIVE_OK = process.env.SURF_ALLOW_EXPENSIVE === '1'
  || process.env.TAVILY_ALLOW_EXPENSIVE === '1';

// Tavily — matches the public credit table.
function estimateTavily(op, args) {
  switch (op) {
    case 'search':
      return (args.depth === 'advanced' || args.auto) ? 2 : 1;
    case 'extract': {
      const urls = Array.isArray(args.urls) ? args.urls.length : 1;
      const rate = args.depth === 'advanced' ? 2 : 1;
      return ceilDiv(Math.max(urls, 1), 5) * rate;
    }
    case 'map': {
      const limit = clamp(Number(args.limit) || 50, 1, 500);
      const rate = args.instructions ? 2 : 1;
      return ceilDiv(limit, 10) * rate;
    }
    case 'crawl': {
      const limit = clamp(Number(args.limit) || 50, 1, 200);
      const mapRate = args.instructions ? 2 : 1;
      const exRate = args.extractDepth === 'advanced' ? 2 : 1;
      return ceilDiv(limit, 10) * mapRate + ceilDiv(limit, 5) * exRate;
    }
    case 'research':
    case 'research-start': {
      const model = args.model || (op === 'research' ? 'mini' : 'auto');
      if (model === 'mini') return 15;
      return 50;
    }
    default:
      return 0;
  }
}

// Parallel — approximate, since public per-request pricing is opaque.
// Tier mapping: lite ≈ 1, base ≈ 2, core/pro ≈ 5, ultra ≈ 25, ultra8x ≈ 200.
function tierCredits(p) {
  return { lite: 1, base: 2, core: 5, core2x: 8, pro: 8, ultra: 25, ultra2x: 50, ultra4x: 100, ultra8x: 200 }[p] || 2;
}

function estimateParallel(op, args) {
  switch (op) {
    case 'search': {
      const proc = args.processor || (args.depth === 'advanced' ? 'base' : 'lite');
      return tierCredits(proc);
    }
    case 'extract': {
      const urls = Array.isArray(args.urls) ? args.urls.length : 1;
      return Math.max(1, ceilDiv(urls, 5));
    }
    case 'research':
    case 'research-start': {
      const proc = args.processor || ({ mini: 'lite', auto: 'base', pro: 'pro', ultra: 'ultra' }[args.model || 'auto']) || 'base';
      return tierCredits(proc);
    }
    case 'crawl':
    case 'map':
      return Infinity; // not supported, won't be chosen
    default:
      return 0;
  }
}

// Brave — metered at ~$0.003/query for /web/search; we report 1 credit as
// a proxy so the cost guard never blocks Brave searches. Operations Brave
// doesn't support return Infinity so the chain estimator skips them.
function estimateBrave(op, _args) {
  switch (op) {
    case 'search': return 1;
    default:        return Infinity;
  }
}

export function estimateCreditsForChain(operation, args, chain) {
  let worst = 0;
  for (const p of chain) {
    const est = p === 'tavily'   ? estimateTavily(operation, args)
              : p === 'parallel' ? estimateParallel(operation, args)
              : p === 'brave'    ? estimateBrave(operation, args)
              : 0;
    if (Number.isFinite(est) && est > worst) worst = est;
  }
  return worst;
}

export function guardExpensive(operation, args, chain, flags) {
  if (EXPENSIVE_OK || flags['confirm-expensive']) return;
  const estimate = estimateCreditsForChain(operation, args, chain);
  if (estimate > 10) {
    const err = new Error(
      `This '${operation}' is estimated at ~${estimate} credits across providers. Re-run with --confirm-expensive (or set SURF_ALLOW_EXPENSIVE=1) after user approval.`
    );
    err.code = 'EXPENSIVE_BLOCKED';
    throw err;
  }
}
