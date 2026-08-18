import type {
  AttendeeChange,
  AttendeeInfo,
  CalendarApi,
  CalendarSummary,
  EventInput,
  EventSummary,
  FreeBusySlot,
  ListEventsParams,
  RoomUsage,
} from '../calendar/types.js';
import { ServiceError } from '../serviceError.js';
import type { Graph } from './graph.js';
import { graphToRrule, rruleToGraph, type GraphRecurrence } from './recurrence.js';

interface GraphDateTime {
  dateTime?: string | null;
  timeZone?: string | null;
}

interface GraphAttendee {
  type?: string | null;
  status?: { response?: string | null; time?: string | null } | null;
  emailAddress?: { name?: string | null; address?: string | null } | null;
}

interface GraphEvent {
  id: string;
  subject?: string | null;
  bodyPreview?: string | null;
  body?: { contentType?: string | null; content?: string | null } | null;
  start?: GraphDateTime | null;
  end?: GraphDateTime | null;
  isAllDay?: boolean | null;
  isCancelled?: boolean | null;
  isOrganizer?: boolean | null;
  location?: { displayName?: string | null } | null;
  organizer?: { emailAddress?: { name?: string | null; address?: string | null } | null } | null;
  attendees?: GraphAttendee[] | null;
  onlineMeeting?: { joinUrl?: string | null } | null;
  webLink?: string | null;
  recurrence?: GraphRecurrence | null;
  seriesMasterId?: string | null;
  type?: string | null;
  responseStatus?: { response?: string | null } | null;
  allowNewTimeProposals?: boolean | null;
}

interface GraphCalendar {
  id: string;
  name?: string | null;
  isDefaultCalendar?: boolean | null;
  canEdit?: boolean | null;
  owner?: { address?: string | null } | null;
}

/** Outlook's response words in Google's vocabulary, so agents see one set. */
const RESPONSE_TO_GOOGLE: Record<string, string> = {
  none: 'needsAction',
  notresponded: 'needsAction',
  organizer: 'accepted',
  tentativelyaccepted: 'tentative',
  accepted: 'accepted',
  declined: 'declined',
};

const RESPONSE_TO_GRAPH: Record<string, string> = {
  accepted: 'accept',
  declined: 'decline',
  tentative: 'tentativelyAccept',
};

function toGoogleResponse(value: string | null | undefined): string {
  return RESPONSE_TO_GOOGLE[(value ?? '').toLowerCase()] ?? 'needsAction';
}

/**
 * The Windows time zone names Exchange still uses in some tenants, mapped to
 * what Intl understands. Only the ones a European deployment actually meets;
 * anything else falls back below rather than pretending to know.
 */
const WINDOWS_TIME_ZONES: Record<string, string> = {
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'Romance Standard Time': 'Europe/Paris',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'FLE Standard Time': 'Europe/Helsinki',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  UTC: 'UTC',
};

/** How far `zone` is ahead of UTC at a given instant, in milliseconds. */
function zoneOffsetAt(instant: number, zone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(instant));

    const at = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
    const local = Date.UTC(
      at('year'),
      at('month') - 1,
      at('day'),
      at('hour') % 24,
      at('minute'),
      at('second'),
    );
    return local - instant;
  } catch {
    // An unrecognised zone name; the caller decides what to do about it.
    return null;
  }
}

/**
 * Turns Graph's wall clock plus zone name into a real UTC instant.
 *
 * Reads ask for UTC and get it, so those need nothing. Write responses are the
 * catch: Graph echoes a created or patched event back in the zone it was
 * submitted in, ignoring the Prefer header, so stamping the wall clock with Z
 * reported a 09:00 Stockholm meeting as 09:00Z — two hours out, in a value the
 * caller would repeat back to a human as fact.
 */
