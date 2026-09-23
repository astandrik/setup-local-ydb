import * as core from "./core";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import type { RuntimeConfig, Topology } from "./config";

export function saveRuntimeState(config: RuntimeConfig): void {
  core.saveState("cleanup", String(config.cleanup));
  core.saveState("topology", config.topology);
  core.saveState("staticContainer", config.staticContainer);
  if (config.dynamicContainer) {
    core.saveState("dynamicContainer", config.dynamicContainer);
  }
  core.saveState("network", config.network);
  core.saveState("volume", config.volume);
  core.saveState("authDir", config.authDir);
}

export function readRuntimeState(): {
  cleanup: boolean;
  topology: Topology;
  staticContainer: string;
  dynamicContainer?: string;
  network: string;
  volume: string;
  authDir: string;
} | undefined {
  const cleanup = core.getState("cleanup");
  const topology = core.getState("topology");
  const parsedTopology: Topology = topology === "root" ? "root" : "tenant";
  const state = {
    cleanup: cleanup === "true",
    topology: parsedTopology,
    staticContainer: core.getState("staticContainer"),
    dynamicContainer: core.getState("dynamicContainer") || undefined,
    network: core.getState("network"),
    volume: core.getState("volume"),
    authDir: core.getState("authDir")
  };
  if (!cleanup && !topology && !state.staticContainer && !state.dynamicContainer &&
      !state.network && !state.volume && !state.authDir) return undefined;
  if (cleanup === "false") return state;
  const prefix = state.staticContainer.replace(/-static$/, "");
  if (
    cleanup !== "true" || !["root", "tenant"].includes(topology) ||
    !/^[a-z0-9][a-z0-9_.-]*$/.test(prefix) ||
    state.staticContainer !== `${prefix}-static` ||
    state.network !== `${prefix}-net` || state.volume !== `${prefix}-data` ||
    !isAbsolute(state.authDir) ||
    state.authDir !== join(process.env.RUNNER_TEMP || tmpdir(), `${prefix}-auth`) ||
    (topology === "tenant" && state.dynamicContainer !== `${prefix}-dynamic`) ||
    (topology === "root" && state.dynamicContainer)
  ) throw new Error("Incomplete or invalid local-ydb cleanup state; refusing to guess resource names");
  return state;
}
