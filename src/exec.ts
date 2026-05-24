import { spawn } from "node:child_process";
import * as core from "./core";

export interface CommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  ok: boolean;
  timedOut: boolean;
}

export interface RunOptions {
  timeoutMs?: number;
  allowFailure?: boolean;
  input?: string;
  redactions?: string[];
  cwd?: string;
}

export class CommandError extends Error {
  constructor(readonly result: CommandResult) {
    const output = resultOutput(result).trim();
    super(output ? `Command failed: ${result.command}\n${output}` : `Command failed: ${result.command}`);
  }
}

export class CommandRunner {
  async run(command: string, args: string[] = [], options: RunOptions = {}): Promise<CommandResult> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const redactions = options.redactions ?? [];
    const displayCommand = redact([command, ...args].map(shellQuote).join(" "), redactions);
    core.debug(`$ ${displayCommand}`);

    const result = await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        resolve({
          command: displayCommand,
          exitCode,
          stdout: redact(stdout, redactions),
          stderr: redact(stderr, redactions),
          ok: exitCode === 0,
          timedOut
        });
      });

      if (options.input !== undefined) {
        child.stdin.end(options.input);
      } else {
        child.stdin.end();
      }
    });

    if (!result.ok && !options.allowFailure) {
      throw new CommandError(result);
    }
    return result;
  }
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function redact(value: string, redactions: string[]): string {
  let result = value;
  for (const redaction of redactions.filter(Boolean).sort((left, right) => right.length - left.length)) {
    result = result.split(redaction).join("***");
    result = result.split(shellQuote(redaction)).join("***");
  }
  return result;
}

export function resultOutput(result: CommandResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

export function assertCommandOk(result: CommandResult): void {
  if (!result.ok) {
    throw new CommandError(result);
  }
}
