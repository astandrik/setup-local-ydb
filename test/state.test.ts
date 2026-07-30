import { afterEach, describe, expect, it } from "vitest";
import { buildRuntimeConfig, parseActionInputs, type GetInput } from "../src/config";
import { readRuntimeState, saveRuntimeState } from "../src/state";

const stateKeys = [
  "cleanup",
  "topology",
  "staticContainer",
  "dynamicContainer",
  "network",
  "volume",
  "authDir"
];

function getInput(values: Record<string, string>): GetInput {
  return (name: string) => values[name] ?? "";
}

afterEach(() => {
  for (const key of stateKeys) {
    delete process.env[`STATE_${key}`];
  }
});

describe("runtime state", () => {
  it("round-trips root cleanup state without a dynamic container", () => {
    const inputs = parseActionInputs(getInput({
      topology: "root",
      "container-prefix": "setup-local-ydb-root"
    }));
    const config = buildRuntimeConfig(inputs, {
      staticGrpc: 32136,
      monitoring: 38765
    }, "26.1.1.6", { RUNNER_TEMP: "/tmp/runner" });

    saveRuntimeState(config);

    expect(readRuntimeState()).toEqual({
      cleanup: true,
      topology: "root",
      staticContainer: "setup-local-ydb-root-static",
      dynamicContainer: undefined,
      network: "setup-local-ydb-root-net",
      volume: "setup-local-ydb-root-data",
      authDir: "/tmp/runner/setup-local-ydb-root-auth"
    });
  });
});
