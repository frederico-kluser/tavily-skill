// surf-agent-skill — library entry point (npm package name = `surf-agent-skill`).
// Named exports for each operation. CLI bins live at:
//   bin/surf.mjs              (interactive setup + key validation)
//   bin/surf-research-skill.mjs (multi-provider web search CLI)
//   bin/surf-plan-skill.mjs   (research-grounded planning CLI)
//
// Usage:
//   import { search, extract, research } from 'surf-agent-skill';
//   const r = await search('claude api', { max: 3 });
//
// Keys are auto-discovered (opts > process.env > .env > ~/.config/surf/keys.json).
// Pass `tavilyKeys: [...]` / `parallelKeys: [...]` / `braveKeys: [...]` to override.

export { search, searchParallel } from './lib/api/search.mjs';
export { extract } from './lib/api/extract.mjs';
export { crawl } from './lib/api/crawl.mjs';
export { map } from './lib/api/map.mjs';
export {
  research,
  researchStart,
  researchPoll,
} from './lib/api/research.mjs';

export { discoverKeys, buildInMemoryState } from './env.mjs';
export { setSilent } from './lib/progress.mjs';
