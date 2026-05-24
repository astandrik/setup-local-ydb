import * as core from "./core";
import { CommandRunner } from "./exec";
import { readRuntimeState } from "./state";
import { cleanupLocalYdb } from "./ydb";

async function run(): Promise<void> {
  try {
    const state = readRuntimeState();
    if (!state.cleanup) {
      core.info("cleanup=false; leaving local-ydb Docker resources in place");
      return;
    }
    if (!state.staticContainer || !state.dynamicContainer || !state.network || !state.volume) {
      core.info("No local-ydb cleanup state found");
      return;
    }
    await cleanupLocalYdb(state, new CommandRunner());
  } catch (error) {
    core.warning(error instanceof Error ? error.message : String(error));
  }
}

void run();
