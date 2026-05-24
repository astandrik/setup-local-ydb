import * as core from "./core";
import type { RuntimeConfig } from "./config";

export function saveRuntimeState(config: RuntimeConfig): void {
  core.saveState("cleanup", String(config.cleanup));
  core.saveState("staticContainer", config.staticContainer);
  core.saveState("dynamicContainer", config.dynamicContainer);
  core.saveState("network", config.network);
  core.saveState("volume", config.volume);
}

export function readRuntimeState(): {
  cleanup: boolean;
  staticContainer: string;
  dynamicContainer: string;
  network: string;
  volume: string;
} {
  return {
    cleanup: core.getState("cleanup") === "true",
    staticContainer: core.getState("staticContainer"),
    dynamicContainer: core.getState("dynamicContainer"),
    network: core.getState("network"),
    volume: core.getState("volume")
  };
}
