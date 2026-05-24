import { DEFAULT_VERSION, IMAGE_REPOSITORY } from "./config";

export type FetchLike = typeof fetch;

export async function resolveLocalYdbVersion(versionInput: string, fetchImpl: FetchLike = fetch): Promise<string> {
  const version = normalizeVersionInput(versionInput);
  if (version !== "latest") {
    return version;
  }

  const tags = await fetchLocalYdbTags(fetchImpl);
  const numericTags = tags.filter((tag) => /^\d+(?:\.\d+)+$/.test(tag));
  numericTags.sort(compareNumericTagsDescending);
  const latest = numericTags[0];
  if (!latest) {
    throw new Error("Could not resolve latest local-ydb version from registry tags");
  }
  return latest;
}

export function normalizeVersionInput(versionInput: string): string {
  const trimmed = versionInput.trim() || DEFAULT_VERSION;
  const imagePrefix = `${IMAGE_REPOSITORY}:`;
  if (trimmed.startsWith(imagePrefix)) {
    return trimmed.slice(imagePrefix.length);
  }
  if (trimmed.includes("/") || trimmed.includes(":")) {
    throw new Error(`version must be a local-ydb tag, latest, or ${IMAGE_REPOSITORY}:<tag>`);
  }
  return trimmed;
}

export function compareNumericTagsDescending(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return right.localeCompare(left);
}

async function fetchLocalYdbTags(fetchImpl: FetchLike): Promise<string[]> {
  let url = "https://ghcr.io/v2/ydb-platform/local-ydb/tags/list?n=1000";
  const tags: string[] = [];
  let token: string | undefined;

  while (url) {
    let response = await fetchImpl(url, { headers: registryHeaders(token) });
    if (response.status === 401) {
      token = await fetchBearerToken(response, fetchImpl);
      response = await fetchImpl(url, { headers: registryHeaders(token) });
    }
    if (!response.ok) {
      throw new Error(`Failed to list local-ydb tags: HTTP ${response.status}`);
    }

    const body = await response.json() as { tags?: string[] };
    tags.push(...(body.tags ?? []));
    url = nextLink(response.headers.get("link"));
  }

  return tags;
}

function registryHeaders(token?: string): HeadersInit {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchBearerToken(response: Response, fetchImpl: FetchLike): Promise<string> {
  const challenge = response.headers.get("www-authenticate");
  if (!challenge) {
    throw new Error("Registry requires authentication but did not send a WWW-Authenticate challenge");
  }
  const params = parseBearerChallenge(challenge);
  const realm = params.get("realm");
  if (!realm) {
    throw new Error("Registry Bearer challenge did not include realm");
  }
  const tokenUrl = new URL(realm);
  for (const [name, value] of params.entries()) {
    if (name !== "realm") {
      tokenUrl.searchParams.set(name, value);
    }
  }
  const tokenResponse = await fetchImpl(tokenUrl);
  if (!tokenResponse.ok) {
    throw new Error(`Failed to obtain registry token: HTTP ${tokenResponse.status}`);
  }
  const tokenBody = await tokenResponse.json() as { token?: string; access_token?: string };
  const token = tokenBody.token ?? tokenBody.access_token;
  if (!token) {
    throw new Error("Registry token response did not include a token");
  }
  return token;
}

function parseBearerChallenge(challenge: string): Map<string, string> {
  const match = /^Bearer\s+(.+)$/i.exec(challenge.trim());
  if (!match) {
    throw new Error(`Unsupported registry authentication challenge: ${challenge}`);
  }
  const params = new Map<string, string>();
  for (const part of match[1].match(/(?:[^,"]|"[^"]*")+/g) ?? []) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    params.set(key, rawValue.replace(/^"|"$/g, ""));
  }
  return params;
}

function nextLink(linkHeader: string | null): string {
  if (!linkHeader) {
    return "";
  }
  for (const part of linkHeader.split(",")) {
    const match = /<([^>]+)>;\s*rel="?next"?/.exec(part.trim());
    if (match) {
      return match[1];
    }
  }
  return "";
}

