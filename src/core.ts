import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export interface InputOptions {
  required?: boolean;
}

export function getInput(name: string, options: InputOptions = {}): string {
  const key = `INPUT_${name.replace(/ /g, "_").replace(/-/g, "_").toUpperCase()}`;
  const value = process.env[key] ?? "";
  if (options.required && value.trim() === "") {
    throw new Error(`Input required and not supplied: ${name}`);
  }
  return value;
}

export function setOutput(name: string, value: string): void {
  writeFileCommand("GITHUB_OUTPUT", name, value);
}

export function exportVariable(name: string, value: string): void {
  process.env[name] = value;
  writeFileCommand("GITHUB_ENV", name, value);
}

export function saveState(name: string, value: string): void {
  process.env[`STATE_${name}`] = value;
  writeFileCommand("GITHUB_STATE", name, value);
}

export function getState(name: string): string {
  return process.env[`STATE_${name}`] ?? "";
}

export function setSecret(secret: string): void {
  if (secret) {
    issueCommand("add-mask", secret);
  }
}

export function setFailed(message: string): void {
  error(message);
  process.exitCode = 1;
}

export function info(message: string): void {
  console.log(message);
}

export function warning(message: string): void {
  issueCommand("warning", message);
}

export function error(message: string): void {
  issueCommand("error", message);
}

export function debug(message: string): void {
  if (process.env.RUNNER_DEBUG === "1") {
    issueCommand("debug", message);
  }
}

export async function group<T>(name: string, fn: () => Promise<T>): Promise<T> {
  issueCommand("group", name);
  try {
    return await fn();
  } finally {
    issueCommand("endgroup", "");
  }
}

function writeFileCommand(envName: "GITHUB_OUTPUT" | "GITHUB_ENV" | "GITHUB_STATE", name: string, value: string): void {
  const filePath = process.env[envName];
  if (!filePath) {
    issueCommand(envName.toLowerCase().replace("github_", ""), `${name}=${value}`);
    return;
  }
  const delimiter = `setup_local_ydb_${randomUUID()}`;
  appendFileSync(filePath, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, "utf8");
}

function issueCommand(command: string, message: string): void {
  console.log(`::${command}::${escapeCommandData(message)}`);
}

function escapeCommandData(value: string): string {
  return value
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

