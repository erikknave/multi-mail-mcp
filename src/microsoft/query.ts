/**
 * Translates the Gmail query syntax the tools document into what Microsoft
 * Graph understands.
 *
 * Presenting one query language is the whole point: an agent that has learned
 * `from:anna after:2026/01/01 has:attachment` should not have to learn a second
 * dialect because a mailbox happens to live at Microsoft. Graph offers two
 * mutually exclusive mechanisms and neither covers everything:
 *
 *  - `$search` takes KQL, which handles from/to/cc/subject/body/attachments/
 *    dates and free text, but forbids `$orderby` and cannot express read or
 *    flagged state.
 *  - `$filter` is exact and can be ordered by date, but has no substring match
 *    on addresses or subjects and no free-text search at all.
 *
 * So: if anything in the query needs KQL we search and apply the rest in
 * memory; otherwise we filter, which is both exact and correctly ordered.
 */

export type SearchMode = 'search' | 'filter';

export interface TranslatedQuery {
  mode: SearchMode;
  /** KQL for $search, when mode is 'search'. */
  kql: string | null;
  /** OData for $filter, when mode is 'filter'. */
  odataFilter: string | null;
  /** Well-known folder to scope the request to, e.g. 'inbox'. */
  folder: string | null;
  /** Applied to the fetched messages, for state $search cannot express. */
  requireUnread: boolean | null;
  requireFlagged: boolean;
  /** Query fragments with no Graph equivalent, so the caller can say so. */
  unsupported: string[];
}

/**
 * A lower bound old enough to exclude nothing, used to put receivedDateTime at
 * the front of every filter. See where it is applied for why that is needed.
 */
const ORDERABLE_PREFIX = 'receivedDateTime ge 1970-01-01T00:00:00Z';

/**
 * Adds "and not in these folders" to a filter, keeping receivedDateTime first.
 *
 * Excluding Junk and Deleted Items after the fact instead — fetching $top=N and
 * then dropping some — lets deleted mail eat the result slots: a mailbox whose
 * newest message sits in the bin answered a one-result search with nothing at
 * all, which reads as "no mail" rather than "the newest is deleted". Graph
 * accepts `parentFolderId ne`, so the server can do it exactly.
 */
export function excludeFolders(filter: string | null, folderIds: string[]): string | null {
  if (folderIds.length === 0) return filter;

  const exclusions = folderIds.map((id) => `parentFolderId ne '${id.replace(/'/g, "''")}'`);
  const lead = `${ORDERABLE_PREFIX} and `;

  // The prefix has to stay at the front, so peel it off and put it back.
  let rest: string | null = filter;
  if (rest === ORDERABLE_PREFIX) rest = null;
  else if (rest?.startsWith(lead)) rest = rest.slice(lead.length);

  return [ORDERABLE_PREFIX, ...exclusions, ...(rest ? [rest] : [])].join(' and ');
}

/** Gmail's folder-ish names on the left, Graph's well-known folder ids on the right. */
const FOLDERS: Record<string, string> = {
  inbox: 'inbox',
  sent: 'sentitems',
  drafts: 'drafts',
  draft: 'drafts',
  trash: 'deleteditems',
  bin: 'deleteditems',
  spam: 'junkemail',
  junk: 'junkemail',
  archive: 'archive',
};

/** Splits on whitespace but keeps "quoted phrases" together. */
export function tokenize(query: string): string[] {
  const tokens: string[] = [];
  const pattern = /(-?)(?:([a-zA-Z_]+):)?(?:"([^"]*)"|(\S+))/g;

  for (const m of query.matchAll(pattern)) {
    const [raw] = m;
    if (raw.trim()) tokens.push(raw);
  }
  return tokens;
}

interface ParsedToken {
  negated: boolean;
  operator: string | null;
  value: string;
}

