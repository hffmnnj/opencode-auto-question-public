import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import { createQuestionRoutes, type RouteDeps } from "../src/routes.ts";
import { storageKey, type StoragePort } from "../src/runtime.ts";
import { registerQuestionTools } from "../src/tools.ts";
import { registerQuestionAdvisory } from "../src/advisory.ts";

const deadline = 10_000;
const fields = [
  { key: "q0", type: "string", custom: true, title: "Pick one", description: "Choose", options: [{ value: "A", label: "A" }, { value: "B", label: "B" }] },
  { key: "q1", type: "multiselect", custom: true, title: "Pick many", options: [{ value: "X", label: "X" }, { value: "Y", label: "Y" }], minItems: 1, maxItems: 2 },
] as const;

function harness() {
  let now = 1_000;
  let detail: Record<string, unknown> = {
    id: "form", sessionID: "child", metadata: { kind: "question", tool: { id: "tool", messageID: "message" } },
    state: { status: "pending" }, fields,
  };
  const key = storageKey("child", "form");
  const records = new Map<string, Parameters<StoragePort["set"]>[1]>([[key, { sessionID: "child", formID: "form", deadline }]]);
  const sessions: Record<string, { id: string; parentID?: string }> = {
    root: { id: "root" }, parent: { id: "parent", parentID: "root" },
    child: { id: "child", parentID: "parent" }, sibling: { id: "sibling", parentID: "root" },
    stranger: { id: "stranger" },
  };
  const replies: unknown[] = [];
  const storage: StoragePort = {
    get: async (id) => records.get(id),
    set: async (id, value) => { records.set(id, value); },
    remove: async (id) => { records.delete(id); },
    scan: async ({ prefix }) => ({ entries: [...records].filter(([id]) => id.startsWith(prefix)).map(([id, value]) => ({ key: id, value })) }),
  };
  const deps: RouteDeps = {
    storage,
    clock: { now: () => now },
    session: async (id) => {
      const session = sessions[id];
      if (!session) throw new Error("missing session");
      return session;
    },
    forms: {
      get: async () => structuredClone(detail),
      reply: async (_sessionID, _formID, answer) => {
        if ((detail.state as { status: string }).status !== "pending") throw new Error("already settled");
        replies.push(answer);
        detail = { ...detail, state: { status: "answered" } };
      },
    },
  };
  return { deps, sessions, replies, records, key,
    setNow: (value: number) => { now = value; },
    setDetail: (value: Record<string, unknown>) => { detail = value; },
    detail: () => detail,
  };
}

