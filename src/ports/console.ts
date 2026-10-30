// ConsolePort (plan 002 section 4.3): terminal output, grilling questions and secret input.
// Text shown to the human comes from `core/messages` templates.

export interface ConsolePort {
  /** Writes one line to stdout. */
  print(line: string): void;
  /** Writes one line to stderr. */
  printError(line: string): void;
  /** Prints a question and reads one answer, as typed. */
  ask(question: string): Promise<string>;
  /** Reads a secret without echo. */
  readSecret(prompt: string): Promise<string>;
  /** Reads all of stdin (a multi-line idea). */
  readInput(): Promise<string>;
}