function parseToken(token: string): ParsedToken {
  const m = /^(-?)(?:([a-zA-Z_]+):)?(?:"([^"]*)"|(.*))$/.exec(token);
  if (!m) return { negated: false, operator: null, value: token };
  return {
    negated: m[1] === '-',
    operator: m[2]?.toLowerCase() ?? null,
    value: (m[3] ?? m[4] ?? '').trim(),
  };
}

/** Quotes a KQL value only when it needs it, so simple terms stay readable. */
function kqlValue(value: string): string {
  return /^[\w@.+-]+$/.test(value) ? value : `"${value.replace(/"/g, '')}"`;
}

/** Gmail accepts YYYY/MM/DD and YYYY-MM-DD; both become an ISO date. */
function isoDate(value: string): string | null {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}-${mo!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
}

/** `7d`, `2w`, `3m`, `1y` counted back from `reference`. */
function relativeDate(value: string, reference: Date): string | null {
  const m = /^(\d+)([dwmy])$/.exec(value.trim().toLowerCase());
  if (!m) return null;
  const n = Number(m[1]);
  const date = new Date(reference.getTime());
  if (m[2] === 'd') date.setUTCDate(date.getUTCDate() - n);
  if (m[2] === 'w') date.setUTCDate(date.getUTCDate() - n * 7);
  if (m[2] === 'm') date.setUTCMonth(date.getUTCMonth() - n);
  if (m[2] === 'y') date.setUTCFullYear(date.getUTCFullYear() - n);
  return date.toISOString().slice(0, 10);
}

/** `5M`, `100k`, or a plain byte count. */
function sizeInBytes(value: string): number | null {
  const m = /^(\d+)\s*([kmg])?b?$/i.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]?.toLowerCase();
  if (unit === 'k') return n * 1024;
  if (unit === 'm') return n * 1024 * 1024;
  if (unit === 'g') return n * 1024 * 1024 * 1024;
  return n;
}

