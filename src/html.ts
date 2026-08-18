/**
 * The named entities worth knowing by heart.
 *
 * Numeric references cover everything else, so this only needs the names that
 * actually turn up: the five XML built-ins, the Latin-1 letters that Swedish,
 * German and French senders' clients emit, and the punctuation that word
 * processors introduce on their own.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  aring: 'å', Aring: 'Å', auml: 'ä', Auml: 'Ä', ouml: 'ö', Ouml: 'Ö',
  aelig: 'æ', AElig: 'Æ', oslash: 'ø', Oslash: 'Ø',
  eacute: 'é', Eacute: 'É', egrave: 'è', ecirc: 'ê', agrave: 'à', acirc: 'â',
  uuml: 'ü', Uuml: 'Ü', ucirc: 'û', ugrave: 'ù', ccedil: 'ç', Ccedil: 'Ç',
  ntilde: 'ñ', Ntilde: 'Ñ', szlig: 'ß', iexcl: '¡', iquest: '¿',
  hellip: '…', mdash: '—', ndash: '–', shy: '', bull: '•', middot: '·',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', deg: '°', plusmn: '±', times: '×', divide: '÷',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶',
  copy: '©', reg: '®', trade: '™', dagger: '†', permil: '‰',
};

/**
 * Decodes HTML entities in a single pass.
 *
 * One pass, not one replace per entity: decoding `&amp;` separately from the
 * rest means `&amp;#229;` is first turned into `&#229;` and then decoded again
 * into "å", inventing a character the sender never wrote.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, ref: string) => {
    if (ref.startsWith('#')) {
      const code = ref[1] === 'x' || ref[1] === 'X'
        ? Number.parseInt(ref.slice(2), 16)
        : Number.parseInt(ref.slice(1), 10);
      // Leave anything outside Unicode alone rather than throwing on mangled input.
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    // An unknown name is left as written: it is more likely to be literal text
    // than an entity we failed to recognise.
    return NAMED_ENTITIES[ref] ?? whole;
  });
}

/**
 * Crude but adequate HTML-to-text.
 *
 * Used wherever a provider hands us markup and the caller wants prose: a mail
 * with no text/plain part, or a Teams message, whose body is always HTML.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      // Block-level closes become blank lines so paragraphs stay readable;
      // list and table rows get a single newline.
      .replace(/<\/(p|div|h[1-6]|blockquote|section|article)>/gi, '\n\n')
      .replace(/<\/(tr|li)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
