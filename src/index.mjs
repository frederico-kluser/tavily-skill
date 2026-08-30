// surf-agent-skill — library entry point.
//
// Usage:
//   import { search, searchParallel } from 'surf-agent-skill';
//   const r = await search('claude api', { max: 3 });
//
// Keys are auto-discovered (opts > process.env > .env > ~/.config/surf/keys.json).
// Pass `braveKeys: [...]` to override.
//
// v8 is Brave-only. Every call goes through the same key gate as the CLI: if no
// valid Brave key can be identified, the promise rejects with a GateError whose
// `code` is one of BraveKeyMissing / BraveKeyBurned / BraveKeyCooling /
// BraveKeyInvalid / BraveKeyUnverified. It never resolves with a degraded
// answer from elsewhere.
//
// All five codes start with `BraveKey`, so /^BraveKey/.test(e.code) still
// catches the whole family. Two of them must not be confused:
//
//   BraveKeyInvalid     Brave ANSWERED and rejected the token (a 401/403/402 or
//                       SUBSCRIPTION_TOKEN_INVALID). Only this is a fact about
//                       the key. The verdict is cached for up to 7 days, so
//                       clear it (`surf-research-skill keys reset --provider
//                       brave`) and let it re-probe before deleting anything —
//                       re-testing is free.
//
//   BraveKeyUnverified  Nobody answered: a dropped connection, DNS, a timeout,
//                       a 5xx, or a status no one can attribute (captive
//                       portal, corporate proxy). That is a fact about the PATH
//                       to Brave, not about the key, so NO verdict is written
//                       and the key stays unvalidated — the next run re-probes
//                       it for free. Fix the network and retry; never remove a
//                       key on account of this one.
//
// The rule is a whitelist: only `kind === 'auth'` convicts a key. See
// `provesKeyBad` and GATE.UNREACHABLE in ./lib/preflight.mjs.

export { search, searchParallel } from './lib/api/search.mjs';

export { discoverKeys, buildInMemoryState } from './env.mjs';
export { setSilent } from './lib/progress.mjs';
export { GateError, EXIT_CONFIG, gateStatus, assertProviderReady } from './lib/preflight.mjs';

// Removed in v8.0.0. These are exported as throwing stubs rather than simply
// deleted: a missing named export is a hard SyntaxError at import time, which
// would break a downstream file that merely mentions them without calling them.
function removed(name, why) {
  return async () => {
    const e = new Error(
      `${name}() was removed in surf-agent-skill v8.0.0. ${why} ` +
      `Brave's /web/search is a SERP: it returns ranked links and snippets, and no page content. ` +
      `Use search() and follow the returned URLs with your own fetch/reader.`,
    );
    e.code = 'RemovedInV8';
    throw e;
  };
}

export const extract = removed('extract', 'Brave has no extraction endpoint on the Search plan.');
export const crawl = removed('crawl', 'Brave has no crawl endpoint.');
export const map = removed('map', 'Brave has no site-map endpoint.');
export const research = removed('research', 'The surf-ai loop (searchParallel + your own synthesis, or the surf-search-* CLIs) replaces it.');
export const researchStart = removed('researchStart', 'Brave has no asynchronous research API.');
export const researchPoll = removed('researchPoll', 'Brave has no asynchronous research API.');
