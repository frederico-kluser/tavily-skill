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
// BraveKeyInvalid. It never resolves with a degraded answer from elsewhere.

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
