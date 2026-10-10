/** A step failure the interpreter records with a customer-facing hint. */
export class StepFailure extends Error {
  readonly retryable: boolean;
  readonly hint: string | null;

  constructor(message: string, options: { retryable: boolean; hint?: string }) {
    super(message);
    this.name = "StepFailure";
    this.retryable = options.retryable;
    this.hint = options.hint ?? null;
  }
}
