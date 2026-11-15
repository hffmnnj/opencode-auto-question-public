import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import { QUESTION_REMINDER, registerQuestionAdvisory } from "../src/advisory.ts";

type ContextEvent = {
  sessionID: string;
  system: Array<{ type: "text"; text: string }>;
  messages: unknown[];
  tools: Record<string, { description: string }>;
};

const existingSystem = [{ type: "text" as const, text: "Existing system prefix." }];
const existingMessages = [{ role: "user", content: "Existing message." }];
const existingTools = { bash: { description: "Run a command." } };

function freshContext(sessionID: string): ContextEvent {
  return {
    sessionID,
    system: structuredClone(existingSystem),
    messages: structuredClone(existingMessages),
    tools: structuredClone(existingTools),
  };
}

describe("question context reminder", () => {
  test("every context build gets one constant reminder without pending-state I/O", async () => {
    let hook!: (event: ContextEvent) => Promise<void> | void;
    let pendingLookups = 0;
    const ctx = {
      session: {
        hook: async (name: string, callback: typeof hook) => {
          expect(name).toBe("context");
          hook = callback;
        },
        // Any pending-state dependency would reach for a session read here.
        get: async () => {
          pendingLookups++;
          throw new Error("pending-state lookup is not allowed in the context path");
        },
      },
    } as unknown as Plugin.Context;
    await registerQuestionAdvisory(ctx);

    const first = freshContext("parent");
    const firstMessages = first.messages;
    const firstTools = first.tools;
    const firstPrefix = first.system[0]!;
    expect(hook(first)).toBeUndefined();
    expect(first.system).toEqual([...existingSystem, { type: "text", text: QUESTION_REMINDER }]);
    expect(first.system[0]).toBe(firstPrefix);
    expect(first.messages).toBe(firstMessages);
    expect(first.tools).toBe(firstTools);

    // Re-running the hook on one draft must not append a duplicate reminder.
    hook(first);
    expect(first.system).toHaveLength(existingSystem.length + 1);

    // Fresh builds stay byte-identical and untouched, with no question state consulted.
    const builds = [freshContext("sibling"), freshContext("root")];
    for (const build of builds) {
      const messages = build.messages;
      const tools = build.tools;
      hook(build);
      expect(build.system).toEqual(first.system);
      expect(JSON.stringify(build.system)).toBe(JSON.stringify(first.system));
      expect(build.messages).toBe(messages);
      expect(build.messages).toEqual(existingMessages);
      expect(build.tools).toBe(tools);
      expect(build.tools).toEqual(existingTools);
    }
    expect(pendingLookups).toBe(0);
  });
});
