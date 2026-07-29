import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { User } from '../../db/repo.js';
import {
  createEvent,
  deleteEvent,
  freeBusy,
  getEvent,
  listCalendars,
  listEvents,
  respondToEvent,
  updateEvent,
} from '../../google/calendar.js';
import { ReauthRequiredError } from '../../google/oauth.js';
import { calendarClient, resolveAccount, resolveAccounts } from '../../service.js';
import { guard, ok } from '../reply.js';

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
        return ok({ accounts: results });
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

        const failures = perAccount.filter((r) => !r.ok);

        return ok({
          timeMin,
          timeMax,
          eventCount: merged.length,
          events: merged,
          ...(failures.length
            ? {
                accountsWithProblems: failures.map((f) => ({
                  account: f.account,
                  error: f.error,
                  ...('reauthUrl' in f ? { reauthUrl: f.reauthUrl } : {}),
                })),
              }
            : {}),
        });
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
        'else is left as it is. Note that providing attendees replaces the whole list.',
      inputSchema: {
        eventId: z.string().describe('Event id, from list_events.'),
        summary: z.string().optional().describe('New title.'),
        start: z.string().optional().describe('New start.'),
        end: z.string().optional().describe('New end.'),
        description: z.string().optional().describe('New description.'),
        location: z.string().optional().describe('New location.'),
        timeZone: z.string().optional().describe('IANA timezone for new start/end.'),
        attendees: z
          .array(z.string())
          .optional()
          .describe('Replacement attendee list — this overwrites the existing attendees.'),
        recurrence: z.array(z.string()).optional().describe('Replacement RRULE list.'),
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
        const event = await updateEvent(
          cal,
          args.calendarId,
          args.eventId,
          {
            summary: args.summary,
            description: args.description,
            location: args.location,
            start: args.start,
            end: args.end,
            timeZone: args.timeZone,
            attendees: args.attendees,
            recurrence: args.recurrence,
          },
          args.sendUpdates,
        );
        return ok({ updated: true, account: acc.email, calendarId: args.calendarId, event });
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

        return ok({ timeMin, timeMax, calendars: ids, accounts: results });
      }),
  );
}
