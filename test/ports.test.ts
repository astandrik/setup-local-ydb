import { describe, expect, it } from "vitest";
import { resolveRuntimePorts } from "../src/ports";

describe("ports", () => {
  it("uses explicit unique ports", async () => {
    await expect(resolveRuntimePorts({
      version: "26.1.1.6",
      tenant: "/local/test",
      auth: false,
      cleanup: true,
      staticGrpcPort: 2136,
      dynamicGrpcPort: 2137,
      monitoringPort: 8765,
      containerPrefix: "setup-local-ydb-test"
    })).resolves.toMatchObject({
      staticGrpc: 2136,
      dynamicGrpc: 2137,
      monitoring: 8765
    });
  });

  it("rejects duplicate explicit ports", async () => {
    await expect(resolveRuntimePorts({
      version: "26.1.1.6",
      tenant: "/local/test",
      auth: false,
      cleanup: true,
      staticGrpcPort: 2136,
      dynamicGrpcPort: 2136,
      monitoringPort: 8765,
      containerPrefix: "setup-local-ydb-test"
    })).rejects.toThrow(/must be unique/);
  });
});

