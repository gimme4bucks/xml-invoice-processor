/** A rule of the domain was violated. `code` is stable and ends up in Problem Details. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
