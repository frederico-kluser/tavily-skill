// Minimal HTML → text. Brave's snippets arrive with <strong> highlight markup
// around every query-term match and HTML entities in the body; both used to be
// piped verbatim into markdown output and into LLM prompts.
//
// We ask Brave for text_decorations=0, which removes the highlight tags at the
// source, but snippets still carry entities and the occasional inline tag, and
// a defensive strip costs nothing.

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', times: '×', middot: '·', bull: '•',
};

export function decodeEntities(s) {
  if (typeof s !== 'string' || !s.includes('&')) return s || '';
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => {
      const v = ENTITIES[name.toLowerCase()];
      return v === undefined ? m : v;
    });
}

function safeChar(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try { return String.fromCodePoint(code); } catch { return ''; }
}

/** Strip tags, decode entities, collapse whitespace. Never returns null. */
export function stripHtml(s) {
  if (typeof s !== 'string' || !s) return '';
  return decodeEntities(
    s
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  ).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
