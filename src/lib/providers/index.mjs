// Provider registry.
//
// There is exactly ONE search provider: Brave. This is a deliberate product
// decision, not an accident of configuration — see references/brave-api.md and
// the v8.0.0 changelog entry.
//
// Why it is structural rather than a convention: the previous version kept
// Tavily, Parallel, Wikipedia and DuckDuckGo here behind comments saying "these
// are only for the free skill" and "research stays keyed-only". Those comments
// did not stop the research orchestrator from silently answering a research
// question out of Wikipedia and exiting 0 when the paid keys were dead. The
// only reliable way to guarantee "Brave, or an honest error" is for no other
// search adapter to exist.
//
// OPENROUTER IS NOT A SEARCH PROVIDER AND MUST NOT BE REMOVED. It is the LLM
// that plans, analyzes and synthesizes (src/lib/ai/*). It owns API keys, so it
// lives in state.mjs PROVIDERS to inherit key rotation and burn tracking, but
// it is absent from every capability chain here and a search can never route
// to it.

import { braveProvider } from './brave.mjs';

export const PROVIDERS = {
  brave: braveProvider,
};

// Operation → the providers able to serve it. One provider, one operation.
//
// Brave's /web/search is a SERP: it returns ranked links and snippets, and no
// page content. Extraction, crawling, site mapping and asynchronous deep
// research have no Brave equivalent on the Search plan, so those verbs were
// removed in v8.0.0 rather than kept as stubs that cannot work.
//
// (Brave does ship a /res/v1/llm/context endpoint that returns pre-extracted
// page text, but it is gated: a Search-plan key without it answers HTTP 400
// OPTION_NOT_IN_PLAN. If you upgrade, that is the endpoint to add here.)
export const capabilityMap = {
  search: ['brave'],
};

export function getProvider(name) {
  return PROVIDERS[name];
}

/** The one search provider, for error messages and setup flows. */
export const SEARCH_PROVIDER = 'brave';
