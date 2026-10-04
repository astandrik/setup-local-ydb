const { writeFile } = require("node:fs/promises");
const { setTimeout: sleep } = require("node:timers/promises");

const SEARCH_URL = "https://api.github.com/search/code?" + new URLSearchParams({
  q: "astandrik setup-local-ydb path:.github/workflows language:YAML",
  per_page: "1"
});
const MAX_ATTEMPTS = 4;
const MAX_WAIT_MS = 20 * 60_000;

function retryDelay(response, message, attempt, now) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null && retryAfter.trim() !== "") {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.max(1, Math.ceil(seconds)) * 1000;
    }
    if (!Number.isFinite(seconds)) {
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) return Math.max(1000, date - now());
    }
  }
  if (response.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset) && reset > 0) {
      return Math.max(1000, Math.ceil(reset - now() / 1000) * 1000);
    }
  }
  // Code Search also returns a fractional delay in the response body.
  const delay = /^try again in (\d+(?:\.\d+)?)s$/.exec(message);
  if (delay) return Math.ceil(Number(delay[1])) * 1000;
  return 60_000 * 2 ** attempt;
}

function formatCount(count) {
  if (count < 10_000) return String(count);
  if (count < 1_000_000) return `${(Math.floor(count / 100) / 10).toFixed(1)}K`;
  return `${(Math.floor(count / 10_000) / 100).toFixed(2)}M`;
}

async function updateBadge({
  token,
  outputPath = "docs/endpoints/setup-local-ydb.json",
  fetchImpl = fetch,
  sleep: wait = sleep,
  now = Date.now
}) {
  if (!token) throw new Error("GITHUB_TOKEN is required");
  let waited = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await fetchImpl(SEARCH_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "setup-local-ydb-action-users"
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000)
    });
    const body = await response.json().catch(() => null);
    if (response.ok) {
      const count = body?.total_count;
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error("GitHub search returned an invalid total_count");
      }
      // Preserve the previous action's behavior for empty search results.
      if (count === 0) {
        console.warn("GitHub search returned zero results; retaining the existing badge");
        return;
      }
      await writeFile(outputPath, JSON.stringify({
        color: "#007ec6", label: "used by", logoColor: "#fff",
        message: formatCount(count), namedLogo: "githubactions", schemaVersion: 1
      }) + "\n");
      return;
    }
    const message = typeof body?.message === "string" ? body.message : "";
    const rateLimited = response.status === 429 || (response.status === 403 && (
      response.headers.has("retry-after") ||
      response.headers.get("x-ratelimit-remaining") === "0" ||
      /rate limit/i.test(message)
    ));
    if (!rateLimited) throw new Error(`GitHub search failed: HTTP ${response.status}`);
    if (attempt + 1 === MAX_ATTEMPTS) {
      throw new Error(`GitHub search failed after ${MAX_ATTEMPTS} attempts (HTTP ${response.status})`);
    }
    const delay = retryDelay(response, message, attempt, now);
    if (waited + delay > MAX_WAIT_MS) {
      throw new Error("GitHub rate limit exceeds the 20-minute wait budget; retaining the existing badge");
    }
    console.warn(`GitHub search HTTP ${response.status}; retry ${attempt + 1}/${MAX_ATTEMPTS - 1} in ${delay / 1000}s`);
    await wait(delay);
    waited += delay;
  }
}

module.exports = { updateBadge };

if (require.main === module) {
  updateBadge({ token: process.env.GITHUB_TOKEN }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
