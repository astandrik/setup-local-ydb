import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const directories: string[] = [];

function fixture(topology = "root") {
  const directory = mkdtempSync(join(tmpdir(), "cleanup-post-"));
  directories.push(directory);
  const bin = join(directory, "bin");
  const authDir = join(directory, "fixture-auth");
  mkdirSync(bin);
  mkdirSync(authDir);
  writeFileSync(join(authDir, "credentials"), "fixture-secret");
  const docker = join(bin, "docker");
  const source = readFileSync(resolve("test/fixtures/docker.cjs"), "utf8");
  writeFileSync(docker, source.replace("#!/usr/bin/env node", `#!${process.execPath}`));
  chmodSync(docker, 0o700);
  const file = join(directory, "docker.json");
  const summary = join(directory, "summary.md");
  const state = {
    container: ["fixture-static", ...(topology === "tenant" ? ["fixture-dynamic"] : []), "fixture-static-other"],
    network: ["fixture-net", "fixture-net-other"],
    volume: ["fixture-data", "fixture-data-other"],
    calls: [] as string[][],
    failures: [] as string[],
    sticky: [] as string[],
    unavailable: false
  };
  const env: NodeJS.ProcessEnv = {
    PATH: bin,
    MOCK_DOCKER_STATE: file,
    GITHUB_STEP_SUMMARY: summary,
    STATE_cleanup: "true",
    STATE_topology: topology,
    STATE_staticContainer: "fixture-static",
    STATE_dynamicContainer: topology === "tenant" ? "fixture-dynamic" : "",
    STATE_network: "fixture-net",
    STATE_volume: "fixture-data",
    STATE_authDir: authDir
  };
  function run() {
    writeFileSync(file, JSON.stringify(state));
    const result = spawnSync(process.execPath, [resolve("dist/post/index.js")], {
      env, encoding: "utf8", timeout: 10_000
    });
    if (result.error) throw result.error;
    Object.assign(state, JSON.parse(readFileSync(file, "utf8")));
    return result;
  }
  return { state, env, run, authDir, summary };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it.each(["root", "tenant"])("verifies %s cleanup and preserves neighboring resources on repeated cleanup", (topology) => {
  const f = fixture(topology);
  expect(f.run().status).toBe(0);
  expect(f.state.container).toEqual(["fixture-static-other"]);
  expect(f.state.network).toEqual(["fixture-net-other"]);
  expect(f.state.volume).toEqual(["fixture-data-other"]);
  expect(existsSync(f.authDir)).toBe(false);
  expect(readFileSync(f.summary, "utf8")).toContain("removed");
  expect(readFileSync(f.summary, "utf8")).not.toContain("fixture-secret");
  const previousRemovals = f.state.calls.filter((args) => args.includes("rm")).length;
  expect(f.run().status).toBe(0);
  expect(f.state.calls.filter((args) => args.includes("rm"))).toHaveLength(previousRemovals);
  expect(readFileSync(f.summary, "utf8")).toContain("absent");
});

it("rejects failed removals instead of reporting successful post cleanup", () => {
  const f = fixture();
  f.state.failures = ["container:rm", "network:rm", "volume:rm"];
  expect(f.run().status).toBe(1);
  expect(f.state.container).toContain("fixture-static");
  expect(f.state.network).toContain("fixture-net");
  expect(f.state.volume).toContain("fixture-data");
  expect(existsSync(f.authDir)).toBe(false);
  expect(readFileSync(f.summary, "utf8")).toContain("failed");
});

it("continues cleanup after one removal fails", () => {
  const f = fixture();
  f.state.failures = ["container:rm"];
  expect(f.run().status).toBe(1);
  expect(f.state.container).toContain("fixture-static");
  expect(f.state.network).toEqual(["fixture-net-other"]);
  expect(f.state.volume).toEqual(["fixture-data-other"]);
  expect(existsSync(f.authDir)).toBe(false);
});

it("does not mistake an unavailable Docker daemon for absent resources", () => {
  const f = fixture();
  f.state.unavailable = true;
  expect(f.run().status).toBe(1);
  expect(f.state.volume).toContain("fixture-data");
  expect(existsSync(f.authDir)).toBe(false);
});

it("rejects successful removal commands that leave resources behind", () => {
  const f = fixture();
  f.state.sticky = ["volume"];
  expect(f.run().status).toBe(1);
  expect(f.state.volume).toContain("fixture-data");
  expect(f.state.container).toEqual(["fixture-static-other"]);
});

it("cleans a partially started topology with no container", () => {
  const f = fixture();
  f.state.container = ["fixture-static-other"];
  expect(f.run().status).toBe(0);
  expect(f.state.calls.some((args) => args.includes("rm") && args.includes("fixture-static"))).toBe(false);
  expect(f.state.volume).toEqual(["fixture-data-other"]);
});

it("leaves resources intact when cleanup is disabled", () => {
  const f = fixture();
  f.env.STATE_cleanup = "false";
  expect(f.run().status).toBe(0);
  expect(f.state.calls).toEqual([]);
  expect(existsSync(f.authDir)).toBe(true);
});

it("records no cleanup required when setup saved no state", () => {
  const f = fixture();
  for (const key of Object.keys(f.env)) if (key.startsWith("STATE_")) delete f.env[key];
  expect(f.run().status).toBe(0);
  expect(f.state.calls).toEqual([]);
  expect(readFileSync(f.summary, "utf8")).toContain("not required");
});

it.each(["STATE_volume", "STATE_cleanup", "STATE_topology"])("rejects incomplete state missing %s without guessing resource names", (key) => {
  const f = fixture();
  delete f.env[key];
  expect(f.run().status).toBe(1);
  expect(f.state.calls).toEqual([]);
  expect(existsSync(f.authDir)).toBe(true);
});

it.each([
  ["STATE_network", "fixture-net-other"],
  ["STATE_authDir", "/"],
  ["STATE_topology", "unknown"]
])("rejects inconsistent saved %s without touching resources", (key, value) => {
  const f = fixture();
  f.env[key] = value;
  expect(f.run().status).toBe(1);
  expect(f.state.calls).toEqual([]);
  expect(existsSync(f.authDir)).toBe(true);
});
