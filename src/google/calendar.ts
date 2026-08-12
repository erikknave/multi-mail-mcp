import { google, type calendar_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

export function calendarFor(auth: OAuth2Client): calendar_v3.Calendar {
  return google.calendar({ version: 'v3', auth });
}

export interface CalendarSummary {
  id: string;
  summary: string;
  description: string | null;
  timeZone: string | null;
  primary: boolean;
  accessRole: string;
}

export interface AttendeeInfo {
  email: string;
  /** Human name, and for a room the booking name such as "FS-3-Reef (12)". */
  displayName: string | null;
  responseStatus: string;
  optional: boolean;
  /**
   * True for a meeting room or other bookable resource. Without this an agent
   * cannot tell a room's opaque resource address from a person's, and will
   * happily drop the room when rewriting the attendee list.
   */
  isResource: boolean;
  isOrganizer: boolean;
  isSelf: boolean;
}

export interface EventSummary {
  id: string;
  status: string;
  summary: string;
  description: string | null;
  location: string | null;
  /** ISO 8601 with offset for timed events, or YYYY-MM-DD for all-day events. */
  start: string | null;
  end: string | null;
  allDay: boolean;
  organizer: string | null;
  attendees: AttendeeInfo[];
  /** The resource attendees, split out because "which room is booked" is a question worth answering directly. */
  rooms: AttendeeInfo[];
  hangoutLink: string | null;
  htmlLink: string | null;
  recurrence: string[] | null;
  /** Your own response on this event, when you are an attendee. */
  selfResponseStatus: string | null;
  /** Whether you organise this event. Non-organisers can often still edit — see canEdit. */
  isOrganizer: boolean;
  guestsCanModify: boolean;
  /** Set when this is one occurrence of a repeating event; the id of the series. */
  recurringEventId: string | null;
  isRecurringInstance: boolean;
}

function whenOf(d: calendar_v3.Schema$EventDateTime | undefined): {
  value: string | null;
  allDay: boolean;
} {
  if (!d) return { value: null, allDay: false };
  if (d.dateTime) return { value: d.dateTime, allDay: false };
  if (d.date) return { value: d.date, allDay: true };
  return { value: null, allDay: false };
}

export function toEventSummary(e: calendar_v3.Schema$Event): EventSummary {
  const start = whenOf(e.start);
  const end = whenOf(e.end);
  const attendees: AttendeeInfo[] = (e.attendees ?? []).map((a) => ({
    email: a.email ?? '',
    displayName: a.displayName ?? null,
    responseStatus: a.responseStatus ?? 'needsAction',
    optional: a.optional ?? false,
    isResource: a.resource ?? false,
    isOrganizer: a.organizer ?? false,
    isSelf: a.self ?? false,
  }));
  const self = (e.attendees ?? []).find((a) => a.self);

  return {
    id: e.id ?? '',
    status: e.status ?? 'confirmed',
    summary: e.summary ?? '(no title)',
    description: e.description ?? null,
    location: e.location ?? null,
    start: start.value,
    end: end.value,
    allDay: start.allDay,
    organizer: e.organizer?.email ?? null,
    attendees,
    rooms: attendees.filter((a) => a.isResource),
    hangoutLink: e.hangoutLink ?? null,
    htmlLink: e.htmlLink ?? null,
    recurrence: e.recurrence ?? null,
    selfResponseStatus: self?.responseStatus ?? null,
    isOrganizer: e.organizer?.self ?? false,
    guestsCanModify: e.guestsCanModify ?? false,
    recurringEventId: e.recurringEventId ?? null,
    isRecurringInstance: !!e.recurringEventId,
  };
}

export async function listCalendars(cal: calendar_v3.Calendar): Promise<CalendarSummary[]> {
  const res = await cal.calendarList.list({ maxResults: 250 });
  return (res.data.items ?? []).map((c) => ({
    id: c.id ?? '',
    summary: c.summary ?? '',
    description: c.description ?? null,
    timeZone: c.timeZone ?? null,
    primary: c.primary ?? false,
    accessRole: c.accessRole ?? 'reader',
  }));
}

export async function listEvents(
  cal: calendar_v3.Calendar,
  params: {
    calendarId: string;
    timeMin?: string;
    timeMax?: string;
    query?: string;
    maxResults: number;
  },
): Promise<EventSummary[]> {
  const res = await cal.events.list({
    calendarId: params.calendarId,
    timeMin: params.timeMin,
    timeMax: params.timeMax,
    q: params.query,
    maxResults: params.maxResults,
    // Expands recurring events into individual occurrences, which is almost
    // always what a caller asking "what's on Tuesday" actually wants.
    singleEvents: true,
    orderBy: 'startTime',
  });
  return (res.data.items ?? []).map(toEventSummary);
}

export async function getEvent(
  cal: calendar_v3.Calendar,
  calendarId: string,
  eventId: string,
): Promise<EventSummary> {
  const res = await cal.events.get({ calendarId, eventId });
  return toEventSummary(res.data);
}

export interface EventInput {
  summary: string;
  description?: string;
  location?: string;
  /** ISO 8601 datetime, or YYYY-MM-DD for an all-day event. */
  start: string;
  end: string;
  timeZone?: string;
  attendees?: string[];
  addConference?: boolean;
  recurrence?: string[];
}

function toEventDateTime(
  value: string,
  timeZone: string | undefined,
): calendar_v3.Schema$EventDateTime {
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (isDateOnly) return { date: value };
  return { dateTime: value, ...(timeZone ? { timeZone } : {}) };
}

function toRequestBody(input: EventInput): calendar_v3.Schema$Event {
  return {
    summary: input.summary,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.location !== undefined ? { location: input.location } : {}),
    start: toEventDateTime(input.start, input.timeZone),
    end: toEventDateTime(input.end, input.timeZone),
    ...(input.attendees?.length ? { attendees: input.attendees.map((email) => ({ email })) } : {}),
    ...(input.recurrence?.length ? { recurrence: input.recurrence } : {}),
    ...(input.addConference
      ? {
          conferenceData: {
            createRequest: {
              requestId: `mmcp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
              conferenceSolutionKey: { type: 'hangoutsMeet' },
            },
          },
        }
      : {}),
  };
}

export async function createEvent(
  cal: calendar_v3.Calendar,
  calendarId: string,
  input: EventInput,
  sendUpdates: 'all' | 'externalOnly' | 'none',
): Promise<EventSummary> {
  const res = await cal.events.insert({
    calendarId,
    sendUpdates,
    conferenceDataVersion: input.addConference ? 1 : 0,
    requestBody: toRequestBody(input),
  });
  return toEventSummary(res.data);
}

export interface AttendeeChange {
  /** Addresses to add. A room is added by its resource address, like anyone else. */
  add?: string[];
  /** Addresses to remove. */
  remove?: string[];
  /** Replace the entire list. Mutually exclusive with add/remove. */
  replace?: string[];
}

/**
 * Applies attendee changes by merging against the event's current list.
 *
 * The Calendar API only accepts a whole attendee array, so a naive "change the
 * attendees" rewrites everyone as `{email}` — which silently drops the booked
 * room, discards every RSVP, and re-invites people who had already accepted.
 * Merging keeps each existing attendee object untouched, so only the people you
 * named actually change.
 */
export async function changeAttendees(
  cal: calendar_v3.Calendar,
  calendarId: string,
  eventId: string,
  change: AttendeeChange,
  sendUpdates: 'all' | 'externalOnly' | 'none',
): Promise<{ event: EventSummary; added: string[]; removed: string[]; unchanged: number }> {
  const current = await cal.events.get({ calendarId, eventId });
  const existing = current.data.attendees ?? [];

  const norm = (e: string) => e.trim().toLowerCase();
  let next: calendar_v3.Schema$EventAttendee[];
  const added: string[] = [];
  const removed: string[] = [];

  if (change.replace) {
    const wanted = change.replace.map(norm);
    // Carry over the full object for anyone who survives the replacement, so
    // their response status and resource flag are preserved.
    next = wanted.map((email) => {
      const kept = existing.find((a) => norm(a.email ?? '') === email);
      if (kept) return kept;
      added.push(email);
      return { email };
    });
    for (const a of existing) {
      if (!wanted.includes(norm(a.email ?? ''))) removed.push(a.email ?? '');
    }
  } else {
    const toRemove = new Set((change.remove ?? []).map(norm));
    next = existing.filter((a) => {
      const drop = toRemove.has(norm(a.email ?? ''));
      if (drop) removed.push(a.email ?? '');
      return !drop;
    });
    for (const email of change.add ?? []) {
      const normalized = norm(email);
      if (next.some((a) => norm(a.email ?? '') === normalized)) continue;
      next.push({ email: normalized });
      added.push(normalized);
    }
  }

  const res = await cal.events.patch({
    calendarId,
    eventId,
    sendUpdates,
    requestBody: { attendees: next },
  });

  return {
    event: toEventSummary(res.data),
    added,
    removed,
    unchanged: next.length - added.length,
  };
}

/**
 * Meeting rooms seen in the user's own calendar history.
 *
 * Listing an organisation's rooms properly needs the Admin SDK and admin
 * rights, which an ordinary user does not have. Rooms the person has actually
 * booked before are both obtainable without any extra permission and, in
 * practice, the ones they want again.
 */
export async function findRoomsInHistory(
  cal: calendar_v3.Calendar,
  daysBack: number,
  daysForward: number,
): Promise<Array<{ email: string; name: string; timesSeen: number; lastSeen: string | null }>> {
  const res = await cal.events.list({
    calendarId: 'primary',
    timeMin: new Date(Date.now() - daysBack * 86400000).toISOString(),
    timeMax: new Date(Date.now() + daysForward * 86400000).toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 2500,
  });

  const rooms = new Map<string, { email: string; name: string; timesSeen: number; lastSeen: string | null }>();

  for (const event of res.data.items ?? []) {
    const when = event.start?.dateTime ?? event.start?.date ?? null;
    for (const a of event.attendees ?? []) {
      if (!a.resource || !a.email) continue;
      const found = rooms.get(a.email);
      if (found) {
        found.timesSeen++;
        if (when && (!found.lastSeen || when > found.lastSeen)) found.lastSeen = when;
        if (a.displayName && found.name === a.email) found.name = a.displayName;
      } else {
        rooms.set(a.email, {
          email: a.email,
          name: a.displayName ?? a.email,
          timesSeen: 1,
          lastSeen: when,
        });
      }
    }
  }

  return [...rooms.values()].sort((a, b) => b.timesSeen - a.timesSeen);
}

export async function updateEvent(
  cal: calendar_v3.Calendar,
  calendarId: string,
  eventId: string,
  input: Partial<EventInput>,
  sendUpdates: 'all' | 'externalOnly' | 'none',
): Promise<EventSummary> {
  // patch, not update: callers should be able to change only the fields they name.
  const body: calendar_v3.Schema$Event = {};
  if (input.summary !== undefined) body.summary = input.summary;
  if (input.description !== undefined) body.description = input.description;
  if (input.location !== undefined) body.location = input.location;
  if (input.start !== undefined) body.start = toEventDateTime(input.start, input.timeZone);
  if (input.end !== undefined) body.end = toEventDateTime(input.end, input.timeZone);
  if (input.attendees !== undefined) body.attendees = input.attendees.map((email) => ({ email }));
  if (input.recurrence !== undefined) body.recurrence = input.recurrence;

  const res = await cal.events.patch({ calendarId, eventId, sendUpdates, requestBody: body });
  return toEventSummary(res.data);
}

export async function deleteEvent(
  cal: calendar_v3.Calendar,
  calendarId: string,
  eventId: string,
  sendUpdates: 'all' | 'externalOnly' | 'none',
): Promise<void> {
  await cal.events.delete({ calendarId, eventId, sendUpdates });
}

export async function respondToEvent(
  cal: calendar_v3.Calendar,
  calendarId: string,
  eventId: string,
  response: 'accepted' | 'declined' | 'tentative',
  comment?: string,
): Promise<EventSummary> {
  const current = await cal.events.get({ calendarId, eventId });
  const attendees = current.data.attendees ?? [];
  const selfIndex = attendees.findIndex((a) => a.self);
  if (selfIndex === -1) {
    throw new Error(
      'You are not listed as an attendee on this event, so there is no invitation to respond to.',
    );
  }
  attendees[selfIndex] = {
    ...attendees[selfIndex],
    responseStatus: response,
    ...(comment ? { comment } : {}),
  };

  const res = await cal.events.patch({
    calendarId,
    eventId,
    sendUpdates: 'all',
    requestBody: { attendees },
  });
  return toEventSummary(res.data);
}

export interface FreeBusySlot {
  start: string;
  end: string;
}

export async function freeBusy(
  cal: calendar_v3.Calendar,
  calendarIds: string[],
  timeMin: string,
  timeMax: string,
): Promise<Record<string, FreeBusySlot[]>> {
  const res = await cal.freebusy.query({
    requestBody: {
      timeMin,
      timeMax,
      items: calendarIds.map((id) => ({ id })),
    },
  });
  const out: Record<string, FreeBusySlot[]> = {};
  for (const [id, value] of Object.entries(res.data.calendars ?? {})) {
    out[id] = (value.busy ?? []).map((b) => ({ start: b.start ?? '', end: b.end ?? '' }));
  }
  return out;
}
