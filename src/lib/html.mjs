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
//   0. settle the characters that are not text: delete the ones that can
//      neither be seen nor mean anything, and give the ones that can REORDER
//      what is seen a printable name instead;
//   1. strip the markup that is REALLY in the input (comments, script/style
//      bodies, tags);
//   2. decode entities ONCE (single pass, so `&amp;lt;` stays `&lt;`);
//   3. neutralise anything TAG-SHAPED that step 2 just materialised.
//
// Step 0 is FIRST, and that position is load-bearing in the same way step 3's
// is. A character nobody can see is invisible to every rule below it, so
// `<\x00script>` — and equally `<`, a ZERO WIDTH SPACE, `script>` — reads as
// prose to step 1, and deleting the NUL after step 3 would hand the caller a
// live `<script>` the gate had just certified was absent. Removed before
// anything parses, the same input is simply a script tag and is stripped as
// one. Entities cannot smuggle one past step 0 either: safeChar refuses to
// materialise any of these at step 2, so `&#0;` and `&#8203;` decode to
// nothing at all.
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
//
// Step 0 carries a POST-CONDITION of its own, and it is the twin of step 3's:
// **the returned string contains no character that can change the order in
// which the characters around it are read.** What this file returns is read
// three times — by a human in the report, by a JSON ledger, and by the model
// that writes the answer and cites it. A character that makes any two of those
// three read a different sentence out of the same bytes is not formatting, it
// is forged evidence, and step 0 is where that is settled.

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', times: '×', middot: '·', bull: '•',
};

export function decodeEntities(s) {
  // Text in, text out — documented, and now actually true. A non-string used to
  // be handed straight back, so decodeEntities(123) returned the NUMBER 123 and
  // the caller only found out at its next `.replace`, a stack frame away from
  // the mistake. stripHtml has answered '' to a non-string all along; this is
  // the same answer, given by the same file.
  if (typeof s !== 'string') return '';
  if (!s.includes('&')) return s;
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => {
      const v = ENTITIES[name.toLowerCase()];
      return v === undefined ? m : v;
    });
}

// ======================================= step 0: characters that are not text
// Three kinds, three different answers, and one rule separates them: DELETING
// a character is only allowed when removing it changes no glyph and no word in
// any writing system. A deletion nobody can see is exactly the evidence
// corruption this file exists to prevent — it is why `5 < 10` is untouched.
//
// (a) DELETED — invisible, and meaningless everywhere.
//     C0 controls and DEL are bytes, not text: a NUL terminates the string in
//     any C consumer downstream and the rest are simply invisible on the way
//     to a JSON ledger and an LLM prompt, so a decoded `&#0;` corrupts
//     evidence no reader can see is corrupted. The three C0 codes that are
//     genuinely whitespace (TAB, LF, CR) are text and stay.
//     C1 controls (U+0080–U+009F) are the same argument one block up. No page
//     means them as text; they render as nothing or as a box. (When parsing a
//     DOCUMENT, HTML5 remaps `&#128;`–`&#159;` to their Windows-1252
//     characters. Brave hands us JSON, not a document, and a 32-entry mojibake
//     table is a bigger promise than this file makes — so they are dropped,
//     not guessed at.)
//     ZWSP (U+200B), WORD JOINER (U+2060) and BOM/ZWNBSP (U+FEFF) are
//     invisible line-break hints. Remove one and no script renders
//     differently, so they pass the deletion rule. Keeping them fails the
//     other half of it: an invisible character splits a token for a matcher
//     and not for a reader, and U+FEFF is in JavaScript's own `\s` class, so
//     it is whitespace to some of the regexes below and not to others — a
//     parser differential inside the sanitiser itself.
//
//     ZWNJ (U+200C) and ZWJ (U+200D) FAIL the deletion rule and are KEPT.
//     ZWNJ is the difference between two Persian words and suppresses a
//     Devanagari conjunct. ZWJ is what holds an emoji sequence together — a
//     family emoji is three people joined by two ZWJs, and every profession
//     and skin-tone emoji is built the same way — and it forces an Indic
//     conjunct. Deleting either one rewrites text. They are invisible, but
//     they are not meaningless, and "invisible" alone was never the rule.
//
// (b) MARKED, not deleted — the bidi overrides, embeddings and isolates
//     (U+202A–U+202E, U+2066–U+2069). U+202E RIGHT-TO-LEFT OVERRIDE makes the
//     text after it render backwards while the model reads it forwards: one
//     byte, two readers, two different sentences. That is the technique that
//     hid malicious code from source review; here the surface is the evidence
//     the model quotes.
//     Legitimate right-to-left text does not need them. Direction is a
//     property of the characters themselves — UAX #9 takes the paragraph
//     direction from the first strong character (P2/P3) and reverses the runs
//     (L2) — and Unicode's whole Bidi_Control set is twelve characters, not
//     one of which is a letter. A real Arabic or Hebrew sentence contains none
//     of them and still displays right-to-left.
//     All nine get the same answer so no half-state is left behind: mark the
//     RLO but keep the PDF that closed it and the string still carries
//     dangling bidi state. With all nine named, the output cannot be reordered
//     at all.
//     They are MARKED rather than deleted because their presence is itself the
//     finding. Deleting an RLO hands the report a snippet that looks clean and
//     never says it was tampered with. `[U+202E]` is inert ASCII — no `<`, no
//     `&`, so it cannot reopen step 3's hole — and it keeps the tampering in
//     all three copies of the record, which is the point.
//     The implicit MARKS (U+200E LRM, U+200F RLM, U+061C ALM) are left alone.
//     They resolve the direction of the NEUTRAL characters beside them and
//     cannot reverse a run of strong ones, so they cannot produce the two
//     readings above, and they are genuinely used to place punctuation in
//     mixed-direction text.
//
// (c) DELETED, with one carve-out — the TAG characters (U+E0000–U+E007F).
//     Unicode withdrew them from language tagging and re-used U+E0020–U+E007F
//     for one thing: the emoji tag sequences spelling the flags of England,
//     Scotland and Wales, which always begin at U+1F3F4 and end at U+E007F.
//     Inside such a sequence they ARE the flag and are kept. Anywhere else
//     they are an invisible ASCII channel — a full printable message the model
//     reads and the human cannot see, the RLO's asymmetry turned all the way
//     up. Deleted rather than marked: a smuggled payload is as long as its
//     author likes, and one marker per character would bury the snippet it was
//     meant to annotate.

