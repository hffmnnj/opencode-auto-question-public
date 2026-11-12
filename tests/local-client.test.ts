import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createLocalClient, discoverLocalService } from "../src/local-client.ts";
import { makeLocalFetch } from "../src/local-fetch.ts";

const dir = await mkdtemp(join(tmpdir(), "auto-question-test-"));
const file = join(dir, "service.json");
const password = "test-password";
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
let pid = process.pid;
let version = "2.0.32";
let redirect = false;
let requireAuth = true;
const requests: Array<{ path: string; authorization: string | null }> = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request): Response {
    requests.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization") });
    if (redirect) return Response.redirect(`http://127.0.0.1:${server.port}/redirect-target`, 302);
    if (requireAuth && request.headers.get("authorization") !== authorization) return new Response("unauthorized", { status: 401 });
    return Response.json({ pid, version });
  },
});
afterAll(async () => {
  server.stop(true);
  await rm(file, { force: true });
  await rm(join(dir, "state", "opencode", "service.json"), { force: true });
  for (const directory of [join(dir, "state", "opencode"), join(dir, "state"), dir]) {
    await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
});

async function register(url = `http://127.0.0.1:${server.port}`, registrationPid = process.pid) {
  await writeFile(file, JSON.stringify({ url, pid: registrationPid, version: "2.0.32", password }));
}

describe("managed service discovery", () => {
  test("uses the dynamic registration and authentication without changing host fetch", async () => {
    await register();
    const original = globalThis.fetch;
    requests.length = 0;
    const client = await createLocalClient("2.0.32", process.pid, AbortSignal.timeout(5_000), file);
    expect(globalThis.fetch).toBe(original);
    expect((await client.server.info()).pid).toBe(process.pid);
    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(requests.every((request) => request.path === "/api/info" && request.authorization === authorization)).toBe(true);
  });

  test("fails cleanly when registration is missing or invalid", async () => {
    await expect(discoverLocalService("2.0.32", join(dir, "missing.json"))).rejects.toThrow();
    await writeFile(file, "not-json");
    await expect(discoverLocalService("2.0.32", file)).rejects.toThrow();
  });

  test("rejects mismatched version and a different hosting process", async () => {
    await register();
    await expect(discoverLocalService("2.0.33", file)).rejects.toThrow();
    await expect(createLocalClient("2.0.32", process.pid + 1, AbortSignal.timeout(5_000), file)).rejects.toThrow();
    pid = process.pid + 1;
    try {
      await expect(discoverLocalService("2.0.32", file)).rejects.toThrow();
    } finally {
      pid = process.pid;
    }
    version = "2.0.33";
    try {
      await expect(discoverLocalService("2.0.32", file)).rejects.toThrow();
    } finally {
      version = "2.0.32";
    }
  });

  test("rejects non-loopback registrations and redirects during discovery", async () => {
    await register("http://example.com:1234");
    await expect(discoverLocalService("2.0.32", file)).rejects.toThrow();
    await register();
    requests.length = 0;
    redirect = true;
    try {
      await expect(discoverLocalService("2.0.32", file)).rejects.toThrow();
      expect(requests.map((request) => request.path)).toEqual(["/api/info"]);
    } finally {
      redirect = false;
    }
  });

  test("requires registered authentication and refuses redirects after discovery", async () => {
    await writeFile(file, JSON.stringify({ url: `http://127.0.0.1:${server.port}`, pid: process.pid, version }));
    requireAuth = false;
    try {
      await expect(createLocalClient(version, process.pid, AbortSignal.timeout(5_000), file)).rejects.toThrow("authentication is required");
    } finally {
      requireAuth = true;
    }
    await register();
    const client = await createLocalClient(version, process.pid, AbortSignal.timeout(5_000), file);
    requests.length = 0;
    redirect = true;
    try {
      await expect(client.server.info()).rejects.toThrow();
      expect(requests.map((request) => request.path)).toEqual(["/api/info"]);
    } finally {
      redirect = false;
    }
  });

  test("built plugin resolves its worker and initializes from a registration", async () => {
    const state = join(dir, "state");
    await mkdir(join(state, "opencode"), { recursive: true });
    await writeFile(join(state, "opencode", "service.json"), JSON.stringify({
      url: `http://127.0.0.1:${server.port}`, pid: process.pid, version, password,
    }));
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = state;
    try {
      const path = pathToFileURL(join(import.meta.dir, "../dist/index.js")).href;
      const plugin = (await import(path)).default;
      const namespaces: string[] = [];
      const tools: Array<{ name: string; options: { namespace: string; codemode: boolean } }> = [];
      const hooks: string[] = [];
      requests.length = 0;
      const cleanup = await plugin.setup({
        app: { version }, location: { directory: "/test" },
        storage: { scan: async () => ({ entries: [] }) },
        event: { subscribe: async function* () {} },
        session: { get: async () => undefined, hook: async (name: string) => { hooks.push(name); } },
        tool: { transform: async (edit: (editor: {
          namespace: (value: { name: string }) => void;
          add: (value: { name: string; options: { namespace: string; codemode: boolean } }) => void;
        }) => void) => edit({
          namespace: ({ name }) => { namespaces.push(name); },
          add: (tool) => { tools.push(tool); },
        }) },
      });
      expect(typeof cleanup).toBe("function");
      expect(namespaces).toEqual(["agent_question"]);
      expect(tools.map(({ name, options }) => ({ name, options }))).toEqual([
        { name: "list", options: { namespace: "agent_question", codemode: true } },
        { name: "reply", options: { namespace: "agent_question", codemode: true } },
      ]);
      expect(hooks).toEqual(["context"]);
      expect(requests.length).toBeGreaterThanOrEqual(2);
      expect(requests.every((request) => request.path === "/api/info" && request.authorization === authorization)).toBe(true);
      cleanup();
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
    }
  });

  test("guards every API request and overrides redirect options", async () => {
    const calls: Array<RequestInit | undefined> = [];
    const transport = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init);
      return new Response();
    }, { preconnect: fetch.preconnect });
    const safe = makeLocalFetch(transport);
    await safe("http://127.0.0.1:4321/api/info", { redirect: "follow" });
    expect(calls[0]?.redirect).toBe("error");
    for (const url of ["http://example.com/", "http://localhost/", "http://user:pass@127.0.0.1/", "file:///tmp/x"]) {
      expect(() => safe(url)).toThrow();
    }
    expect(calls).toHaveLength(1);
  });
});
