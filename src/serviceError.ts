/**
 * A user-facing problem that should be reported verbatim, not as a stack trace.
 *
 * Lives in its own module so the provider layers can throw it without importing
 * service.ts, which imports them.
 */
export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceError';
  }
}
