// Minimal HTML → text. Brave's snippets arrive with <strong> highlight markup
// around every query-term match and HTML entities in the body; both used to be
// piped verbatim into markdown output and into LLM prompts.
//
// We ask Brave for text_decorations=0, which removes the highlight tags at the
// source, but snippets still carry entities and the occasional inline tag, and
// a defensive strip costs nothing.
//
// ORDER OF OPERATIONS — this is the whole argument of the file:
//
//   1. strip the markup that is REALLY in the input (comments, script/style
//      bodies, tags);
//   2. decode entities ONCE (single pass, so `&amp;lt;` stays `&lt;`);
//   3. neutralise anything TAG-SHAPED that step 2 just materialised.
//
// Step 3 is the step a naive sanitiser is missing, and its absence is the
// classic sanitiser bug: strip-then-decode turns `&lt;script&gt;` into a live
// `<script>` AFTER the cleaning is over, so the sanitiser emits the exact
// markup it was called to remove.
//
// Decoding first would close that hole and open a worse one: every snippet
// that is ABOUT html ("use &lt;strong&gt; for bold") would have its example
// deleted as if it were markup. So the decode stays last and the output is put
// through one final gate whose post-condition is: **the returned string
// contains no substring an HTML parser would open a tag on.**
//
// The gate ENCODES rather than deletes, so the evidence survives, and it only
// fires on a real tag open — `<` followed by a letter, `/`, `!` or `?`, which
// is the HTML5 tokenizer's own rule. A bare `<` that opens nothing ("5 < 10")
// is left exactly as it is: mangling it corrupts the evidence the model is
// asked to reason about, which was the other half of the same bug.
//
// Step 1 deletes only tokens whose NAME is a real html element (or a namespaced
// / custom one, `o:p` and `my-widget`). `List<Int>` and `Array<String>` are not
// markup by any reading, so they are not deleted — they fall through to step 3
// and come out as printable text. Deleting them was how a snippet about
// generics used to reach the model as "Array vs List".

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

// A tag open, per the HTML5 tokenizer: `<` followed by a letter (start tag),
// `/` (end tag), or `!`/`?` (comment, doctype, processing instruction).
// Everything else after `<` is literal text — that is why "5 < 10" is safe.
const TAG_OPEN = /<(?=[a-zA-Z/!?])/g;
// Every html element name. Used to tell markup apart from prose that merely
// looks like markup; anything outside it is kept and encoded, never dropped.
const HTML_TAGS = new Set((
  'a abbr acronym address applet area article aside audio b base basefont bdi bdo big ' +
  'blockquote body br button canvas caption center cite code col colgroup data datalist ' +
  'dd del details dfn dialog dir div dl dt em embed fieldset figcaption figure font footer ' +
  'form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins ' +
  'kbd label legend li link main map mark marquee menu meta meter nav nobr noframes noscript ' +
  'object ol optgroup option output p param picture pre progress q rp rt ruby s samp script ' +
  'search section select slot small source span strike strong style sub summary sup svg table ' +
  'tbody td template textarea tfoot th thead time title tr track tt u ul var video wbr'
).split(' '));

/** Is this token name markup, or is it prose that merely looks like a tag? */
function isElementName(name) {
  // `o:p` (Word), `my-widget` (custom elements): namespaced or hyphenated names
  // are always markup, and no prose spells a generic that way.
  return HTML_TAGS.has(name.toLowerCase()) || /[-:]/.test(name);
}
// A complete tag-shaped token: the same opener, closed by the next `>` with no
// `<` in between (so `<scr<script>` cannot be spliced back together).
const TAG_SHAPED = /<(\/?[a-zA-Z!?][^<>]*)>/g;

/** Step 1: remove markup that is genuinely present in the source. */
function stripTags(s) {
  return s
    // Comments first: their body may contain anything, `>` included.
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    // Script/style bodies. The `|$` arm is load-bearing: a snippet truncated
    // mid-script has no closing tag, and without it the generic rule below
    // would delete `<script>` and keep the code that followed it.
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/?([a-zA-Z][^\s/>]*)[^>]*>/g, (m, name) => (isElementName(name) ? '' : m))
    .replace(/<[!?][^>]*>/g, '');
}

/** Step 3: the post-condition gate. Nothing tag-shaped survives this. */
function neutralizeTags(s) {
  if (!s.includes('<')) return s;
  return s
    // A whole tag becomes its own printable text: `<b>` → `&lt;b&gt;`.
    .replace(TAG_SHAPED, '&lt;$1&gt;')
    // A dangling opener (`…<b` at the end of a truncated snippet) could still
    // meet a `>` downstream once this string is concatenated with anything.
    .replace(TAG_OPEN, '&lt;');
}

/** Strip tags, decode entities, collapse whitespace. Never returns null. */
export function stripHtml(s) {
  if (typeof s !== 'string' || !s) return '';
  return neutralizeTags(decodeEntities(stripTags(s)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
