import { mkdir, writeFile, chmod } from "node:fs/promises";
import * as core from "./core";
import YAML from "yaml";
import type { RuntimeConfig } from "./config";
import { CommandError, CommandRunner, resultOutput, shellQuote } from "./exec";

const RETRY_DELAY_MS = 2000;
const STATUS_ATTEMPTS = 45;
const METADATA_ATTEMPTS = 45;
const AUTH_DYNAMIC_ATTEMPTS = 2;

export async function setupLocalYdb(config: RuntimeConfig, runner: CommandRunner): Promise<void> {
  core.info(`Pulling ${config.image}`);
  await runner.run("docker", ["pull", config.image], { timeoutMs: 60 * 60 * 1000 });
  await runner.run("docker", ["network", "create", config.network], { timeoutMs: 60_000 });
  await runner.run("docker", ["volume", "create", config.volume], { timeoutMs: 60_000 });

  core.info(`Starting static local-ydb node ${config.staticContainer}`);
  await startStaticNode(config, runner);
  await sleep(5000);
  await ensureTenant(config, runner, false);

  core.info(`Starting dynamic tenant node ${config.dynamicContainer}`);
  await startDynamicNode(config, runner, false);
  await sleep(5000);
  await waitForTenantMetadata(config, runner, false);

  if (config.auth) {
    core.info("Applying native YDB auth");
    await applyAuth(config, runner);
  } else {
    await verifyAnonymousCapabilities(config);
  }
}

export async function cleanupLocalYdb(config: Pick<RuntimeConfig, "dynamicContainer" | "staticContainer" | "network" | "volume">, runner: CommandRunner): Promise<void> {
  await runner.run("docker", ["rm", "-f", config.dynamicContainer], { allowFailure: true, timeoutMs: 60_000 });
  await runner.run("docker", ["rm", "-f", config.staticContainer], { allowFailure: true, timeoutMs: 60_000 });
  await runner.run("docker", ["network", "rm", config.network], { allowFailure: true, timeoutMs: 60_000 });
  await runner.run("docker", ["volume", "rm", config.volume], { allowFailure: true, timeoutMs: 60_000 });
}

export async function collectDiagnostics(config: Pick<RuntimeConfig, "staticContainer" | "dynamicContainer">, runner: CommandRunner): Promise<void> {
  await core.group("local-ydb diagnostics", async () => {
    await printDiagnosticCommand(runner, "docker", ["ps", "-a", "--filter", `name=${config.staticContainer}`, "--filter", `name=${config.dynamicContainer}`]);
    await printDiagnosticCommand(runner, "docker", ["logs", "--tail", "120", config.staticContainer]);
    await printDiagnosticCommand(runner, "docker", ["logs", "--tail", "120", config.dynamicContainer]);
  });
}

async function startStaticNode(config: RuntimeConfig, runner: CommandRunner): Promise<void> {
  await runner.run("docker", [
    "run", "-d",
    "--name", config.staticContainer,
    "--no-healthcheck",
    "--network", config.network,
    "--restart", "no",
    "-p", `127.0.0.1:${config.ports.staticGrpc}:${config.ports.staticGrpc}`,
    "-p", `127.0.0.1:${config.ports.dynamicGrpc}:${config.ports.dynamicGrpc}`,
    "-p", `127.0.0.1:${config.ports.monitoring}:8765`,
    "-v", `${config.volume}:/ydb_data`,
    "-e", `GRPC_PORT=${config.ports.staticGrpc}`,
    "-e", "MON_PORT=8765",
    "-e", "GRPC_TLS_PORT=",
    "-e", "YDB_GRPC_ENABLE_TLS=0",
    "-e", "YDB_ANONYMOUS_CREDENTIALS=1",
    "-e", "YDB_LOCAL_SURVIVE_RESTART=1",
    "-e", "YDB_FEATURE_FLAGS=enable_graph_shard",
    config.image
  ], { timeoutMs: 60_000 });
}