function isControlCode(code) {
  return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
    || (code >= 0x7f && code <= 0x9f);
}
/** Invisible, and no script renders differently once it is gone. */
function isInvisibleCode(code) {
  return code === 0x200b || code === 0x2060 || code === 0xfeff
    || (code >= 0xe0000 && code <= 0xe007f);
}
/** Can reorder what is displayed. Named in the output rather than removed. */
function isBidiCode(code) {
  return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}
const bidiMark = (code) => `[U+${code.toString(16).toUpperCase().padStart(4, '0')}]`;

// DEL and C1 are contiguous, hence the single \x7f-\x9f range.
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
const INVISIBLE_CHARS = /[\u200b\u2060\ufeff]/g;
const BIDI_CHARS = /[\u202a-\u202e\u2066-\u2069]/g;
// A whole emoji tag sequence: the waving black flag, its tag letters and its
// terminator. Matched so it can be stepped OVER, never stripped.
const EMOJI_TAG_SEQ = /\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}/gu;
const TAG_CHARS = /[\u{E0000}-\u{E007F}]/gu;

/** Delete stray tag characters, keeping the ones that spell a flag. */
function dropStrayTagChars(s) {
  TAG_CHARS.lastIndex = 0;
  if (!TAG_CHARS.test(s)) { TAG_CHARS.lastIndex = 0; return s; }
  TAG_CHARS.lastIndex = 0;
  let out = '';
  let last = 0;
  for (const m of s.matchAll(EMOJI_TAG_SEQ)) {
    out += s.slice(last, m.index).replace(TAG_CHARS, '') + m[0];
    last = m.index + m[0].length;
  }
  return out + s.slice(last).replace(TAG_CHARS, '');
}

/** Step 0. Runs before anything parses, for the reason in the header. */
function scrubUnicode(s) {
  return dropStrayTagChars(s)
    .replace(CONTROL_CHARS, '')
    .replace(INVISIBLE_CHARS, '')
    .replace(BIDI_CHARS, (c) => bidiMark(c.codePointAt(0)));
}

function safeChar(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  if (isControlCode(code) || isInvisibleCode(code)) return '';
  // An entity is the same character with more steps; answer it the same way.
  if (isBidiCode(code)) return bidiMark(code);
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

/**
 * Settle the characters that are not text, strip tags, decode entities,
 * collapse whitespace. Never returns null, never returns a control character,
 * and never returns a character that reorders the text around it.
 */
export function stripHtml(s) {
  if (typeof s !== 'string' || !s) return '';
  return neutralizeTags(decodeEntities(stripTags(scrubUnicode(s))))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
