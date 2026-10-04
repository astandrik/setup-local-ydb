const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { updateBadge } = require("../.github/scripts/count-action-users.cjs");

async function fixture(t, responses) {
  const directory = await mkdtemp(join(tmpdir(), "count-action-users-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "badge.json");
  const original = '{"message":"9"}\n';
  await writeFile(outputPath, original);
  const calls = [];
  const delays = [];
  const options = {
    token: "test-token",
    outputPath,
    now: () => 1_800_000_000_000,
    fetchImpl: async (...args) => {
      calls.push(args);
      assert.ok(responses.length, "unexpected extra API request");
      return responses.shift();
    },
    sleep: async (milliseconds) => delays.push(milliseconds)
  };
  return { options, calls, delays, original, read: () => readFile(outputPath, "utf8") };
}

const success = (count) => Response.json({ total_count: count });
const limited = (headers = {}, message = "API rate limit exceeded", status = 429) =>
  Response.json({ message }, { status, headers });

for (const [label, response, delay] of [
  ["Retry-After", limited({ "retry-after": "657", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800001000" }), 657_000],
  ["reset timestamp", limited({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000657" }), 657_000],
  ["HTTP-date Retry-After", limited({ "retry-after": new Date(1_800_000_065_000).toUTCString() }), 65_000],
  ["observed GitHub message", limited({}, "try again in 656.403809367s"), 657_000],
  ["secondary limit", limited({}, "You have exceeded a secondary rate limit.", 403), 60_000],
  ["malformed headers", limited({ "retry-after": "invalid", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "invalid" }), 60_000],
  ["negative Retry-After", limited({ "retry-after": "-1" }), 60_000],
  ["empty Retry-After", limited({ "retry-after": "" }), 60_000]
]) {
  test(`waits for ${label}, then updates the badge`, async (t) => {
    const f = await fixture(t, [response, success(12)]);
    await updateBadge(f.options);
    assert.deepEqual(f.delays, [delay]);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(JSON.parse(await f.read()), {
      color: "#007ec6", label: "used by", logoColor: "#fff",
      message: "12", namedLogo: "githubactions", schemaVersion: 1
    });
    const [url, options] = f.calls[0];
    assert.equal(new URL(url).origin, "https://api.github.com");
    assert.equal(new URL(url).searchParams.get("q"), "astandrik setup-local-ydb path:.github/workflows language:YAML");
    assert.equal(options.headers.Authorization, "Bearer test-token");
  });
}

test("stops after four attempts and preserves the badge", async (t) => {
  const f = await fixture(t, Array.from({ length: 4 }, () => limited()));
  await assert.rejects(updateBadge(f.options), /4 attempts/);
  assert.deepEqual(f.delays, [60_000, 120_000, 240_000]);
  assert.equal(f.calls.length, 4);
  assert.equal(await f.read(), f.original);
});

test("does not retry early when the required wait exceeds the total budget", async (t) => {
  const f = await fixture(t, [limited({ "retry-after": "900" }), limited({ "retry-after": "900" })]);
  await assert.rejects(updateBadge(f.options), /wait budget/);
  assert.deepEqual(f.delays, [900_000]);
  assert.equal(f.calls.length, 2);
  assert.equal(await f.read(), f.original);
});

for (const status of [401, 403, 404, 422]) {
  test(`does not retry ordinary HTTP ${status}`, async (t) => {
    const f = await fixture(t, [Response.json({ message: "Request failed" }, { status })]);
    await assert.rejects(updateBadge(f.options), new RegExp(`HTTP ${status}`));
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.delays, []);
    assert.equal(await f.read(), f.original);
  });
}

for (const count of [undefined, -1, 1.5, "12", null]) {
  test(`rejects invalid count ${JSON.stringify(count)} without changing the badge`, async (t) => {
    const f = await fixture(t, [success(count)]);
    await assert.rejects(updateBadge(f.options), /total_count/);
    assert.equal(await f.read(), f.original);
  });
}

for (const [count, message] of [[1, "1"], [9999, "9999"], [10450, "10.4K"], [1234567, "1.23M"]]) {
  test(`preserves badge count formatting for ${count}`, async (t) => {
    const f = await fixture(t, [success(count)]);
    await updateBadge(f.options);
    assert.equal(JSON.parse(await f.read()).message, message);
    assert.deepEqual(f.delays, []);
  });
}

test("preserves the existing badge when search returns zero", async (t) => {
  const f = await fixture(t, [success(0)]);
  await updateBadge(f.options);
  assert.equal(await f.read(), f.original);
});

test("requires a token before querying GitHub", async (t) => {
  const f = await fixture(t, []);
  await assert.rejects(updateBadge({ ...f.options, token: "" }), /GITHUB_TOKEN/);
  assert.equal(f.calls.length, 0);
  assert.equal(await f.read(), f.original);
});

for (const fails of [false, true]) {
  test(`workflow ${fails ? "does not publish a failed query" : "publishes once after recovery"}`, async (t) => {
    const { execFileSync, spawnSync } = require("node:child_process");
    const { mkdir } = require("node:fs/promises");
    const { parse } = require("yaml");
    const f = await fixture(t, []);
    const directory = require("node:path").dirname(f.options.outputPath);
    const repo = join(directory, "repo");
    const remote = join(directory, "remote.git");
    const env = {
      PATH: process.env.PATH,
      HOME: directory,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GITHUB_TOKEN: "test-token"
    };
    const git = (args, cwd = repo) => execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
    git(["init", "--bare", remote], directory);
    git(["clone", remote, repo], directory);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", "test@example.test"]);
    await mkdir(join(repo, "docs/endpoints"), { recursive: true });
    await mkdir(join(repo, ".github/scripts"), { recursive: true });
    await writeFile(join(repo, "docs/endpoints/setup-local-ydb.json"), f.original);
    await writeFile(join(repo, ".github/scripts/count-action-users.cjs"), await readFile(join(__dirname, "../.github/scripts/count-action-users.cjs")));
    git(["add", "."]);
    git(["commit", "-m", "Baseline"]);
    git(["push", "origin", "HEAD"]);
    const before = git(["rev-parse", "HEAD"]);
    await writeFile(join(repo, "unrelated.txt"), "must remain uncommitted");
    const preload = join(directory, "mock-api.cjs");
    await writeFile(preload, `
      require("node:timers/promises").setTimeout = async () => {};
      let calls = 0;
      globalThis.fetch = async () => ++calls === 1 || ${fails}
        ? Response.json({ message: "try again in 656.403809367s" }, { status: 429 })
        : Response.json({ total_count: 12 });
    `);
    env.NODE_OPTIONS = `--require=${preload}`;
    const workflow = parse(await readFile(join(__dirname, "../.github/workflows/count-action-users.yml"), "utf8"));
    const command = workflow.jobs.count.steps.filter((step) => step.run).map((step) => step.run).join("\n");
    const run = () => spawnSync("bash", ["-e", "-o", "pipefail", "-c", command], { cwd: repo, env, encoding: "utf8" });
    const result = run();
    assert.equal(result.status, fails ? 1 : 0, result.stdout + result.stderr);
    const after = git(["rev-parse", "HEAD"]);
    assert.equal(git(["rev-parse", "HEAD"], remote), after);
    assert.equal(git(["status", "--porcelain"]), "?? unrelated.txt");
    if (fails) {
      assert.equal(after, before);
      assert.equal(await readFile(join(repo, "docs/endpoints/setup-local-ydb.json"), "utf8"), f.original);
    } else {
      assert.notEqual(after, before);
      assert.equal(git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]), "docs/endpoints/setup-local-ydb.json");
      assert.equal(JSON.parse(await readFile(join(repo, "docs/endpoints/setup-local-ydb.json"), "utf8")).message, "12");
      const unchanged = run();
      assert.equal(unchanged.status, 0, unchanged.stdout + unchanged.stderr);
      assert.equal(git(["rev-parse", "HEAD"]), after);
    }
  });
}