async function startDynamicNode(config: RuntimeConfig, runner: CommandRunner, withAuth: boolean): Promise<void> {
  await runner.run("docker", ["rm", "-f", config.dynamicContainer], { allowFailure: true, timeoutMs: 60_000 });
  const authMounts = withAuth
    ? ["-v", `${config.dynamicNodeAuthTokenFile}:/run/local-ydb/dynamic-node-auth.pb:ro`]
    : [];
  const authArgs = withAuth
    ? ["--auth-token-file", "/run/local-ydb/dynamic-node-auth.pb"]
    : [];

  await runner.run("docker", [
    "run", "-d",
    "--name", config.dynamicContainer,
    "--no-healthcheck",
    "--network", `container:${config.staticContainer}`,
    "--restart", "no",
    "-v", `${config.volume}:/ydb_data:ro`,
    "-e", `GRPC_PORT=${config.ports.dynamicGrpc}`,
    "-e", `MON_PORT=${config.ports.dynamicMonitoring}`,
    "-e", "GRPC_TLS_PORT=",
    "-e", "YDB_GRPC_ENABLE_TLS=0",
    ...authMounts,
    "--entrypoint", "/bin/bash",
    config.image,
    "-lc", dynamicNodeScript(config, authArgs)
  ], { timeoutMs: 60_000 });
}

function dynamicNodeScript(config: RuntimeConfig, authArgs: string[]): string {
  return [
    "set -euo pipefail",
    "cfg=/tmp/local-ydb-dynamic-config.yaml",
    ...generatedConfigDiscoveryLines("source_config"),
    "sed -e '/^  ca: \\/ydb_certs\\/ca\\.pem$/d' -e '/^  cert: \\/ydb_certs\\/cert\\.pem$/d' -e '/^  key: \\/ydb_certs\\/key\\.pem$/d' \"$source_config\" > \"$cfg\"",
    [
      "exec", "/ydbd", "server",
      "--yaml-config", "\"$cfg\"",
      "--tcp",
      ...authArgs.map(shellQuote),
      "--node-broker", shellQuote(`grpc://127.0.0.1:${config.ports.staticGrpc}`),
      "--grpc-port", String(config.ports.dynamicGrpc),
      "--mon-port", String(config.ports.dynamicMonitoring),
      "--ic-port", String(config.ports.dynamicIc),
      "--tenant", shellQuote(config.tenantPath),
      "--node-host", "127.0.0.1",
      "--node-address", "127.0.0.1",
      "--node-resolve-host", "127.0.0.1",
      "--node-domain", "local"
    ].join(" ")
  ].join("\n");
}

async function ensureTenant(config: RuntimeConfig, runner: CommandRunner, authenticated: boolean): Promise<void> {
  for (let attempt = 1; attempt <= STATUS_ATTEMPTS; attempt += 1) {
    const status = authenticated
      ? await runYdbdWithPassword(config, runner, ["admin", "database", config.tenantPath, "status"], { allowFailure: true })
      : await runYdbd(config, runner, ["--no-password", "admin", "database", config.tenantPath, "status"], { allowFailure: true });
    const output = resultOutput(status);

    if (/State:\s*(RUNNING|PENDING_RESOURCES)/.test(output)) {
      return;
    }
    if (/Unknown tenant|NOT_FOUND/i.test(output)) {
      const create = authenticated
        ? await runYdbdWithPassword(config, runner, ["admin", "database", config.tenantPath, "create", "hdd:1"], { allowFailure: true })
        : await runYdbd(config, runner, ["--no-password", "admin", "database", config.tenantPath, "create", "hdd:1"], { allowFailure: true });
      if (!create.ok && !/Group fit error|failed to allocate group|no group options/i.test(resultOutput(create))) {
        throw new CommandError(create);
      }
    } else if (!isRetryableYdbOutput(output) && attempt > 3) {
      throw new CommandError(status);
    }
    await sleep(RETRY_DELAY_MS);
  }
  throw new Error(`Timed out waiting for tenant ${config.tenantPath} status`);
}