export function translateQuery(query: string, reference: Date = new Date()): TranslatedQuery {
  const kqlParts: string[] = [];
  const odataParts: string[] = [];
  const unsupported: string[] = [];

  let folder: string | null = null;
  let requireUnread: boolean | null = null;
  let requireFlagged = false;
  /** Set when a term can only be expressed in KQL, forcing search mode. */
  let needsSearch = false;

  const addBoth = (kql: string, odata: string, negated: boolean) => {
    kqlParts.push(negated ? `NOT ${kql}` : kql);
    odataParts.push(negated ? `not (${odata})` : odata);
  };

  const addKqlOnly = (kql: string, negated: boolean) => {
    needsSearch = true;
    kqlParts.push(negated ? `NOT ${kql}` : kql);
  };

  for (const token of tokenize(query)) {
    if (token.toUpperCase() === 'OR' || token.toUpperCase() === 'AND') {
      // KQL uses the same words; in filter mode a bare OR is meaningless, so it
      // forces search mode rather than being silently dropped.
      kqlParts.push(token.toUpperCase());
      needsSearch = true;
      continue;
    }

    const { negated, operator, value } = parseToken(token);
    if (!value && operator !== null) continue;

    switch (operator) {
      case null:
      case 'body':
        addKqlOnly(kqlValue(value), negated);
        break;

      case 'from':
      case 'to':
      case 'cc':
        addKqlOnly(`${operator}:${kqlValue(value)}`, negated);
        break;

      case 'bcc':
        // Not a KQL property and not filterable on a received message.
        unsupported.push(`bcc:${value} (Outlook cannot search Bcc)`);
        break;

      case 'subject':
        addKqlOnly(`subject:${kqlValue(value)}`, negated);
        break;

      case 'filename':
        addKqlOnly(`attachment:${kqlValue(value)}`, negated);
        break;

      case 'has':
        if (value.toLowerCase() === 'attachment' || value.toLowerCase() === 'attachments') {
          addBoth('hasAttachments:true', 'hasAttachments eq true', negated);
        } else {
          unsupported.push(`has:${value}`);
        }
        break;

      case 'is': {
        const state = value.toLowerCase();
        if (state === 'unread') requireUnread = !negated;
        else if (state === 'read') requireUnread = negated;
        else if (state === 'starred' || state === 'flagged' || state === 'important') {
          requireFlagged = !negated;
        } else unsupported.push(`is:${value}`);
        break;
      }

      case 'in':
      case 'label': {
        const target = FOLDERS[value.toLowerCase()];
        if (target) {
          folder = target;
        } else if (value.toLowerCase() === 'anywhere') {
          folder = null;
        } else if (operator === 'label') {
          // Outlook's nearest equivalent of a Gmail label is a category.
          addKqlOnly(`category:${kqlValue(value)}`, negated);
        } else {
          unsupported.push(`in:${value} (no such Outlook folder)`);
        }
        break;
      }

      case 'after':
      case 'newer': {
        const date = isoDate(value);
        if (date) addBoth(`received>=${date}`, `receivedDateTime ge ${date}T00:00:00Z`, negated);
        else unsupported.push(`${operator}:${value}`);
        break;
      }

      case 'before':
      case 'older': {
        const date = isoDate(value);
        if (date) addBoth(`received<=${date}`, `receivedDateTime le ${date}T23:59:59Z`, negated);
        else unsupported.push(`${operator}:${value}`);
        break;
      }

      case 'newer_than': {
        const date = relativeDate(value, reference);
        if (date) addBoth(`received>=${date}`, `receivedDateTime ge ${date}T00:00:00Z`, negated);
        else unsupported.push(`newer_than:${value}`);
        break;
      }

      case 'older_than': {
        const date = relativeDate(value, reference);
        if (date) addBoth(`received<=${date}`, `receivedDateTime le ${date}T23:59:59Z`, negated);
        else unsupported.push(`older_than:${value}`);
        break;
      }

      case 'larger': {
        const bytes = sizeInBytes(value);
        if (bytes !== null) addBoth(`size>${bytes}`, `size gt ${bytes}`, negated);
        else unsupported.push(`larger:${value}`);
        break;
      }

      case 'smaller': {
        const bytes = sizeInBytes(value);
        if (bytes !== null) addBoth(`size<${bytes}`, `size lt ${bytes}`, negated);
        else unsupported.push(`smaller:${value}`);
        break;
      }

      case 'category':
        addKqlOnly(`category:${kqlValue(value)}`, negated);
        break;

      default:
        unsupported.push(`${operator}:${value}`);
    }
  }

  const mode: SearchMode = needsSearch ? 'search' : 'filter';

  if (mode === 'filter') {
    // Read and flagged state are filterable, so in this mode they belong in the
    // query rather than being sifted out of the results afterwards.
    if (requireUnread !== null) odataParts.push(`isRead eq ${requireUnread ? 'false' : 'true'}`);
    if (requireFlagged) odataParts.push("flag/flagStatus eq 'flagged'");

    // Exchange answers "The restriction or sort order is too complex for this
    // operation" when $orderby names a property the $filter does not lead with.
    // `is:unread has:attachment` and `is:starred` both hit it; the same filters
    // are fine once receivedDateTime comes first. An open-ended lower bound
    // satisfies that without excluding anything, which is cheaper than dropping
    // $orderby — that would leave the server free to return any N messages, and
    // "the 20 newest unread" would quietly become "20 unread, some order".
    if (odataParts.length > 0) odataParts.unshift(ORDERABLE_PREFIX);
  }

  return {
    mode,
    kql: mode === 'search' && kqlParts.length ? kqlParts.join(' ') : null,
    odataFilter: mode === 'filter' && odataParts.length ? odataParts.join(' and ') : null,
    folder,
    // In filter mode the query already covers these; leaving them set would
    // filter the same condition twice, which is harmless but misleading.
    requireUnread: mode === 'search' ? requireUnread : null,
    requireFlagged: mode === 'search' ? requireFlagged : false,
    unsupported,
  };
}
