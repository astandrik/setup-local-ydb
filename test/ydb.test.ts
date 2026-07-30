import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRuntimeConfig, parseActionInputs, type GetInput, type RuntimeConfig } from "../src/config";
import type { CommandResult, RunOptions } from "../src/exec";
import { cleanupLocalYdb, collectDiagnostics, setupLocalYdb } from "../src/ydb";

interface RecordedCall {
  command: string;
  args: string[];
  options: RunOptions;
}

class RecordingRunner {
  readonly calls: RecordedCall[] = [];

  async run(command: string, args: string[] = [], options: RunOptions = {}): Promise<CommandResult> {
    this.calls.push({ command, args, options });
    const joinedArgs = args.join(" ");
    let stdout = "";
    if (joinedArgs.includes("printf '%s\\n' \"$generated_config\"")) {
      stdout = "/ydb_data/cluster/kikimr_configs/config.yaml\n";
    } else if (args[0] === "exec" && args.includes("cat")) {
      stdout = [
        "domains_config:",
        "  security_config:",
        "    default_users:",
        "      - name: root",
        "        password: test-root-password",
        ""
      ].join("\n");
    } else if (joinedArgs.includes("admin database") && joinedArgs.includes("status")) {
      stdout = "State: RUNNING\n";
    }
    return {
      command: [command, ...args].join(" "),
      exitCode: 0,
      stdout,
      stderr: "",
      ok: true,
      timedOut: false
    };
  }
}

const temporaryDirectories: string[] = [];
const noWait = async (): Promise<void> => undefined;

function getInput(values: Record<string, string>): GetInput {
  return (name: string) => values[name] ?? "";
}

async function runtimeConfig(topology: "tenant" | "root", auth = false): Promise<RuntimeConfig> {
  const runnerTemp = await mkdtemp(join(tmpdir(), `setup-local-ydb-${topology}-`));
  temporaryDirectories.push(runnerTemp);
  const inputs = parseActionInputs(getInput({
    topology,
    tenant: topology === "tenant" ? "/local/test" : "/ignored",
    auth: String(auth),
    "container-prefix": `setup-local-ydb-${topology}`
  }));
  return buildRuntimeConfig(inputs, topology === "tenant" ? {
    staticGrpc: 32136,
    dynamicGrpc: 32137,
    monitoring: 38765,
    dynamicMonitoring: 8766,
    dynamicIc: 19002
  } : {
    staticGrpc: 32136,
    monitoring: 38765
  }, "26.1.1.6", { RUNNER_TEMP: runnerTemp });
}

function dockerRunCalls(runner: RecordingRunner): RecordedCall[] {
  return runner.calls.filter(({ command, args }) => command === "docker" && args[0] === "run");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("setupLocalYdb", () => {
  it("keeps the tenant topology static plus dynamic lifecycle", async () => {
    const config = await runtimeConfig("tenant");
    const runner = new RecordingRunner();

    await setupLocalYdb(config, runner, {
      sleep: noWait,
      fetch: vi.fn(async () => new Response("", { status: 200 }))
    });

    expect(dockerRunCalls(runner)).toHaveLength(2);
    expect(dockerRunCalls(runner)[0].args).toContain("YDB_FEATURE_FLAGS=enable_graph_shard");
    expect(dockerRunCalls(runner)[1].args).toContain(config.dynamicContainer);
  });

  it("starts only the static root database and waits for /local metadata", async () => {
    const config = await runtimeConfig("root");
    const runner = new RecordingRunner();

    await setupLocalYdb(config, runner, {
      sleep: noWait,
      fetch: vi.fn(async () => new Response("", { status: 200 }))
    });

    const runCalls = dockerRunCalls(runner);
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].args).not.toContain("YDB_FEATURE_FLAGS=enable_graph_shard");
    expect(runCalls[0].args.filter((arg) => arg === "-p")).toHaveLength(2);
    expect(runner.calls.some(({ args }) =>
      args.join(" ").includes("/ydb -e grpc://localhost:32136 -d /local scheme ls /local")
    )).toBe(true);
  });

  it("hardens root auth without creating a dynamic token or node", async () => {
    const config = await runtimeConfig("root", true);
    const runner = new RecordingRunner();
    const fetchMock = vi.fn(async () => new Response("", { status: 401 }));

    await setupLocalYdb(config, runner, {
      sleep: noWait,
      fetch: fetchMock
    });

    expect(dockerRunCalls(runner)).toHaveLength(1);
    expect(runner.calls.some(({ args }) =>
      args.join(" ").includes("/ydb -e grpc://localhost:32136 -d /local") &&
      args.join(" ").includes("--user root")
    )).toBe(true);
    await expect(stat(config.dynamicNodeAuthTokenFile)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledWith(`${config.monitoringUrl}/viewer/json/whoami`);
  });
});

describe("topology-aware teardown and diagnostics", () => {
  it("cleans only root resources and the action-scoped auth directory", async () => {
    const config = await runtimeConfig("root");
    const runner = new RecordingRunner();
    await mkdir(config.authDir, { recursive: true });
    await writeFile(join(config.authDir, "artifact"), "test");

    await cleanupLocalYdb(config, runner);

    expect(runner.calls.map(({ args }) => args)).toEqual([
      ["rm", "-f", config.staticContainer],
      ["network", "rm", config.network],
      ["volume", "rm", config.volume]
    ]);
    await expect(stat(config.authDir)).rejects.toThrow();
  });

  it("collects logs only from containers created by root topology", async () => {
    const config = await runtimeConfig("root");
    const runner = new RecordingRunner();

    await collectDiagnostics(config, runner);

    expect(runner.calls.map(({ args }) => args)).toEqual([
      ["ps", "-a", "--filter", `name=${config.staticContainer}`],
      ["logs", "--tail", "120", config.staticContainer]
    ]);
  });
});