function toIsoUtc(value: GraphDateTime | null | undefined): string | null {
  const raw = value?.dateTime;
  if (!raw) return null;

  // Graph pads to seven fractional digits, which Date.parse dislikes in places.
  const trimmed = raw.replace(/(\.\d{3})\d+(Z?)$/, '$1$2');
  if (trimmed.endsWith('Z')) return trimmed;

  const zone = value?.timeZone ?? 'UTC';
  if (zone === 'UTC') return `${trimmed}Z`;

  const iana = WINDOWS_TIME_ZONES[zone] ?? zone;
  const asIfUtc = Date.parse(`${trimmed}Z`);
  if (!Number.isFinite(asIfUtc)) return `${trimmed}Z`;

  // Two passes: the first offset is read at the wrong instant when the wall
  // clock sits near a DST change, and re-reading it at the corrected instant
  // settles it.
  let offset = zoneOffsetAt(asIfUtc, iana);
  if (offset === null) return `${trimmed}Z`;
  offset = zoneOffsetAt(asIfUtc - offset, iana) ?? offset;

  return new Date(asIfUtc - offset).toISOString().replace(/\.\d+Z$/, '.000Z');
}

/**
 * The calendar date an all-day event falls on.
 *
 * All-day events are stored as local midnight-to-midnight, so reading them in
 * UTC can land the instant on the day before or after. Shifting by twelve hours
 * before taking the date puts any offset within ±12h back on the intended day,
 * which is every real time zone.
 */
function allDayDate(value: GraphDateTime | null | undefined): string | null {
  const iso = toIsoUtc(value);
  if (!iso) return null;
  const shifted = new Date(Date.parse(iso) + 12 * 3600 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function toAttendeeInfo(a: GraphAttendee, selfEmail: string, organizer: string | null): AttendeeInfo {
  const email = (a.emailAddress?.address ?? '').toLowerCase();
  return {
    email,
    displayName: a.emailAddress?.name ?? null,
    responseStatus: toGoogleResponse(a.status?.response),
    optional: (a.type ?? '').toLowerCase() === 'optional',
    isResource: (a.type ?? '').toLowerCase() === 'resource',
    isOrganizer: !!organizer && email === organizer.toLowerCase(),
    isSelf: email === selfEmail.toLowerCase(),
  };
}

export function toEventSummary(e: GraphEvent, selfEmail: string): EventSummary {
  const organizer = e.organizer?.emailAddress?.address ?? null;
  const attendees = (e.attendees ?? []).map((a) => toAttendeeInfo(a, selfEmail, organizer));
  const allDay = e.isAllDay === true;

  return {
    id: e.id,
    status: e.isCancelled ? 'cancelled' : 'confirmed',
    summary: e.subject || '(no title)',
    description: e.body?.content ?? e.bodyPreview ?? null,
    location: e.location?.displayName ?? null,
    start: allDay ? allDayDate(e.start) : toIsoUtc(e.start),
    end: allDay ? allDayDate(e.end) : toIsoUtc(e.end),
    allDay,
    organizer,
    attendees,
    rooms: attendees.filter((a) => a.isResource),
    hangoutLink: e.onlineMeeting?.joinUrl ?? null,
    htmlLink: e.webLink ?? null,
    recurrence: graphToRrule(e.recurrence),
    selfResponseStatus: e.responseStatus?.response
      ? toGoogleResponse(e.responseStatus.response)
      : (attendees.find((a) => a.isSelf)?.responseStatus ?? null),
    isOrganizer: e.isOrganizer ?? false,
    // Outlook has no per-event "guests may edit" switch; only the organiser can.
    guestsCanModify: false,
    recurringEventId: e.seriesMasterId ?? null,
    isRecurringInstance: e.type === 'occurrence' || e.type === 'exception',
  };
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

/** Splits an ISO datetime into what Graph wants: wall clock plus a zone name. */
function toGraphDateTime(value: string, timeZone: string | undefined): GraphDateTime {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { dateTime: `${value}T00:00:00`, timeZone: timeZone ?? 'UTC' };
  }

  // An explicit offset or Z already pins the instant, so normalising to UTC
  // keeps the meaning exactly and avoids trusting a zone name we were not given.
  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(value)) {
    const iso = new Date(value).toISOString();
    return { dateTime: iso.replace(/\.\d+Z$/, ''), timeZone: 'UTC' };
  }

  return { dateTime: value, timeZone: timeZone ?? 'UTC' };
}

/** An ISO instant as the offset-free wall clock Graph pairs with a zone name. */
function toGraphUtcWallClock(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ServiceError(`"${value}" is not a valid ISO 8601 date-time.`);
  }
  return parsed.toISOString().replace(/\.\d+Z$/, '');
}

