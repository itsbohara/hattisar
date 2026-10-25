import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { CliError, EXIT } from "./errors.js";
import type { Writer } from "./output.js";

export type Input = NodeJS.ReadableStream & { isTTY?: boolean };

async function readAll(input: Input): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of input) chunks.push(chunk.toString());
  return chunks.join("");
}

// readline echoes what is typed to its output, so the output is a sink and the prompt goes to
// stderr by hand: the token must never reach the terminal.
async function promptHidden(input: Input, prompt: Writer, question: string): Promise<string> {
  const muted = new Writable({ write: (_chunk, _encoding, done) => done() });
  const rl = createInterface({ input, output: muted, terminal: true });
  const cancel = new AbortController();
  // Without a listener, readline answers Ctrl-C by pausing stdin and the question never settles.
  rl.on("SIGINT", () => cancel.abort());
  prompt.write(question);
  try {
    return await rl.question("", { signal: cancel.signal });
  } catch (error) {
    if (cancel.signal.aborted) throw new CliError(EXIT.usage, "cancelled");
    throw error;
  } finally {
    rl.close();
    prompt.write("\n");
  }
}

export async function readSecret(input: Input, prompt: Writer, question: string): Promise<string> {
  return (input.isTTY ? await promptHidden(input, prompt, question) : await readAll(input)).trim();
}

// A password may begin or end with spaces; only the line ending that piping adds is dropped.
export async function readPassword(
  input: Input,
  prompt: Writer,
  question: string,
): Promise<string> {
  const value = input.isTTY ? await promptHidden(input, prompt, question) : await readAll(input);
  return value.replace(/\r?\n$/, "");
}
