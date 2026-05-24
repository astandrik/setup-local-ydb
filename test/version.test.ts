import { describe, expect, it } from "vitest";
import { compareNumericTagsDescending, normalizeVersionInput, resolveLocalYdbVersion } from "../src/version";

describe("version", () => {
  it("normalizes exact tags and full image references", async () => {
    expect(normalizeVersionInput("26.1.1.6")).toBe("26.1.1.6");
    expect(normalizeVersionInput("ghcr.io/ydb-platform/local-ydb:26.1.1.6")).toBe("26.1.1.6");
    await expect(resolveLocalYdbVersion("custom/image:tag")).rejects.toThrow(/version must/);
  });

  it("sorts numeric tags descending", () => {
    const tags = ["25.3.1", "26.1.1.6", "26.1.2", "26.1.1.10"];
    expect(tags.sort(compareNumericTagsDescending)).toEqual(["26.1.2", "26.1.1.10", "26.1.1.6", "25.3.1"]);
  });

  it("resolves latest through a bearer-token registry challenge", async () => {
    const calls: string[] = [];
    const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      const headers = new Headers(init?.headers);
      if (url.includes("/tags/list") && !headers.has("authorization")) {
        return new Response("", {
          status: 401,
          headers: {
            "www-authenticate": 'Bearer realm="https://token.example.test",service="ghcr.io",scope="repository:ydb-platform/local-ydb:pull"'
          }
        });
      }
      if (url.startsWith("https://token.example.test")) {
        return Response.json({ token: "token" });
      }
      return Response.json({ tags: ["26.1.1.6", "26.1.1.10", "nightly"] });
    };

    await expect(resolveLocalYdbVersion("latest", fetchMock as typeof fetch)).resolves.toBe("26.1.1.10");
    expect(calls[0]).toContain("/tags/list");
    expect(calls[1]).toContain("token.example.test");
  });
});
