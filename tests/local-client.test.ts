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

describe("explicit current server", () => {
  const env = { OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password };
  const target = "http://127.0.0.1:4108";
  // Route the pinned address to a disposable service; never connect to the live host.
  const transport = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    expect(url.origin).toBe(target);
    url.port = String(server.port);
    return fetch(new Request(url, request));
  }, { preconnect: fetch.preconnect });
  const options = { useCurrentServer: true, env, transport };

  test("authenticates the fixed endpoint and returns a client only after identity verification", async () => {
    requests.length = 0;
    const client = await createLocalClient(version, process.pid, AbortSignal.timeout(5_000), options);
    expect(requests).toEqual([{ path: "/api/info", authorization }]);
    expect((await client.server.info()).pid).toBe(process.pid);
    expect(requests).toEqual([
      { path: "/api/info", authorization },
      { path: "/api/info", authorization },
    ]);
  });

  test("refuses absent credentials and colon-containing usernames before any request", async () => {
    requests.length = 0;
    for (const credentials of [
      {},
      { OPENCODE_SERVER_USERNAME: "opencode" },
      { OPENCODE_SERVER_PASSWORD: password },
      { OPENCODE_SERVER_USERNAME: "bad:name", OPENCODE_SERVER_PASSWORD: password },
    ]) {
      await expect(createLocalClient(version, process.pid, AbortSignal.timeout(5_000), { ...options, env: credentials }))
        .rejects.toThrow("authentication is required");
    }
    expect(requests).toEqual([]);
  });

  test("rejects a different server process or exact version before returning a client", async () => {
    requests.length = 0;
    await expect(createLocalClient(version, process.pid + 1, AbortSignal.timeout(5_000), options))
      .rejects.toThrow("refuses to answer forms on another OpenCode server");
    await expect(createLocalClient("2.0.33", process.pid, AbortSignal.timeout(5_000), options))
      .rejects.toThrow("refuses to answer forms on another OpenCode server");
    expect(requests).toEqual([
      { path: "/api/info", authorization },
      { path: "/api/info", authorization },
    ]);
  });

  test("does not follow a redirect during identity verification", async () => {
    requests.length = 0;
    redirect = true;
    try {
      await expect(createLocalClient(version, process.pid, AbortSignal.timeout(5_000), options)).rejects.toThrow();
      expect(requests).toEqual([{ path: "/api/info", authorization }]);
    } finally {
      redirect = false;
    }
  });

  test("aborts identity verification when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    requests.length = 0;
    await expect(createLocalClient(version, process.pid, controller.signal, options)).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  test("pins every request to the fixed origin and refuses URL credentials and redirects", async () => {
    const calls: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
    const capture = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: input.toString(), redirect: init?.redirect });
      return new Response();
    }, { preconnect: fetch.preconnect });
    const safe = makeLocalFetch(capture, target);
    await safe(`${target}/api/info`, { redirect: "follow" });
    for (const url of [
      "http://127.0.0.1:4109/api/info", "http://localhost:4108/api/info", "http://127.0.0.2:4108/api/info",
      "http://127.1:4108/api/info", "http://127.0.0.1:04108/api/info",
      "https://127.0.0.1:4108/api/info", "http://user:pass@127.0.0.1:4108/api/info",
      "http://example.com:4108/api/info", "http://127.0.0.1:4108.example.com/api/info",
    ]) expect(() => safe(url)).toThrow();
    expect(calls).toEqual([{ url: `${target}/api/info`, redirect: "error" }]);
  });

  test("built plugin honors the opt-in and rejects a URL in place of the boolean", async () => {
    const script = `
      import plugin from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "../dist/index.js")).href)};
      const seen = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(async (input, init) => {
        const request = new Request(input, init);
        seen.push({ url: request.url, authorization: request.headers.get("authorization"), redirect: init?.redirect });
        return Response.json({ pid: process.pid, version: "2.2.1" });
      }, { preconnect: originalFetch.preconnect });
      const ctx = {
        app: { version: "2.2.1" }, options: { useCurrentServer: true }, location: { directory: "/test" },
        storage: { scan: async () => ({ entries: [] }) },
        event: { subscribe: async function* () {} },
        session: { get: async () => undefined, hook: async () => {} },
        tool: { transform: async (edit) => edit({ namespace: () => {}, add: () => {} }) },
      };
      const cleanup = await plugin.setup(ctx);
      cleanup();
      let invalidRejected = false;
      try { await plugin.setup({ ...ctx, options: { useCurrentServer: "http://other.example" } }); }
      catch (error) { invalidRejected = error.message === "useCurrentServer must be a boolean."; }
      console.log(JSON.stringify({ seen, invalidRejected }));
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], {
      env: { OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({
      seen: [{ url: `${target}/api/info`, authorization, redirect: "error" }],
      invalidRejected: true,
    });
  });
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
    const client = await createLocalClient("2.0.32", process.pid, AbortSignal.timeout(5_000), { file });
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
    await expect(createLocalClient("2.0.32", process.pid + 1, AbortSignal.timeout(5_000), { file })).rejects.toThrow();
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
      await expect(createLocalClient(version, process.pid, AbortSignal.timeout(5_000), { file })).rejects.toThrow("authentication is required");
    } finally {
      requireAuth = true;
    }
    await register();
    const client = await createLocalClient(version, process.pid, AbortSignal.timeout(5_000), { file });
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