/** Graph refuses a calendarView wider than this, in days. */
const MAX_CALENDAR_VIEW_DAYS = 1825;

function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function eventBody(input: Partial<EventInput>): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (input.summary !== undefined) body.subject = input.summary;
  if (input.description !== undefined) {
    body.body = { contentType: 'text', content: input.description };
  }
  if (input.location !== undefined) body.location = { displayName: input.location };

  if (input.start !== undefined) {
    body.start = toGraphDateTime(input.start, input.timeZone);
    if (isDateOnly(input.start)) body.isAllDay = true;
  }
  if (input.end !== undefined) body.end = toGraphDateTime(input.end, input.timeZone);

  if (input.attendees !== undefined) {
    body.attendees = input.attendees.map((email) => ({
      emailAddress: { address: email },
      type: 'required',
    }));
  }

  if (input.recurrence !== undefined) {
    if (input.recurrence === null || input.recurrence.length === 0) {
      body.recurrence = null;
    } else {
      const startDate = input.start ? input.start.slice(0, 10) : new Date().toISOString().slice(0, 10);
      body.recurrence = rruleToGraph(input.recurrence, startDate, input.timeZone);
    }
  }

  if (input.addConference) {
    body.isOnlineMeeting = true;
    body.onlineMeetingProvider = 'teamsForBusiness';
  }

  return body;
}

/* ------------------------------------------------------------------ *
 * Implementation
 * ------------------------------------------------------------------ */

