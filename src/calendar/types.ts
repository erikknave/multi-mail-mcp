import type { Provider } from '../providers.js';

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
  /**
   * One vocabulary for both providers: needsAction | accepted | declined |
   * tentative. Outlook's own words (none, tentativelyAccepted, …) are mapped
   * onto these so an agent never has to know which mailbox it is looking at.
   */
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
  /** Google Meet or Teams join link, whichever the account's provider makes. */
  hangoutLink: string | null;
  htmlLink: string | null;
  /** RRULE strings. Outlook's structured pattern is rendered as one for parity. */
  recurrence: string[] | null;
  /** Your own response on this event, when you are an attendee. */
  selfResponseStatus: string | null;
  /** Whether you organise this event. Non-organisers can often still edit. */
  isOrganizer: boolean;
  guestsCanModify: boolean;
  /** Set when this is one occurrence of a repeating event; the id of the series. */
  recurringEventId: string | null;
  isRecurringInstance: boolean;
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

export interface AttendeeChange {
  /** Addresses to add. A room is added by its resource address, like anyone else. */
  add?: string[];
  /** Addresses to remove. */
  remove?: string[];
  /** Replace the entire list. Mutually exclusive with add/remove. */
  replace?: string[];
}

export interface FreeBusySlot {
  start: string;
  end: string;
}

export type SendUpdates = 'all' | 'externalOnly' | 'none';

export interface ListEventsParams {
  calendarId: string;
  timeMin?: string;
  timeMax?: string;
  query?: string;
  maxResults: number;
}

export interface RoomUsage {
  email: string;
  name: string;
  timesSeen: number;
  lastSeen: string | null;
}

/** Everything the calendar tools need, with the provider hidden behind it. */
export interface CalendarApi {
  readonly provider: Provider;
  readonly accountEmail: string;

  listCalendars(): Promise<CalendarSummary[]>;
  listEvents(params: ListEventsParams): Promise<EventSummary[]>;
  getEvent(calendarId: string, eventId: string): Promise<EventSummary>;
  createEvent(calendarId: string, input: EventInput, sendUpdates: SendUpdates): Promise<EventSummary>;
  updateEvent(
    calendarId: string,
    eventId: string,
    input: Partial<EventInput>,
    sendUpdates: SendUpdates,
  ): Promise<EventSummary>;
  deleteEvent(calendarId: string, eventId: string, sendUpdates: SendUpdates): Promise<void>;
  respondToEvent(
    calendarId: string,
    eventId: string,
    response: 'accepted' | 'declined' | 'tentative',
    comment?: string,
  ): Promise<EventSummary>;
  changeAttendees(
    calendarId: string,
    eventId: string,
    change: AttendeeChange,
    sendUpdates: SendUpdates,
  ): Promise<{ event: EventSummary; added: string[]; removed: string[]; unchanged: number }>;
  freeBusy(
    calendarIds: string[],
    timeMin: string,
    timeMax: string,
  ): Promise<Record<string, FreeBusySlot[]>>;
  findRoomsInHistory(daysBack: number, daysForward: number): Promise<RoomUsage[]>;
}