async function waitForTenantMetadata(config: RuntimeConfig, runner: CommandRunner, authenticated: boolean): Promise<void> {
  for (let attempt = 1; attempt <= METADATA_ATTEMPTS; attempt += 1) {
    const result = authenticated
      ? await runYdbWithPassword(config, runner, ["scheme", "ls", config.tenantPath], { allowFailure: true })
      : await runYdb(config, runner, ["scheme", "ls", config.tenantPath], { allowFailure: true });
    if (result.ok) {
      return;
    }
    if (!isRetryableYdbOutput(resultOutput(result)) && attempt > 3) {
      throw new CommandError(result);
    }
    await sleep(RETRY_DELAY_MS);
  }
  throw new Error(`Timed out waiting for tenant metadata at ${config.tenantPath}`);
}

async function applyAuth(config: RuntimeConfig, runner: CommandRunner): Promise<void> {
  await prepareAuthArtifacts(config, runner);
  const rootPassword = await readPasswordFile(config);
  core.setSecret(rootPassword);

  await runner.run("docker", ["cp", config.authConfigPath, `${config.staticContainer}:/tmp/setup-local-ydb-config.yaml`], {
    timeoutMs: 60_000,
    redactions: [config.authConfigPath]
  });
  await runner.run("docker", ["exec", config.staticContainer, "bash", "-lc", [
    "set -euo pipefail",
    ...generatedConfigDiscoveryLines("target"),
    "cp \"$target\" \"$target.before-setup-local-ydb-auth\"",
  ].join("\n")], { timeoutMs: 60_000 });
  await runner.run("docker", ["stop", config.dynamicContainer], { allowFailure: true, timeoutMs: 60_000 });
  await runner.run("docker", ["restart", config.staticContainer], { timeoutMs: 60_000 });
  await sleep(5000);
  await runner.run("docker", ["exec", config.staticContainer, "bash", "-lc", [
    "set -euo pipefail",
    ...generatedConfigDiscoveryLines("target"),
    "cp /tmp/setup-local-ydb-config.yaml \"$target\""
  ].join("\n")], { timeoutMs: 60_000 });
  await runner.run("docker", ["restart", config.staticContainer], { timeoutMs: 60_000 });
  await sleep(5000);
  await ensureTenant(config, runner, true);
  await sleep(15000);
  await writeDynamicNodeAuthToken(config, runner);
  await startAuthenticatedDynamicNode(config, runner);
  await verifyAnonymousViewerIsDenied(config);
}

async function prepareAuthArtifacts(config: RuntimeConfig, runner: CommandRunner): Promise<void> {
  const configPath = await readGeneratedConfigPath(config, runner);
  const generatedConfig = await runner.run("docker", ["exec", config.staticContainer, "cat", configPath], { timeoutMs: 60_000 });
  const document = YAML.parse(generatedConfig.stdout) as Record<string, unknown>;
  if (!document || typeof document !== "object") {
    throw new Error("Generated local-ydb config is not a YAML object");
  }
  const domainsConfig = ensureRecord(document, "domains_config");
  const securityConfig = ensureRecord(domainsConfig, "security_config");
  securityConfig.enforce_user_token_requirement = true;
  const allowedSids = unique([config.dynamicNodeAuthSid, config.rootUser, "root@builtin"]);
  securityConfig.database_allowed_sids = [...allowedSids];
  securityConfig.viewer_allowed_sids = [...allowedSids];
  securityConfig.monitoring_allowed_sids = [...allowedSids];
  securityConfig.administration_allowed_sids = [...allowedSids];
  securityConfig.bootstrap_allowed_sids = [...allowedSids];
  securityConfig.register_dynamic_node_allowed_sids = [...allowedSids];

  const rootPassword = extractRootPassword(securityConfig);
  await mkdir(config.authDir, { recursive: true, mode: 0o700 });
  await writeFile(config.authConfigPath, YAML.stringify(document, { aliasDuplicateObjects: false }), { mode: 0o600 });
  await writeFile(config.rootPasswordFile, `${rootPassword}\n`, { mode: 0o600 });
  await chmod(config.authConfigPath, 0o600);
  await chmod(config.rootPasswordFile, 0o600);
}

