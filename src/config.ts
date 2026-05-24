import { join } from "node:path";
import { tmpdir } from "node:os";

export const IMAGE_REPOSITORY = "ghcr.io/ydb-platform/local-ydb";
export const DEFAULT_VERSION = "26.1.1.6";
export const DEFAULT_TENANT = "/local/test";
export const DEFAULT_ROOT_DATABASE = "/local";
export const ROOT_USER = "root";
export const DYNAMIC_NODE_AUTH_SID = "root@builtin";

export interface ActionInputs {
  version: string;
  tenant: string;
  auth: boolean;
  cleanup: boolean;
  staticGrpcPort?: number;
  dynamicGrpcPort?: number;
  monitoringPort?: number;
  containerPrefix: string;
}

export interface RuntimePorts {
  staticGrpc: number;
  dynamicGrpc: number;
  monitoring: number;
  dynamicMonitoring: number;
  dynamicIc: number;
}

export interface RuntimeConfig {
  tenantPath: string;
  rootDatabase: string;
  version: string;
  image: string;
  auth: boolean;
  cleanup: boolean;
  prefix: string;
  staticContainer: string;
  dynamicContainer: string;
  network: string;
  volume: string;
  ports: RuntimePorts;
  monitoringUrl: string;
  endpoint: string;
  staticEndpoint: string;
  authDir: string;
  authConfigPath: string;
  rootPasswordFile: string;
  dynamicNodeAuthTokenFile: string;
  rootUser: string;
  dynamicNodeAuthSid: string;
}

export type GetInput = (name: string, options?: { required?: boolean }) => string;

export function parseActionInputs(getInput: GetInput, env: NodeJS.ProcessEnv = process.env): ActionInputs {
  const version = getInput("version").trim() || DEFAULT_VERSION;
  const tenant = getInput("tenant").trim() || DEFAULT_TENANT;
  validateTenantPath(tenant);

  const auth = parseBooleanInput(getInput("auth"), "auth", false);
  const cleanup = parseBooleanInput(getInput("cleanup"), "cleanup", true);
  const staticGrpcPort = parseOptionalPort(getInput("static-grpc-port"), "static-grpc-port");
  const dynamicGrpcPort = parseOptionalPort(getInput("dynamic-grpc-port"), "dynamic-grpc-port");
  const monitoringPort = parseOptionalPort(getInput("monitoring-port"), "monitoring-port");
  const containerPrefixInput = getInput("container-prefix").trim();
  const containerPrefix = sanitizeDockerName(containerPrefixInput || defaultContainerPrefix(env));

  return {
    version,
    tenant,
    auth,
    cleanup,
    staticGrpcPort,
    dynamicGrpcPort,
    monitoringPort,
    containerPrefix
  };
}

export function buildRuntimeConfig(
  inputs: ActionInputs,
  ports: RuntimePorts,
  resolvedVersion: string,
  env: NodeJS.ProcessEnv = process.env
): RuntimeConfig {
  const duplicatePorts = findDuplicatePorts([ports.staticGrpc, ports.dynamicGrpc, ports.monitoring]);
  if (duplicatePorts.length > 0) {
    throw new Error(`Published host ports must be unique. Duplicate: ${duplicatePorts.join(", ")}`);
  }

  const prefix = sanitizeDockerName(inputs.containerPrefix);
  const authRoot = join(env.RUNNER_TEMP || tmpdir(), `${prefix}-auth`);

  return {
    tenantPath: inputs.tenant,
    rootDatabase: DEFAULT_ROOT_DATABASE,
    version: resolvedVersion,
    image: `${IMAGE_REPOSITORY}:${resolvedVersion}`,
    auth: inputs.auth,
    cleanup: inputs.cleanup,
    prefix,
    staticContainer: `${prefix}-static`,
    dynamicContainer: `${prefix}-dynamic`,
    network: `${prefix}-net`,
    volume: `${prefix}-data`,
    ports,
    monitoringUrl: `http://127.0.0.1:${ports.monitoring}`,
    endpoint: `grpc://127.0.0.1:${ports.dynamicGrpc}`,
    staticEndpoint: `grpc://127.0.0.1:${ports.staticGrpc}`,
    authDir: authRoot,
    authConfigPath: join(authRoot, "config.auth.yaml"),
    rootPasswordFile: join(authRoot, "root.password"),
    dynamicNodeAuthTokenFile: join(authRoot, "dynamic-node-auth.pb"),
    rootUser: ROOT_USER,
    dynamicNodeAuthSid: DYNAMIC_NODE_AUTH_SID
  };
}

export function validateTenantPath(tenant: string): void {
  if (!/^\/local\/[^/]+(?:\/[^/]+)*$/.test(tenant)) {
    throw new Error(`tenant must match /local/<name>; got ${tenant}`);
  }
}

export function parseBooleanInput(value: string, name: string, defaultValue: boolean): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`${name} must be a boolean value`);
}

export function parseOptionalPort(value: string, name: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${name} must be an integer port`);
  }
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be between 1 and 65535`);
  }
  return port;
}

export function sanitizeDockerName(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "")
    .slice(0, 72);
  if (!sanitized) {
    throw new Error("container-prefix must contain at least one alphanumeric character");
  }
  return sanitized;
}

function defaultContainerPrefix(env: NodeJS.ProcessEnv): string {
  const parts = [
    "setup-local-ydb",
    env.GITHUB_RUN_ID,
    env.GITHUB_RUN_ATTEMPT,
    env.GITHUB_JOB
  ].filter((part): part is string => Boolean(part));
  return parts.length > 1 ? parts.join("-") : `setup-local-ydb-${Date.now()}`;
}

function findDuplicatePorts(ports: number[]): number[] {
  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const port of ports) {
    if (seen.has(port)) {
      duplicates.add(port);
    }
    seen.add(port);
  }
  return [...duplicates];
}
