import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { User } from '../../db/repo.js';
import {
  changeAttendees,
  createEvent,
  deleteEvent,
  findRoomsInHistory,
  freeBusy,
  getEvent,
  listCalendars,
  listEvents,
  respondToEvent,
  updateEvent,
} from '../../google/calendar.js';
import { ReauthRequiredError } from '../../google/oauth.js';
import { calendarClient, resolveAccount, resolveAccounts, ServiceError } from '../../service.js';
import { guard, ok, partial, type AccountProblem } from '../reply.js';

const accountArg = z
  .string()
  .optional()
  .describe('Mailbox address whose calendar to use. Omit when only one mailbox is connected.');

const calendarIdArg = z
  .string()
  .default('primary')
  .describe('Calendar id from list_calendars. "primary" is the account\'s own calendar.');

const sendUpdatesArg = z
  .enum(['all', 'externalOnly', 'none'])
  .default('all')
  .describe('Whether to email attendees about this change.');

export function registerCalendarTools(server: McpServer, user: User): void {
  server.registerTool(
    'list_calendars',
    {
      title: 'List calendars',
      description:
        'Lists the calendars visible from one or more accounts, with their ids and access ' +
        'roles. Needed before working with anything other than the primary calendar.',
      inputSchema: {
        accounts: z
          .array(z.string())
          .optional()
          .describe('Mailbox addresses. Omit for all connected mailboxes.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ accounts }) =>
      guard(async () => {
        const targets = resolveAccounts(user, accounts);
        const results = await Promise.all(
          targets.map(async (acc) => {
            try {
              const cal = await calendarClient(acc);
              return { account: acc.email, calendars: await listCalendars(cal) };
            } catch (err) {
              if (err instanceof ReauthRequiredError) {
                return {
                  account: acc.email,
                  error: 'needs_reauth',
                  reauthUrl: err.reauthUrl,
                  calendars: [],
                };
              }
              return { account: acc.email, error: (err as Error).message, calendars: [] };
            }
          }),
        );
        const problems: AccountProblem[] = results
          .filter((r) => 'error' in r && r.error)
          .map((r) => ({
            account: r.account,
            error: (r as { error: string }).error,
            ...('reauthUrl' in r && r.reauthUrl ? { reauthUrl: r.reauthUrl as string } : {}),
          }));

        return partial({ accounts: results }, problems, 'calendars');
      }),
  );

  server.registerTool(
    'list_events',
    {
      title: 'List calendar events',
      description:
        'Lists events in a time range, across one or more accounts. Recurring events are ' +
        'expanded into individual occurrences and results are ordered by start time. ' +
        'Times are ISO 8601; pass an explicit offset or Z to avoid timezone ambiguity.',
      inputSchema: {
        timeMin: z
          .string()
          .describe('Start of the range, ISO 8601 (e.g. 2026-08-01T00:00:00+02:00).'),
        timeMax: z.string().describe('End of the range, ISO 8601.'),
        accounts: z
          .array(z.string())
          .optional()
          .describe('Mailbox addresses. Omit for all connected mailboxes.'),
        calendarId: calendarIdArg,
        query: z.string().optional().describe('Free-text filter on event fields.'),
        limit: z.number().int().min(1).max(250).default(50).describe('Max events per calendar.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ timeMin, timeMax, accounts, calendarId, query, limit }) =>
      guard(async () => {
        const targets = resolveAccounts(user, accounts);

        const perAccount = await Promise.all(
          targets.map(async (acc) => {
            try {
              const cal = await calendarClient(acc);
              const events = await listEvents(cal, {
                calendarId,
                timeMin,
                timeMax,
                query,
                maxResults: limit,
              });
              return { account: acc.email, ok: true as const, events };
            } catch (err) {
              if (err instanceof ReauthRequiredError) {
                return {
                  account: acc.email,
                  ok: false as const,
                  error: 'needs_reauth',
                  reauthUrl: err.reauthUrl,
                  events: [],
                };
              }
              return {
                account: acc.email,
                ok: false as const,
                error: (err as Error).message,
                events: [],
              };
            }
          }),
        );

        const merged = perAccount
          .flatMap((r) => r.events.map((e) => ({ account: r.account, calendarId, ...e })))
          .sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));

        const problems: AccountProblem[] = perAccount
          .filter((r) => !r.ok)
          .map((f) => ({
            account: f.account,
            error: f.error ?? 'unknown error',
            ...('reauthUrl' in f && f.reauthUrl ? { reauthUrl: f.reauthUrl } : {}),
          }));

        return partial(
          {
            timeMin,
            timeMax,
            calendarsRead: targets.length - problems.length,
            calendarsRequested: targets.length,
            eventCount: merged.length,
            events: merged,
          },
          problems,
          'events',
        );
      }),
  );

  server.registerTool(
    'get_event',
    {
      title: 'Read one calendar event',
      description: 'Fetches a single event with its full details, attendees and response statuses.',
      inputSchema: {
        eventId: z.string().describe('Event id, from list_events.'),
        calendarId: calendarIdArg,
        account: accountArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ eventId, calendarId, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const cal = await calendarClient(acc);
        return ok({ account: acc.email, calendarId, event: await getEvent(cal, calendarId, eventId) });
      }),
  );

  server.registerTool(
    'create_event',
    {
      title: 'Create a calendar event',
      description:
        'Creates an event. Use ISO 8601 datetimes for timed events, or YYYY-MM-DD for all-day ' +
        'events. Adding attendees emails them an invitation unless sendUpdates is "none".',
      inputSchema: {
        summary: z.string().describe('Event title.'),
        start: z.string().describe('Start: ISO 8601 datetime, or YYYY-MM-DD for all-day.'),
        end: z
          .string()
          .describe('End: ISO 8601 datetime, or YYYY-MM-DD (exclusive) for all-day.'),
        description: z.string().optional().describe('Event body text.'),
        location: z.string().optional().describe('Location.'),
        timeZone: z
          .string()
          .optional()
          .describe('IANA timezone, e.g. Europe/Stockholm. Recommended for timed events.'),
        attendees: z.array(z.string()).optional().describe('Attendee email addresses.'),
        addConference: z.boolean().default(false).describe('Attach a Google Meet link.'),
        recurrence: z
          .array(z.string())
          .optional()
          .describe('RRULE strings, e.g. ["RRULE:FREQ=WEEKLY;COUNT=10"].'),
        calendarId: calendarIdArg,
        sendUpdates: sendUpdatesArg,
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const acc = resolveAccount(user, args.account);
        const cal = await calendarClient(acc);
        const event = await createEvent(
          cal,
          args.calendarId,
          {
            summary: args.summary,
            description: args.description,
            location: args.location,
            start: args.start,
            end: args.end,
            timeZone: args.timeZone,
            attendees: args.attendees,
            addConference: args.addConference,
            recurrence: args.recurrence,
          },
          args.sendUpdates,
        );
        return ok({ created: true, account: acc.email, calendarId: args.calendarId, event });
      }),
  );

  server.registerTool(
    'update_event',
    {
      title: 'Update a calendar event',
      description:
        'Changes an existing event. Only the fields you provide are modified; everything ' +
        'else is left alone.\n\n' +
        'To change who is invited, use addAttendees and removeAttendees — they merge against ' +
        'the current guest list, so everyone else keeps their RSVP and any booked room stays ' +
        'booked. Use setAttendees only when you genuinely mean to replace the whole list.\n\n' +
        'A meeting room is an attendee, not the location field: add or remove it by its ' +
        'resource address (find_rooms lists the ones you have used). The location field is ' +
        'free text and books nothing.\n\n' +
        'For a repeating event, this changes only the one occurrence unless you pass ' +
        'applyTo:"series".',
      inputSchema: {
        eventId: z.string().describe('Event id, from list_events.'),
        summary: z.string().optional().describe('New title.'),
        start: z.string().optional().describe('New start.'),
        end: z.string().optional().describe('New end.'),
        description: z.string().optional().describe('New description.'),
        location: z
          .string()
          .optional()
          .describe('Free-text location. Does NOT book a room — use addAttendees for that.'),
        timeZone: z.string().optional().describe('IANA timezone for new start/end.'),
        addAttendees: z
          .array(z.string())
          .optional()
          .describe('Addresses to invite, added to the existing guests. Rooms go here too.'),
        removeAttendees: z
          .array(z.string())
          .optional()
          .describe('Addresses to uninvite. Removing a room releases the booking.'),
        setAttendees: z
          .array(z.string())
          .optional()
          .describe(
            'Replace the entire guest list. Anyone omitted is uninvited, including rooms. ' +
              'Prefer addAttendees/removeAttendees unless a full replacement is intended.',
          ),
        recurrence: z.array(z.string()).optional().describe('Replacement RRULE list.'),
        applyTo: z
          .enum(['instance', 'series'])
          .default('instance')
          .describe(
            'For a repeating event: change just this occurrence, or every occurrence in the series.',
          ),
        calendarId: calendarIdArg,
        sendUpdates: sendUpdatesArg,
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const attendeeArgsGiven =
          (args.addAttendees?.length ?? 0) +
          (args.removeAttendees?.length ?? 0) +
          (args.setAttendees ? 1 : 0);

        if (args.setAttendees && (args.addAttendees?.length || args.removeAttendees?.length)) {
          throw new ServiceError(
            'Use either setAttendees (full replacement) or addAttendees/removeAttendees ' +
              '(incremental), not both.',
          );
        }

        const fieldArgsGiven =
          args.summary !== undefined ||
          args.start !== undefined ||
          args.end !== undefined ||
          args.description !== undefined ||
          args.location !== undefined ||
          args.recurrence !== undefined;

        if (!fieldArgsGiven && attendeeArgsGiven === 0) {
          throw new ServiceError('Nothing to change: no fields or attendee changes were given.');
        }

        const acc = resolveAccount(user, args.account);
        const cal = await calendarClient(acc);

        // Resolve which object to patch: the single occurrence, or the series
        // it belongs to. Patching an instance id only ever changes that day.
        let targetId = args.eventId;
        let scope: 'instance' | 'series' | 'single' = 'single';
        const before = await getEvent(cal, args.calendarId, args.eventId);

        if (before.isRecurringInstance) {
          if (args.applyTo === 'series' && before.recurringEventId) {
            targetId = before.recurringEventId;
            scope = 'series';
          } else {
            scope = 'instance';
          }
        }

        let event = before;
        const notes: string[] = [];

        if (fieldArgsGiven) {
          event = await updateEvent(
            cal,
            args.calendarId,
            targetId,
            {
              summary: args.summary,
              description: args.description,
              location: args.location,
              start: args.start,
              end: args.end,
              timeZone: args.timeZone,
              recurrence: args.recurrence,
            },
            args.sendUpdates,
          );
        }

        let attendeeResult:
          | { added: string[]; removed: string[]; unchanged: number }
          | undefined;

        if (attendeeArgsGiven > 0) {
          const result = await changeAttendees(
            cal,
            args.calendarId,
            targetId,
            args.setAttendees
              ? { replace: args.setAttendees }
              : { add: args.addAttendees, remove: args.removeAttendees },
            args.sendUpdates,
          );
          event = result.event;
          attendeeResult = {
            added: result.added,
            removed: result.removed,
            unchanged: result.unchanged,
          };

          const droppedRooms = before.rooms.filter(
            (r) => !event.rooms.some((k) => k.email === r.email),
          );
          if (droppedRooms.length) {
            notes.push(
              `Released room booking: ${droppedRooms.map((r) => r.displayName ?? r.email).join(', ')}.`,
            );
          }
          const newRooms = event.rooms.filter(
            (r) => !before.rooms.some((k) => k.email === r.email),
          );
          if (newRooms.length) {
            notes.push(`Booked room: ${newRooms.map((r) => r.displayName ?? r.email).join(', ')}.`);
          }
        }

        if (scope === 'instance') {
          notes.push(
            'This is one occurrence of a repeating event; only that occurrence changed. ' +
              'Pass applyTo:"series" to change every occurrence.',
          );
        }

        return ok({
          updated: true,
          account: acc.email,
          calendarId: args.calendarId,
          appliedTo: scope,
          ...(attendeeResult ? { attendeeChanges: attendeeResult } : {}),
          ...(notes.length ? { notes } : {}),
          event,
        });
      }),
  );

  server.registerTool(
    'delete_event',
    {
      title: 'Delete a calendar event',
      description:
        'Removes an event from the calendar. Attendees are notified unless sendUpdates is "none". ' +
        'This cannot be undone — confirm with the user before calling it.',
      inputSchema: {
        eventId: z.string().describe('Event id, from list_events.'),
        calendarId: calendarIdArg,
        sendUpdates: sendUpdatesArg,
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ eventId, calendarId, sendUpdates, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const cal = await calendarClient(acc);
        await deleteEvent(cal, calendarId, eventId, sendUpdates);
        return ok({ deleted: true, account: acc.email, calendarId, eventId });
      }),
  );

  server.registerTool(
    'respond_to_event',
    {
      title: 'Accept or decline an invitation',
      description:
        'Sets your own response status on an event you were invited to. The organiser is notified.',
      inputSchema: {
        eventId: z.string().describe('Event id, from list_events.'),
        response: z.enum(['accepted', 'declined', 'tentative']).describe('Your answer.'),
        comment: z.string().optional().describe('Optional note to the organiser.'),
        calendarId: calendarIdArg,
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ eventId, response, comment, calendarId, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const cal = await calendarClient(acc);
        const event = await respondToEvent(cal, calendarId, eventId, response, comment);
        return ok({ responded: response, account: acc.email, event });
      }),
  );

  server.registerTool(
    'find_free_time',
    {
      title: 'Find free/busy time',
      description:
        'Returns busy intervals across the given calendars in a time range, so you can work ' +
        'out when everyone is free. Covers multiple accounts at once, which is the usual case ' +
        'when someone has both a work and a personal calendar.',
      inputSchema: {
        timeMin: z.string().describe('Start of the range, ISO 8601.'),
        timeMax: z.string().describe('End of the range, ISO 8601.'),
        accounts: z
          .array(z.string())
          .optional()
          .describe('Mailbox addresses. Omit for all connected mailboxes.'),
        calendarIds: z
          .array(z.string())
          .optional()
          .describe('Calendar ids to inspect per account. Defaults to ["primary"].'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ timeMin, timeMax, accounts, calendarIds }) =>
      guard(async () => {
        const targets = resolveAccounts(user, accounts);
        const ids = calendarIds?.length ? calendarIds : ['primary'];

        const results = await Promise.all(
          targets.map(async (acc) => {
            try {
              const cal = await calendarClient(acc);
              return { account: acc.email, busy: await freeBusy(cal, ids, timeMin, timeMax) };
            } catch (err) {
              if (err instanceof ReauthRequiredError) {
                return { account: acc.email, error: 'needs_reauth', reauthUrl: err.reauthUrl };
              }
              return { account: acc.email, error: (err as Error).message };
            }
          }),
        );

        const problems: AccountProblem[] = results
          .filter((r) => 'error' in r && r.error)
          .map((r) => ({
            account: r.account,
            error: (r as { error: string }).error,
            ...('reauthUrl' in r && r.reauthUrl ? { reauthUrl: r.reauthUrl as string } : {}),
          }));

        return partial(
          { timeMin, timeMax, calendars: ids, accounts: results },
          problems,
          'busy intervals',
        );
      }),
  );

  server.registerTool(
    'find_rooms',
    {
      title: 'Find meeting rooms you can book',
      description:
        'Lists the meeting rooms that appear in your own calendar history, most frequently ' +
        'used first, with the resource address needed to book one.\n\n' +
        'A room is booked by adding its resource address as an attendee — see create_event ' +
        'or update_event\'s addAttendees. Setting the location field does not book anything.\n\n' +
        'This finds rooms you have actually had meetings in. Listing every room in an ' +
        'organisation requires Workspace admin rights, which this server does not have.',
      inputSchema: {
        accounts: z
          .array(z.string())
          .optional()
          .describe('Accounts to look through. Omit for all connected accounts.'),
        daysBack: z
          .number()
          .int()
          .min(1)
          .max(365)
          .default(120)
          .describe('How far back to look for rooms you have used.'),
        nameContains: z
          .string()
          .optional()
          .describe('Filter to rooms whose name contains this text, e.g. "Farm".'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ accounts, daysBack, nameContains }) =>
      guard(async () => {
        const targets = resolveAccounts(user, accounts);
        const needle = nameContains?.toLowerCase();

        const results = await Promise.all(
          targets.map(async (acc) => {
            try {
              const cal = await calendarClient(acc);
              const rooms = await findRoomsInHistory(cal, daysBack, 60);
              return {
                account: acc.email,
                rooms: needle
                  ? rooms.filter((r) => r.name.toLowerCase().includes(needle))
                  : rooms,
              };
            } catch (err) {
              if (err instanceof ReauthRequiredError) {
                return { account: acc.email, error: 'needs_reauth', reauthUrl: err.reauthUrl, rooms: [] };
              }
              return { account: acc.email, error: (err as Error).message, rooms: [] };
            }
          }),
        );

        const problems: AccountProblem[] = results
          .filter((r) => 'error' in r && r.error)
          .map((r) => ({
            account: r.account,
            error: (r as { error: string }).error,
            ...('reauthUrl' in r && r.reauthUrl ? { reauthUrl: r.reauthUrl as string } : {}),
          }));

        const total = results.reduce((n, r) => n + r.rooms.length, 0);

        return partial(
          {
            roomCount: total,
            accounts: results,
            howToBook:
              'Add the room\'s email to addAttendees on update_event, or to attendees on ' +
              'create_event. Check it is free first with find_free_time.',
          },
          problems,
          'rooms',
        );
      }),
  );
}