describe("descendant question tools", () => {
  test("natural parent context receives only a generic advisory, not child text", async () => {
    const h = harness();
    type ContextEvent = { sessionID: string; system: Array<{ type: string; text: string }> };
    let hook!: (event: ContextEvent) => Promise<void>;
    const ctx = { session: { hook: async (name: string, callback: typeof hook) => {
      expect(name).toBe("context"); hook = callback;
    } } } as unknown as Plugin.Context;
    await registerQuestionAdvisory(ctx, createQuestionRoutes(h.deps));
    const parent: ContextEvent = { sessionID: "parent", system: [] };
    const sibling: ContextEvent = { sessionID: "sibling", system: [] };
    await hook(parent);
    await hook(sibling);
    await hook(parent);
    expect(parent.system).toHaveLength(1);
    expect(parent.system[0]!.text).toContain("tools.agent_question.list({})");
    expect(parent.system[0]!.text).toContain("untrusted task data");
    expect(parent.system[0]!.text).not.toContain("Pick one");
    expect(sibling.system).toEqual([]);
    h.records.delete(h.key);
    const settled: ContextEvent = { sessionID: "parent", system: [] };
    await hook(settled);
    expect(settled.system).toEqual([]);
  });

  test("unavailable ancestry cannot block the next model request indefinitely", async () => {
    const h = harness();
    type ContextEvent = { sessionID: string; system: Array<{ type: string; text: string }> };
    let hook!: (event: ContextEvent) => Promise<void>;
    const ctx = { session: { hook: async (_name: string, callback: typeof hook) => { hook = callback; } } } as unknown as Plugin.Context;
    await registerQuestionAdvisory(ctx, createQuestionRoutes({ ...h.deps, session: async () => new Promise<never>(() => undefined) }));
    const event: ContextEvent = { sessionID: "parent", system: [] };
    await hook(event);
    expect(event.system).toEqual([]);
  });

  test("Code Mode tool execution uses the invoking session identity", async () => {
    const h = harness();
    const registrations = new Map<string, {
      options: { namespace: string; codemode: boolean };
      execute(input: unknown, context: { sessionID: string; signal: AbortSignal }): Promise<{ output: unknown }>;
    }>();
    const ctx = { tool: { transform: async (transform: (editor: unknown) => void) => transform({
      namespace: () => undefined,
      add: (tool: { name: string }) => { registrations.set(tool.name, tool as never); },
    }) } } as unknown as Plugin.Context;
    await registerQuestionTools(ctx, createQuestionRoutes(h.deps));
    const list = registrations.get("list")!;
    const reply = registrations.get("reply")!;
    expect(list.options).toEqual({ namespace: "agent_question", codemode: true });
    expect(reply.options).toEqual({ namespace: "agent_question", codemode: true });
    const signal = new AbortController().signal;
    expect((await list.execute({}, { sessionID: "sibling", signal })).output).toEqual({ questions: [] });
    await expect(reply.execute({ sessionID: "child", formID: "form", answer: { q0: "A", q1: ["X"] } },
      { sessionID: "sibling", signal })).rejects.toThrow("Question unavailable");
    await reply.execute({ sessionID: "child", formID: "form", answer: { q0: "B", q1: ["Y"] } },
      { sessionID: "parent", signal });
    expect(h.replies).toEqual([{ q0: "B", q1: ["Y"] }]);
  });

  test("only true ancestors see and answer a pending child Question", async () => {
    const h = harness();
    const routes = createQuestionRoutes(h.deps);
    const listed = await routes.list("parent");
    expect(listed).toEqual([{ sessionID: "child", formID: "form", deadline, fields }]);
    expect(await routes.list("root")).toEqual(listed);
    expect(await routes.list("sibling")).toEqual([]);
    expect(await routes.list("stranger")).toEqual([]);
    expect(await routes.list("child")).toEqual([]);
    await expect(routes.reply("sibling", "child", "form", { q0: "A", q1: ["X"] })).rejects.toThrow("Question unavailable");
    await routes.reply("parent", "child", "form", { q0: "B", q1: ["X", "Y"] });
    expect(h.replies).toEqual([{ q0: "B", q1: ["X", "Y"] }]);
    expect(await routes.list("parent")).toEqual([]);
    await expect(routes.reply("root", "child", "form", { q0: "A", q1: ["X"] })).rejects.toThrow("Question unavailable");
  });

  test("rejects malformed answers while allowing native custom answers", async () => {
    const h = harness();
    const routes = createQuestionRoutes(h.deps);
    for (const answer of [
      { q0: ["A"], q1: ["X"] }, { q0: "A", q1: "X" }, { q0: "A", q1: [] },
      { q0: "A", q1: ["X", "X"] }, { q0: "A", q1: ["X", "Y", "Z"] },
      { q0: "A" }, { q0: "A", q1: ["X"], extra: "Z" }, { q0: " ", q1: ["X"] },
    ]) await expect(routes.reply("parent", "child", "form", answer)).rejects.toThrow("Invalid question answer");
    expect(h.replies).toEqual([]);
    await routes.reply("parent", "child", "form", { q0: "Other custom choice", q1: ["Custom answer"] });
    expect(h.replies).toEqual([{ q0: "Other custom choice", q1: ["Custom answer"] }]);
  });

  test("permission forms, expired registrations, and cyclic ancestry fail closed", async () => {
    const h = harness();
    const routes = createQuestionRoutes(h.deps);
    h.setDetail({ ...h.detail(), metadata: { kind: "permission", tool: { id: "tool", messageID: "message" } } });
    expect(await routes.list("parent")).toEqual([]);
    await expect(routes.reply("parent", "child", "form", { q0: "A", q1: ["X"] })).rejects.toThrow("Question unavailable");
    h.setDetail({ ...h.detail(), metadata: { kind: "question", tool: { id: "tool", messageID: "message" } } });
    h.sessions.root!.parentID = "parent";
    expect(await routes.list("parent")).toEqual([]);
    delete h.sessions.root!.parentID;
    h.setNow(deadline);
    expect(await routes.list("parent")).toEqual([]);
    await expect(routes.reply("parent", "child", "form", { q0: "A", q1: ["X"] })).rejects.toThrow("Question unavailable");
    expect(h.replies).toEqual([]);
  });

  test("concurrent replies reserve before awaits and cancellation prevents late submission", async () => {
    const h = harness();
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const original = h.deps.forms.get;
    const routes = createQuestionRoutes({ ...h.deps, forms: { ...h.deps.forms, get: async (...args) => {
      entered.resolve(); await gate.promise; return original(...args);
    } } });
    const signal = new AbortController();
    const first = routes.reply("parent", "child", "form", { q0: "A", q1: ["X"] }, signal.signal);
    await entered.promise;
    await expect(routes.reply("parent", "child", "form", { q0: "B", q1: ["Y"] })).rejects.toThrow("already in progress");
    signal.abort();
    gate.resolve();
    await expect(first).rejects.toThrow();
    expect(h.replies).toEqual([]);
    await routes.reply("parent", "child", "form", { q0: "B", q1: ["Y"] });
    expect(h.replies).toEqual([{ q0: "B", q1: ["Y"] }]);
  });

  test("a cancellation or deadline during a form read prevents a late reply", async () => {
    for (const cancel of [true, false]) {
      const h = harness();
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const original = h.deps.forms.get;
      const routes = createQuestionRoutes({ ...h.deps, forms: { ...h.deps.forms, get: async (...args) => {
        entered.resolve(); await gate.promise; return original(...args);
      } } });
      const reply = routes.reply("parent", "child", "form", { q0: "A", q1: ["X"] });
      await entered.promise;
      if (cancel) h.records.delete(h.key); else h.setNow(deadline);
      gate.resolve();
      await expect(reply).rejects.toThrow("Question unavailable");
      expect(h.replies).toEqual([]);
    }
  });
});
