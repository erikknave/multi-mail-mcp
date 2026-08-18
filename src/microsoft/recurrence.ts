/**
 * Converts between the RRULE strings the calendar tools accept and the
 * structured pattern Microsoft Graph uses.
 *
 * Google Calendar speaks RFC 5545 directly, so the tools took RRULEs and an
 * agent has learned to write them. Graph instead takes an object with a pattern
 * and a range, expressing a subset of the same ideas. Translating keeps one
 * input format across both providers; anything the subset genuinely cannot hold
 * is refused by name rather than silently dropped.
 */
import { ServiceError } from '../serviceError.js';

export interface GraphRecurrence {
  pattern: {
    type: string;
    interval: number;
    daysOfWeek?: string[];
    dayOfMonth?: number;
    month?: number;
    index?: string;
  };
  range: {
    type: 'endDate' | 'noEnd' | 'numbered';
    startDate: string;
    endDate?: string;
    numberOfOccurrences?: number;
    recurrenceTimeZone?: string;
  };
}

const DAY_TO_GRAPH: Record<string, string> = {
  MO: 'monday',
  TU: 'tuesday',
  WE: 'wednesday',
  TH: 'thursday',
  FR: 'friday',
  SA: 'saturday',
  SU: 'sunday',
};

const GRAPH_TO_DAY: Record<string, string> = Object.fromEntries(
  Object.entries(DAY_TO_GRAPH).map(([k, v]) => [v, k]),
);

const INDEX_TO_GRAPH: Record<string, string> = {
  '1': 'first',
  '2': 'second',
  '3': 'third',
  '4': 'fourth',
  '-1': 'last',
};

const GRAPH_TO_INDEX: Record<string, string> = Object.fromEntries(
  Object.entries(INDEX_TO_GRAPH).map(([k, v]) => [v, k]),
);

function parseRuleParts(rrule: string): Record<string, string> {
  const body = rrule.replace(/^RRULE:/i, '');
  const parts: Record<string, string> = {};
  for (const chunk of body.split(';')) {
    const [key, value] = chunk.split('=');
    if (key && value) parts[key.trim().toUpperCase()] = value.trim();
  }
  return parts;
}

