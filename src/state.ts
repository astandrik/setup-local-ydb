import * as core from "./core";
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
} {
  const topology = core.getState("topology") === "root" ? "root" : "tenant";
  return {
    cleanup: core.getState("cleanup") === "true",
    topology,
    staticContainer: core.getState("staticContainer"),
    dynamicContainer: core.getState("dynamicContainer") || undefined,
    network: core.getState("network"),
    volume: core.getState("volume"),
    authDir: core.getState("authDir")
  };
}