async function writeDynamicNodeAuthToken(config: RuntimeConfig, runner: CommandRunner): Promise<void> {
  await mkdir(config.authDir, { recursive: true, mode: 0o700 });
  await writeFile(config.dynamicNodeAuthTokenFile, [
    `StaffApiUserToken: "${escapeTextProto(config.dynamicNodeAuthSid)}"`,
    `NodeRegistrationToken: "${escapeTextProto(config.dynamicNodeAuthSid)}"`,
    ""
  ].join("\n"), { mode: 0o600 });
  await chmod(config.dynamicNodeAuthTokenFile, 0o600);
}

async function startAuthenticatedDynamicNode(config: RuntimeConfig, runner: CommandRunner): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= AUTH_DYNAMIC_ATTEMPTS; attempt += 1) {
    await startDynamicNode(config, runner, true);
    await sleep(5000);
    try {
      await waitForTenantMetadata(config, runner, true);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === AUTH_DYNAMIC_ATTEMPTS) {
        break;
      }
      core.warning(`Authenticated dynamic node did not become ready on attempt ${attempt}; recreating it once.`);
      await runner.run("docker", ["rm", "-f", config.dynamicContainer], { allowFailure: true, timeoutMs: 60_000 });
      await sleep(10000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function readGeneratedConfigPath(config: RuntimeConfig, runner: CommandRunner): Promise<string> {
  const result = await runner.run("docker", ["exec", config.staticContainer, "bash", "-lc", [
    ...generatedConfigDiscoveryLines("generated_config"),
    "printf '%s\\n' \"$generated_config\""
  ].join("\n")], { timeoutMs: 60_000 });
  return result.stdout.trim();
}

function generatedConfigDiscoveryLines(variableName: string): string[] {
  return [
    `${variableName}=`,
    "for candidate in /ydb_data/cluster/kikimr_configs/config.yaml /ydb_data/kikimr_configs/config.yaml; do",
    "  if [ -f \"$candidate\" ]; then",
    `    ${variableName}=$candidate`,
    "    break",
    "  fi",
    "done",
    `if [ -z "$${variableName}" ]; then`,
    "  matches=$(find /ydb_data -maxdepth 4 -type f -path '*/kikimr_configs/config.yaml' 2>/dev/null | sort)",
    "  match_count=$(printf '%s\\n' \"$matches\" | grep -c . || true)",
    "  case \"$match_count\" in",
    "    0) printf '%s\\n' 'local-ydb generated config.yaml was not found under /ydb_data' >&2; exit 1 ;;",
    `    1) ${variableName}=$matches ;;`,
    "    *) printf '%s\\n' 'multiple local-ydb generated config.yaml files found under /ydb_data:' >&2; printf '%s\\n' \"$matches\" >&2; exit 1 ;;",
    "  esac",
    "fi"
  ];
}

async function runYdbd(config: RuntimeConfig, runner: CommandRunner, args: string[], options: { allowFailure?: boolean } = {}) {
  return runner.run("docker", ["exec", config.staticContainer, "/ydbd", "--server", `localhost:${config.ports.staticGrpc}`, ...args], {
    allowFailure: options.allowFailure,
    timeoutMs: 120_000
  });
}

async function runYdb(config: RuntimeConfig, runner: CommandRunner, args: string[], options: { allowFailure?: boolean } = {}) {
  return runner.run("docker", ["exec", config.staticContainer, "/ydb", "-e", `grpc://localhost:${config.ports.dynamicGrpc}`, "-d", config.tenantPath, ...args], {
    allowFailure: options.allowFailure,
    timeoutMs: 120_000
  });
}

async function runYdbdWithPassword(config: RuntimeConfig, runner: CommandRunner, args: string[], options: { allowFailure?: boolean } = {}) {
  const password = await readPasswordFile(config);
  const innerCommand = `/ydbd --server localhost:${config.ports.staticGrpc} --user ${shellQuote(config.rootUser)} --password-file "$password_file" ${args.map(shellQuote).join(" ")}`;
  return runPasswordPipedDockerExec(config, runner, innerCommand, password, options.allowFailure);
}

async function runYdbWithPassword(config: RuntimeConfig, runner: CommandRunner, args: string[], options: { allowFailure?: boolean } = {}) {
  const password = await readPasswordFile(config);
  const innerCommand = `/ydb -e grpc://localhost:${config.ports.dynamicGrpc} -d ${shellQuote(config.tenantPath)} --user ${shellQuote(config.rootUser)} --password-file "$password_file" ${args.map(shellQuote).join(" ")}`;
  return runPasswordPipedDockerExec(config, runner, innerCommand, password, options.allowFailure);
}

async function runPasswordPipedDockerExec(
  config: RuntimeConfig,
  runner: CommandRunner,
  innerCommand: string,
  password: string,
  allowFailure?: boolean
) {
  const script = [
    "set -euo pipefail",
    "umask 077",
    "password_file=$(mktemp /tmp/setup-local-ydb-root-password-XXXXXX)",
    "trap 'rm -f \"$password_file\"' EXIT HUP INT TERM",
    "cat >\"$password_file\"",
    innerCommand
  ].join("\n");
  return runner.run("docker", ["exec", "-i", config.staticContainer, "bash", "-lc", script], {
    input: password,
    allowFailure,
    timeoutMs: 120_000,
    redactions: [password]
  });
}

async function verifyAnonymousCapabilities(config: RuntimeConfig): Promise<void> {
  const url = `${config.monitoringUrl}/viewer/json/capabilities?database=${encodeURIComponent(config.tenantPath)}`;
  const response = await fetch(url);
  if (!response.ok) {
    core.warning(`Viewer capabilities check returned HTTP ${response.status}`);
  }
}

async function verifyAnonymousViewerIsDenied(config: RuntimeConfig): Promise<void> {
  const response = await fetch(`${config.monitoringUrl}/viewer/json/whoami`);
  if (response.status !== 401) {
    throw new Error(`Expected anonymous viewer whoami to return 401 after auth hardening, got HTTP ${response.status}`);
  }
}

async function printDiagnosticCommand(runner: CommandRunner, command: string, args: string[]): Promise<void> {
  const result = await runner.run(command, args, { allowFailure: true, timeoutMs: 30_000 });
  core.info(`$ ${result.command}`);
  if (result.stdout.trim()) {
    core.info(result.stdout.trimEnd());
  }
  if (result.stderr.trim()) {
    core.info(result.stderr.trimEnd());
  }
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = parent[key];
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return current as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function extractRootPassword(securityConfig: Record<string, unknown>): string {
  const users = securityConfig.default_users;
  if (!Array.isArray(users)) {
    throw new Error("Generated local-ydb config does not contain security_config.default_users");
  }
  const root = users.find((user): user is Record<string, unknown> =>
    Boolean(user) && typeof user === "object" && !Array.isArray(user) && user.name === "root"
  );
  if (!root || typeof root.password !== "string" || root.password.length === 0) {
    throw new Error("Generated local-ydb config does not contain a non-empty root password");
  }
  return root.password;
}

async function readPasswordFile(config: RuntimeConfig): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return (await readFile(config.rootPasswordFile, "utf8")).replace(/\r?\n$/, "");
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function escapeTextProto(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function isRetryableYdbOutput(output: string): boolean {
  return /CLIENT_UNAUTHENTICATED|SCHEME_ERROR|No database found|Path not found|Path does not exist|connection refused|Endpoint list is empty|Could not resolve redirected path|Failed to connect|TRANSPORT_UNAVAILABLE|Status:\s*UNAVAILABLE|UNAUTHORIZED|Invalid password|Access denied/i.test(output);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