/** `20260901T000000Z` or `20260901` as they appear in an UNTIL. */
function untilToDate(value: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(value);
  if (!m) throw new ServiceError(`Could not read the UNTIL value "${value}" in the recurrence rule.`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * @param startDate YYYY-MM-DD of the first occurrence; Graph requires it and
 *   RRULE does not carry it.
 */
export function rruleToGraph(
  rules: string[],
  startDate: string,
  timeZone?: string,
): GraphRecurrence {
  if (rules.length > 1) {
    throw new ServiceError(
      'Outlook supports a single recurrence rule per event, but several were given.',
    );
  }

  const rule = rules[0];
  if (!rule) throw new ServiceError('The recurrence list was empty.');
  if (/^(EXDATE|RDATE)/i.test(rule)) {
    throw new ServiceError(
      `Outlook cannot express "${rule}". Only RRULE lines are supported for Microsoft accounts.`,
    );
  }

  const parts = parseRuleParts(rule);
  const freq = (parts.FREQ ?? '').toUpperCase();
  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1;
  const byDay = parts.BYDAY?.split(',').map((d) => d.trim().toUpperCase()) ?? [];

  const pattern: GraphRecurrence['pattern'] = { type: '', interval };

  if (freq === 'DAILY') {
    pattern.type = 'daily';
  } else if (freq === 'WEEKLY') {
    pattern.type = 'weekly';
    pattern.daysOfWeek = byDay.length
      ? byDay.map((d) => {
          const day = DAY_TO_GRAPH[d.replace(/^[+-]?\d+/, '')];
          if (!day) throw new ServiceError(`Unrecognised weekday "${d}" in the recurrence rule.`);
          return day;
        })
      : [weekdayOf(startDate)];
  } else if (freq === 'MONTHLY') {
    if (byDay.length) {
      const m = /^([+-]?\d+)([A-Z]{2})$/.exec(byDay[0]!);
      if (!m) {
        throw new ServiceError(
          `Outlook needs an ordinal weekday such as BYDAY=2TU for a monthly rule, got "${byDay[0]}".`,
        );
      }
      pattern.type = 'relativeMonthly';
      pattern.index = INDEX_TO_GRAPH[String(Number(m[1]))] ?? 'first';
      pattern.daysOfWeek = [DAY_TO_GRAPH[m[2]!]!];
    } else {
      pattern.type = 'absoluteMonthly';
      pattern.dayOfMonth = parts.BYMONTHDAY ? Number(parts.BYMONTHDAY) : Number(startDate.slice(8, 10));
    }
  } else if (freq === 'YEARLY') {
    pattern.type = 'absoluteYearly';
    pattern.month = parts.BYMONTH ? Number(parts.BYMONTH) : Number(startDate.slice(5, 7));
    pattern.dayOfMonth = parts.BYMONTHDAY ? Number(parts.BYMONTHDAY) : Number(startDate.slice(8, 10));
  } else {
    throw new ServiceError(
      `Outlook does not support FREQ=${freq || '(missing)'}. Use DAILY, WEEKLY, MONTHLY or YEARLY.`,
    );
  }

  const range: GraphRecurrence['range'] = parts.COUNT
    ? { type: 'numbered', startDate, numberOfOccurrences: Number(parts.COUNT) }
    : parts.UNTIL
      ? { type: 'endDate', startDate, endDate: untilToDate(parts.UNTIL) }
      : { type: 'noEnd', startDate };

  if (timeZone) range.recurrenceTimeZone = timeZone;

  return { pattern, range };
}

const WEEKDAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

function weekdayOf(date: string): string {
  return WEEKDAY_NAMES[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
}

/** Renders a Graph pattern back as an RRULE, so both providers read alike. */
export function graphToRrule(recurrence: GraphRecurrence | null | undefined): string[] | null {
  if (!recurrence?.pattern) return null;

  const { pattern, range } = recurrence;
  const parts: string[] = [];

  switch (pattern.type) {
    case 'daily':
      parts.push('FREQ=DAILY');
      break;
    case 'weekly':
      parts.push('FREQ=WEEKLY');
      break;
    case 'absoluteMonthly':
    case 'relativeMonthly':
      parts.push('FREQ=MONTHLY');
      break;
    case 'absoluteYearly':
    case 'relativeYearly':
      parts.push('FREQ=YEARLY');
      break;
    default:
      return null;
  }

  if (pattern.interval && pattern.interval !== 1) parts.push(`INTERVAL=${pattern.interval}`);

  if (pattern.type === 'relativeMonthly' || pattern.type === 'relativeYearly') {
    const index = GRAPH_TO_INDEX[pattern.index ?? 'first'] ?? '1';
    const days = (pattern.daysOfWeek ?? []).map((d) => `${index}${GRAPH_TO_DAY[d] ?? ''}`);
    if (days.length) parts.push(`BYDAY=${days.join(',')}`);
  } else if (pattern.daysOfWeek?.length) {
    parts.push(`BYDAY=${pattern.daysOfWeek.map((d) => GRAPH_TO_DAY[d] ?? '').join(',')}`);
  }

  if (pattern.type === 'absoluteYearly' && pattern.month) parts.push(`BYMONTH=${pattern.month}`);
  if (
    (pattern.type === 'absoluteMonthly' || pattern.type === 'absoluteYearly') &&
    pattern.dayOfMonth
  ) {
    parts.push(`BYMONTHDAY=${pattern.dayOfMonth}`);
  }

  if (range?.type === 'numbered' && range.numberOfOccurrences) {
    parts.push(`COUNT=${range.numberOfOccurrences}`);
  }
  if (range?.type === 'endDate' && range.endDate) {
    parts.push(`UNTIL=${range.endDate.replace(/-/g, '')}T000000Z`);
  }

  return [`RRULE:${parts.join(';')}`];
}
