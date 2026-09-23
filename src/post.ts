import * as core from "./core";
import { appendFileSync } from "node:fs";
import { CommandRunner } from "./exec";
import { readRuntimeState } from "./state";
import { cleanupLocalYdb } from "./ydb";

async function run(): Promise<void> {
  try {
    const state = readRuntimeState();
    if (!state) {
      report("Cleanup not required: setup saved no resource state.");
      return;
    }
    if (!state.cleanup) {
      report("cleanup=false; leaving local-ydb resources in place.");
      return;
    }
    const results = await cleanupLocalYdb(state, new CommandRunner());
    report([
      "| Resource | Name | Result | Errors |",
      "| --- | --- | --- | --- |",
      ...results.map((result) => `| ${[
        result.resource, result.name, result.status, result.errors.join("; ")
      ].map(markdownCell).join(" | ")} |`)
    ].join("\n"));
    const failed = results.filter((result) => result.status === "failed");
    if (failed.length) core.setFailed(`Cleanup could not be verified for ${failed.length} resource(s)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report(`Cleanup failed: ${markdownCell(message)}`);
    core.setFailed(message);
  }
}

function markdownCell(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\|/g, "&#124;").replace(/\r?\n/g, " ");
}

function report(body: string): void {
  const summary = `### Local YDB cleanup\n\n${body}\n`;
  core.info(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, "utf8");
    } catch (error) {
      core.setFailed(`Could not write cleanup summary: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

void run();