export function microsoftCalendarApi(graph: Graph, accountEmail: string): CalendarApi {
  /** Every read asks for UTC so the returned wall clock needs no interpretation. */
  const utc = { headers: { prefer: 'outlook.timezone="UTC"' } };

  function calendarPath(calendarId: string): string {
    return calendarId === 'primary' || !calendarId
      ? '/me/calendar'
      : `/me/calendars/${encodeURIComponent(calendarId)}`;
  }

  async function fetchEvent(eventId: string): Promise<GraphEvent> {
    return graph.get<GraphEvent>(`/me/events/${encodeURIComponent(eventId)}`, utc);
  }

  async function eventsInWindow(
    calendarId: string,
    timeMin: string,
    timeMax: string,
    limit: number,
  ): Promise<GraphEvent[]> {
    const params = new URLSearchParams({
      startDateTime: timeMin,
      endDateTime: timeMax,
      $top: String(Math.min(limit, 100)),
      $orderby: 'start/dateTime',
    });
    // calendarView, not /events: it expands a recurring series into the
    // individual occurrences, which is what "what is on Tuesday" means.
    return graph.getAll<GraphEvent>(
      `${calendarPath(calendarId)}/calendarView?${params.toString().replace(/\+/g, '%20')}`,
      limit,
      utc,
    );
  }

  return {
    provider: 'microsoft',
    accountEmail,

    async listCalendars(): Promise<CalendarSummary[]> {
      const calendars = await graph.getAll<GraphCalendar>(
        '/me/calendars?$top=100&$select=id,name,isDefaultCalendar,canEdit,owner',
        250,
      );
      return calendars.map((c) => ({
        id: c.id,
        summary: c.name ?? '',
        description: null,
        // Graph exposes no per-calendar time zone; events carry their own.
        timeZone: null,
        primary: c.isDefaultCalendar ?? false,
        accessRole: c.isDefaultCalendar ? 'owner' : c.canEdit ? 'writer' : 'reader',
      }));
    },

    async listEvents(params: ListEventsParams): Promise<EventSummary[]> {
      // Graph's calendarView demands both ends of the window, unlike Google's
      // open-ended list, so an omitted bound becomes a year either side.
      const year = 365 * 24 * 3600 * 1000;
      const timeMin = params.timeMin ?? new Date(Date.now() - year).toISOString();
      const timeMax = params.timeMax ?? new Date(Date.now() + year).toISOString();

      // Outlook caps an expanded view at five years and refuses anything wider
      // with a message about "the allowed range", which reads like a quota
      // problem. Google has no such limit, so a query that works against one
      // mailbox can fail against another purely on its date range — worth
      // saying plainly, with the fix.
      const spanDays = (Date.parse(timeMax) - Date.parse(timeMin)) / 86_400_000;
      if (spanDays > MAX_CALENDAR_VIEW_DAYS) {
        throw new ServiceError(
          `Outlook cannot expand more than ${MAX_CALENDAR_VIEW_DAYS} days of calendar at once ` +
            `(about five years), and ${Math.round(spanDays)} days were requested. Narrow the ` +
            `range, or ask for several windows in turn.`,
        );
      }

      const events = await eventsInWindow(params.calendarId, timeMin, timeMax, params.maxResults);

      const needle = params.query?.toLowerCase();
      const filtered = needle
        ? events.filter((e) =>
            `${e.subject ?? ''} ${e.bodyPreview ?? ''} ${e.location?.displayName ?? ''}`
              .toLowerCase()
              .includes(needle),
          )
        : events;

      return filtered.map((e) => toEventSummary(e, accountEmail));
    },

    async getEvent(_calendarId, eventId) {
      return toEventSummary(await fetchEvent(eventId), accountEmail);
    },

    async createEvent(calendarId, input, _sendUpdates) {
      const created = await graph.post<GraphEvent>(
        `${calendarPath(calendarId)}/events`,
        eventBody(input),
        utc,
      );
      return toEventSummary(created, accountEmail);
    },

    async updateEvent(_calendarId, eventId, input, _sendUpdates) {
      const body = eventBody(input);
      if (Object.keys(body).length === 0) {
        return toEventSummary(await fetchEvent(eventId), accountEmail);
      }
      const updated = await graph.patch<GraphEvent>(
        `/me/events/${encodeURIComponent(eventId)}`,
        body,
        utc,
      );
      return toEventSummary(updated, accountEmail);
    },

    async deleteEvent(_calendarId, eventId, _sendUpdates) {
      await graph.del(`/me/events/${encodeURIComponent(eventId)}`);
    },

    async respondToEvent(_calendarId, eventId, response, comment) {
      const action = RESPONSE_TO_GRAPH[response];
      if (!action) throw new ServiceError(`Unsupported response "${response}".`);

      await graph.postNoContent(`/me/events/${encodeURIComponent(eventId)}/${action}`, {
        sendResponse: true,
        ...(comment ? { comment } : {}),
      });

      return toEventSummary(await fetchEvent(eventId), accountEmail);
    },

    /**
     * Merges against the current guest list rather than rewriting it.
     *
     * Graph, like Google, only accepts a whole attendee array. Rebuilding it
     * from addresses alone would drop every RSVP and turn a booked room into an
     * ordinary invitee, releasing the booking.
     */
    async changeAttendees(_calendarId, eventId, change: AttendeeChange, _sendUpdates) {
      const before = await fetchEvent(eventId);
      const existing = before.attendees ?? [];

      const norm = (e: string) => e.trim().toLowerCase();
      const added: string[] = [];
      const removed: string[] = [];
      let next: GraphAttendee[];

      if (change.replace) {
        const wanted = change.replace.map(norm);
        next = wanted.map((email) => {
          const kept = existing.find((a) => norm(a.emailAddress?.address ?? '') === email);
          if (kept) return kept;
          added.push(email);
          return { emailAddress: { address: email }, type: 'required' };
        });
        for (const a of existing) {
          const email = norm(a.emailAddress?.address ?? '');
          if (!wanted.includes(email)) removed.push(email);
        }
      } else {
        const toRemove = new Set((change.remove ?? []).map(norm));
        next = existing.filter((a) => {
          const drop = toRemove.has(norm(a.emailAddress?.address ?? ''));
          if (drop) removed.push(norm(a.emailAddress?.address ?? ''));
          return !drop;
        });
        for (const email of change.add ?? []) {
          const normalized = norm(email);
          if (next.some((a) => norm(a.emailAddress?.address ?? '') === normalized)) continue;
          next.push({ emailAddress: { address: normalized }, type: 'required' });
          added.push(normalized);
        }
      }

      const updated = await graph.patch<GraphEvent>(
        `/me/events/${encodeURIComponent(eventId)}`,
        { attendees: next },
        utc,
      );

      return {
        event: toEventSummary(updated, accountEmail),
        added,
        removed,
        unchanged: next.length - added.length,
      };
    },

    /**
     * getSchedule takes mailbox addresses, not calendar ids, so "primary" means
     * this account's own address. A calendar id from list_calendars has no
     * free/busy equivalent and is reported rather than silently returning empty.
     */
    async freeBusy(calendarIds, timeMin, timeMax): Promise<Record<string, FreeBusySlot[]>> {
      const addresses = calendarIds.map((id) => (id === 'primary' ? accountEmail : id));

      const res = await graph.post<{
        value?: Array<{
          scheduleId?: string | null;
          scheduleItems?: Array<{ start?: GraphDateTime; end?: GraphDateTime; status?: string }>;
          error?: { message?: string } | null;
        }>;
      }>(
        '/me/calendar/getSchedule',
        {
          schedules: addresses,
          // Normalised through Date so an offset like +02:00 is converted
          // rather than relabelled as UTC, which would shift the whole window.
          startTime: { dateTime: toGraphUtcWallClock(timeMin), timeZone: 'UTC' },
          endTime: { dateTime: toGraphUtcWallClock(timeMax), timeZone: 'UTC' },
          availabilityViewInterval: 30,
        },
        utc,
      );

      const out: Record<string, FreeBusySlot[]> = {};
      for (const [index, schedule] of (res.value ?? []).entries()) {
        const key = calendarIds[index] ?? schedule.scheduleId ?? addresses[index] ?? 'unknown';
        out[key] = (schedule.scheduleItems ?? [])
          .filter((item) => (item.status ?? 'busy').toLowerCase() !== 'free')
          .map((item) => ({
            start: toIsoUtc(item.start) ?? '',
            end: toIsoUtc(item.end) ?? '',
          }));
      }
      return out;
    },

    async findRoomsInHistory(daysBack, daysForward): Promise<RoomUsage[]> {
      const events = await eventsInWindow(
        'primary',
        new Date(Date.now() - daysBack * 86400000).toISOString(),
        new Date(Date.now() + daysForward * 86400000).toISOString(),
        1000,
      );

      const rooms = new Map<string, RoomUsage>();
      for (const event of events) {
        const when = toIsoUtc(event.start);
        for (const attendee of event.attendees ?? []) {
          if ((attendee.type ?? '').toLowerCase() !== 'resource') continue;
          const email = attendee.emailAddress?.address;
          if (!email) continue;

          const found = rooms.get(email);
          if (found) {
            found.timesSeen++;
            if (when && (!found.lastSeen || when > found.lastSeen)) found.lastSeen = when;
            if (attendee.emailAddress?.name && found.name === email) {
              found.name = attendee.emailAddress.name;
            }
          } else {
            rooms.set(email, {
              email,
              name: attendee.emailAddress?.name ?? email,
              timesSeen: 1,
              lastSeen: when,
            });
          }
        }
      }

      return [...rooms.values()].sort((a, b) => b.timesSeen - a.timesSeen);
    },
  };
}
