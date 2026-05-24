import { describe, expect, it } from "vitest";
import { buildRuntimeConfig, parseActionInputs, parseBooleanInput, sanitizeDockerName, type GetInput } from "../src/config";

function getInput(values: Record<string, string>): GetInput {
  return (name: string) => values[name] ?? "";
}

describe("config", () => {
  it("parses defaults and generated prefix", () => {
    const inputs = parseActionInputs(getInput({}), {
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_JOB: "test"
    });
    expect(inputs.version).toBe("26.1.1.6");
    expect(inputs.tenant).toBe("/local/test");
    expect(inputs.auth).toBe(false);
    expect(inputs.cleanup).toBe(true);
    expect(inputs.containerPrefix).toBe("setup-local-ydb-123-2-test");
  });

  it("parses explicit inputs", () => {
    const inputs = parseActionInputs(getInput({
      version: "latest",
      tenant: "/local/ci",
      auth: "yes",
      cleanup: "0",
      "static-grpc-port": "2136",
      "dynamic-grpc-port": "2137",
      "monitoring-port": "8765",
      "container-prefix": "Local YDB CI!"
    }));
    expect(inputs).toMatchObject({
      version: "latest",
      tenant: "/local/ci",
      auth: true,
      cleanup: false,
      staticGrpcPort: 2136,
      dynamicGrpcPort: 2137,
      monitoringPort: 8765,
      containerPrefix: "local-ydb-ci"
    });
  });

  it("rejects invalid tenant paths", () => {
    expect(() => parseActionInputs(getInput({ tenant: "/Root/test" }))).toThrow(/tenant must match/);
  });

  it("rejects invalid booleans", () => {
    expect(() => parseBooleanInput("maybe", "auth", false)).toThrow(/auth must be/);
  });

  it("sanitizes Docker names", () => {
    expect(sanitizeDockerName(" Setup Local/YDB CI ")).toBe("setup-local-ydb-ci");
  });

  it("builds runtime outputs and resource names", () => {
    const inputs = parseActionInputs(getInput({
      tenant: "/local/ci",
      auth: "true",
      "container-prefix": "setup-local-ydb-test"
    }));
    const config = buildRuntimeConfig(inputs, {
      staticGrpc: 32136,
      dynamicGrpc: 32137,
      monitoring: 38765,
      dynamicMonitoring: 8766,
      dynamicIc: 19002
    }, "26.1.1.6", { RUNNER_TEMP: "/tmp/runner" });
    expect(config.image).toBe("ghcr.io/ydb-platform/local-ydb:26.1.1.6");
    expect(config.endpoint).toBe("grpc://127.0.0.1:32137");
    expect(config.monitoringUrl).toBe("http://127.0.0.1:38765");
    expect(config.staticContainer).toBe("setup-local-ydb-test-static");
    expect(config.rootPasswordFile).toBe("/tmp/runner/setup-local-ydb-test-auth/root.password");
  });
});

