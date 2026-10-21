export const EXIT = { ok: 0, api: 1, usage: 2, auth: 3 } as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  constructor(
    readonly exitCode: ExitCode,
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
  }
}

export class UsageError extends CliError {
  constructor(
    message: string,
    readonly usage: string,
  ) {
    super(EXIT.usage, message);
  }
}
