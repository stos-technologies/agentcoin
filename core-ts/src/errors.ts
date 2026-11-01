/** Error with a stable machine-readable code. */
export class AgentCoinError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AgentCoinError";
    this.code = code;
    this.details = details;
  }
}
