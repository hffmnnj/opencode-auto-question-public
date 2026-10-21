import { describe, expect, test } from "bun:test";
import type { StorageScanOptions, StorageScanResult } from "@opencode/plugin";
import {
  AUTO_ANSWER_DELAY_MS,
  AUTO_ANSWER_TEXT,
  startAutoQuestion,
  type AutoQuestionDeps,
  type FormsPort,
  type StoragePort,
} from "../src/runtime.ts";

const DIRECTORY = "/work/project";
const WORKSPACE = "ws-1";
const START = 1_000_000;

type StoredValue = Parameters<StoragePort["set"]>[1];

async function flush(rounds = 40): Promise<void> {
  for (let round = 0; round < rounds; round += 1) await Promise.resolve();
}

function createClock() {
  let now = START;
  return {
    now: () => now,
    set: (value: number) => {
      now = value;
    },
  };
}

function createScheduler(clock: { now(): number; set(value: number): void }) {
  const timers = new Map<number, { at: number; callback: () => void }>();
  let nextID = 1;
  const scheduler = {
    schedule: (delayMs: number, callback: () => void) => {
      const id = nextID;
      nextID += 1;
      timers.set(id, { at: clock.now() + delayMs, callback });
      return () => {
        timers.delete(id);
      };
    },
    pending: () => timers.size,
    advance: async (ms: number) => {
      const target = clock.now() + ms;
      for (;;) {
        let next: { id: number; at: number; callback: () => void } | undefined;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (next === undefined || timer.at < next.at)) {
            next = { id, at: timer.at, callback: timer.callback };
          }
        }
        if (next === undefined) break;
        timers.delete(next.id);
        clock.set(next.at);
        next.callback();
        await flush();
      }
      clock.set(target);
      await flush();
    },
  };
  return scheduler;
}

class FakeStorage {
  private store = new Map<string, StoredValue>();
  constructor(private readonly defaultLimit?: number) {}

  get port(): StoragePort {
    return {
      get: async (key) => this.store.get(key),
      set: async (key, value) => {
        this.store.set(key, value);
      },
      remove: async (key) => {
        this.store.delete(key);
      },
      scan: async (options: StorageScanOptions): Promise<StorageScanResult> => {
        const keys = [...this.store.keys()]
          .filter((key) => key.startsWith(options.prefix))
          .sort();
        let start = 0;
        if (options.after !== undefined) {
          const after: string = options.after;
          const index = keys.findIndex((key) => key > after);
          start = index === -1 ? keys.length : index;
        }
        const limit = options.limit ?? this.defaultLimit ?? keys.length;
        const slice = keys.slice(start, start + limit);
        const entries: Array<{ key: string; value: StoredValue }> = [];
        for (const key of slice) {
          const value = this.store.get(key);
          if (value !== undefined) entries.push({ key, value });
        }
        const exhausted = start + slice.length >= keys.length;
        const last = slice.length === 0 ? undefined : slice[slice.length - 1];
        return last === undefined || exhausted
          ? { entries }
          : { entries, next: last };
      },
    };
  }

  keys(): Array<string> {
    return [...this.store.keys()].sort();
  }
}

interface RecordedReply {
  readonly sessionID: string;
  readonly formID: string;
  readonly answer: Record<string, string | ReadonlyArray<string>>;
}

function pendingDetail(fields: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: "f1",
    sessionID: "s1",
    title: "Questions",
    metadata: { kind: "question", tool: { messageID: "m1", id: "t1" } },
    fields,
    state: { status: "pending" },
  };
}

class FakeForms {
  replies: Array<RecordedReply> = [];
  getCalls = 0;
  replyCalls = 0;
  getImpl: (sessionID: string, formID: string) => Promise<unknown> = async () =>
    pendingDetail([{ key: "q0", type: "string", custom: true }]);
  replyImpl: (reply: RecordedReply) => Promise<void> = async (reply) => {
    this.replies.push(reply);
  };

  get port(): FormsPort {
    return {
      get: async (sessionID, formID) => {
        this.getCalls += 1;
        return this.getImpl(sessionID, formID);
      },
      reply: async (sessionID, formID, answer) => {
        this.replyCalls += 1;
        return this.replyImpl({ sessionID, formID, answer });
      },
    };
  }
}

function createSessions(directories: Map<string, string>, failures = new Set<string>()) {
  return {
    locationOf: async (sessionID: string) => {
      if (failures.has(sessionID)) throw new Error("session gone");
      const directory = directories.get(sessionID);
      return directory === undefined ? undefined : { directory, workspaceID: WORKSPACE };
    },
  };
}

async function* emptyEvents(): AsyncIterable<unknown> {
  for (;;) await new Promise<never>(() => undefined);
}

const QUESTION_METADATA: Record<string, unknown> = {
  kind: "question",
  tool: { messageID: "m1", id: "t1" },
};

function stringField(key = "q0"): Record<string, unknown> {
  return {
    key,
    title: "Pick",
    description: "Pick one",
    type: "string",
    options: [{ value: "A", label: "A" }],
    custom: true,
  };
}

function multiField(key = "q1"): Record<string, unknown> {
  return {
    key,
    title: "Pick many",
    description: "Pick any",
    type: "multiselect",
    options: [
      { value: "A", label: "A" },
      { value: "B", label: "B" },
    ],
    custom: true,
  };
}

function createdEvent(overrides: {
  sessionID?: string;
  formID?: string;
  created?: number;
  location?: Record<string, unknown> | null;
  metadata?: unknown;
  fields?: unknown;
} = {}): Record<string, unknown> {
  const location =
    overrides.location === undefined
      ? { directory: DIRECTORY, workspaceID: WORKSPACE }
      : overrides.location;
  return {
    id: "e1",
    created: overrides.created ?? START,
    type: "form.created",
    ...(location === null ? {} : { location }),
    data: {
      form: {
        id: overrides.formID ?? "f1",
        sessionID: overrides.sessionID ?? "s1",
        title: "Questions",
        metadata: overrides.metadata ?? QUESTION_METADATA,
        fields: overrides.fields ?? [stringField()],
      },
    },
  };
}

function repliedEvent(sessionID = "s1", formID = "f1"): Record<string, unknown> {
  return {
    id: "e2",
    created: START + 10,
    type: "form.replied",
    location: { directory: DIRECTORY, workspaceID: WORKSPACE },
    data: { id: formID, sessionID, answer: { q0: "A" } },
  };
}

function cancelledEvent(sessionID = "s1", formID = "f1"): Record<string, unknown> {
  return {
    id: "e3",
    created: START + 10,
    type: "form.cancelled",
    location: { directory: DIRECTORY, workspaceID: WORKSPACE },
    data: { id: formID, sessionID },
  };
}

function sessionDeletedEvent(sessionID = "s1"): Record<string, unknown> {
  return {
    id: "e4",
    created: START + 10,
    type: "session.deleted",
    location: { directory: DIRECTORY, workspaceID: WORKSPACE },
    data: { sessionID },
  };
}

interface Harness {
  readonly deps: (extra?: Partial<AutoQuestionDeps>) => AutoQuestionDeps;
  readonly clock: { now(): number; set(value: number): void };
  readonly scheduler: ReturnType<typeof createScheduler>;
  readonly storage: FakeStorage;
  readonly forms: FakeForms;
}

function createHarness(storage?: FakeStorage): Harness {
  const clock = createClock();
  const scheduler = createScheduler(clock);
  const store = storage ?? new FakeStorage();
  const forms = new FakeForms();
  const sessions = createSessions(
    new Map([["s1", DIRECTORY], ["s2", DIRECTORY]]),
  );
  const deps = (extra?: Partial<AutoQuestionDeps>): AutoQuestionDeps => ({
    directory: DIRECTORY,
    workspaceID: WORKSPACE,
    clock,
    scheduler,
    storage: store.port,
    events: emptyEvents(),
    forms: forms.port,
    sessions,
    ...extra,
  });
  return { deps, clock, scheduler, storage: store, forms };
}

describe("auto-question deadlines", () => {
  test("no reply before 750000ms and exactly one reply at the boundary", async () => {
    const harness = createHarness();
    const runtime = startAutoQuestion(harness.deps());
    try {
      await runtime.handleEvent(createdEvent());
      await harness.scheduler.advance(749_999);
      expect(harness.forms.replies).toEqual([]);
      await harness.scheduler.advance(1);
      expect(harness.forms.replies).toEqual([{
        sessionID: "s1", formID: "f1", answer: {
          q0: "Please proceed with your best discretion on the recommended option. Choose whatever is the smartest and high-quality choice in the long term.",
        },
      }]);
      expect(harness.storage.keys()).toEqual([]);
    } finally {
      runtime.dispose();
    }
  });

  test("multiple fields use per-type answer shape", async () => {
    const harness = createHarness();
    harness.forms.getImpl = async () =>
      pendingDetail([stringField("q0"), multiField("q1")]);
    const runtime = startAutoQuestion(harness.deps());
    try {
      await runtime.handleEvent(createdEvent({ fields: [stringField("q0"), multiField("q1")] }));
      await harness.scheduler.advance(AUTO_ANSWER_DELAY_MS);
      expect(harness.forms.replies).toEqual([
        {
          sessionID: "s1",
          formID: "f1",
          answer: { q0: AUTO_ANSWER_TEXT, q1: [AUTO_ANSWER_TEXT] },
        },
      ]);
    } finally {
      runtime.dispose();
    }
  });

  test("each tracked form keeps an independent deadline", async () => {
    const harness = createHarness();
    const runtime = startAutoQuestion(harness.deps());
    try {
      await runtime.handleEvent(createdEvent({ formID: "f1", created: START }));
      await runtime.handleEvent(createdEvent({ formID: "f2", created: START + 1_000 }));
      await harness.scheduler.advance(AUTO_ANSWER_DELAY_MS);
      expect(harness.forms.replies.map((reply) => reply.formID)).toEqual(["f1"]);
      await harness.scheduler.advance(1_000);
      expect(harness.forms.replies.map((reply) => reply.formID)).toEqual(["f1", "f2"]);
    } finally {
      runtime.dispose();
    }
  });

  test("duplicate creation events never reset the deadline or duplicate replies", async () => {
    const harness = createHarness();
    const runtime = startAutoQuestion(harness.deps());
    try {
      await runtime.handleEvent(createdEvent({ created: START }));
      await harness.scheduler.advance(100_000);
      await runtime.handleEvent(createdEvent({ created: START + 100_000 }));
      await harness.scheduler.advance(AUTO_ANSWER_DELAY_MS - 100_000);
      expect(harness.forms.replies).toHaveLength(1);
      await harness.scheduler.advance(500_000);
      expect(harness.forms.replies).toHaveLength(1);
    } finally {
      runtime.dispose();
    }
  });
});

describe("manual settlement", () => {
  test("a user reply before the deadline prevents the auto answer", async () => {
    const harness = createHarness();
    const runtime = startAutoQuestion(harness.deps());
    try {
      await runtime.handleEvent(createdEvent());
      expect(harness.storage.keys()).toHaveLength(1);
      await runtime.handleEvent(repliedEvent());
      expect(harness.storage.keys()).toEqual([]);
      await harness.scheduler.advance(AUTO_ANSWER_DELAY_MS * 2);
      expect(harness.forms.replies).toEqual([]);
    } finally {
      runtime.dispose();
    }
  });

  test("cancellation before the deadline prevents the auto answer", async () => {
    const harness = createHarness();
    const runtime = startAutoQuestion(harness.deps());
    try {
      await runtime.handleEvent(createdEvent());
      await runtime.handleEvent(cancelledEvent());
      await harness.scheduler.advance(AUTO_ANSWER_DELAY_MS * 2);
      expect(harness.forms.replies).toEqual([]);
      expect(harness.storage.keys()).toEqual([]);
    } finally {
      runtime.dispose();
    }
  });

  test("session deletion clears every tracked form of that session", async () => {
    const harness = createHarness();
    const runtime = startAutoQuestion(harness.deps());
    try {
      await runtime.handleEvent(createdEvent({ formID: "f1" }));
      await runtime.handleEvent(createdEvent({ formID: "f2" }));
      await runtime.handleEvent(createdEvent({ sessionID: "s2", formID: "f9" }));
      await runtime.handleEvent(sessionDeletedEvent("s1"));
      await harness.scheduler.advance(AUTO_ANSWER_DELAY_MS * 2);
      expect(harness.forms.replies.map((reply) => reply.formID)).toEqual(["f9"]);
    } finally {
      runtime.dispose();
    }
  });
});

describe("scope and shape filtering", () => {
  test("non-Question and malformed forms are ignored", async () => {
    const cases: Array<{ name: string; metadata?: unknown; fields?: unknown }> = [
      { name: "permission kind", metadata: { kind: "permission" }, fields: [stringField()] },
      { name: "missing tool reference", metadata: { kind: "question" }, fields: [stringField()] },
      { name: "boolean field", metadata: QUESTION_METADATA, fields: [{ key: "q0", type: "boolean" }] },
      {
        name: "non-custom string",
        metadata: QUESTION_METADATA,
        fields: [{ key: "q0", type: "string", options: [] }],
      },
      {
        name: "non-custom multiselect",
        metadata: QUESTION_METADATA,
        fields: [{ key: "q0", type: "multiselect", options: [] }],
      },
      { name: "empty fields", metadata: QUESTION_METADATA, fields: [] },
    ];
    for (const kase of cases) {
      const harness = createHarness();
      const runtime = startAutoQuestion(harness.deps());
      try {
        await runtime.handleEvent(createdEvent({ metadata: kase.metadata, fields: kase.fields }));
        await harness.scheduler.advance(AUTO_ANSWER_DELAY_MS + 1);
        expect(harness.forms.replies).toEqual([]);
        expect(harness.storage.keys()).toEqual([]);
      } finally {
        runtime.dispose();
      }
    }
  });

  test("foreign locations are ignored", async () => {
    const harness = createHarness();
    const runtime = startAutoQuestion(harness.deps());
    try {
      await runtime.handleEvent(
        createdEvent({ location: { directory: "/elsewhere", workspaceID: WORKSPACE } }),
      );
      await runtime.handleEvent(
        createdEvent({ location: { directory: DIRECTORY, workspaceID: "ws-other" } }),
      );
      await harness.scheduler.advance(AUTO_ANSWER_DELAY_MS + 1);
      expect(harness.forms.replies).toEqual([]);
      expect(harness.storage.keys()).toEqual([]);
    } finally {
      runtime.dispose();
    }
  });

  test("events without a location are verified through the session", async () => {
    const sessions = createSessions(new Map([["s1", DIRECTORY], ["s2", "/elsewhere"]]));
    const failures = createSessions(new Map(), new Set(["s9"]));
    const harness = createHarness();
    const runtime = startAutoQuestion(harness.deps({ sessions }));
    try {
      await runtime.handleEvent(createdEvent({ location: null, sessionID: "s1" }));
      await runtime.handleEvent(createdEvent({ location: null, sessionID: "s2", formID: "f2" }));
      await harness.scheduler.advance(AUTO_ANSWER_DELAY_MS);
      expect(harness.forms.replies.map((reply) => reply.formID)).toEqual(["f1"]);
    } finally {
      runtime.dispose();
    }
    const failing = createHarness();
    const failingRuntime = startAutoQuestion(failing.deps({ sessions: failures }));
    try {
      await failingRuntime.handleEvent(createdEvent({ location: null, sessionID: "s9" }));
      await failing.scheduler.advance(AUTO_ANSWER_DELAY_MS + 1);
      expect(failing.forms.replies).toEqual([]);
      expect(failing.storage.keys()).toEqual([]);
    } finally {
      failingRuntime.dispose();
    }
  });
});

describe("pending-state recheck", () => {
  test("an already answered form is never overwritten", async () => {
    const harness = createHarness();
    harness.forms.getImpl = async () => ({
      ...pendingDetail([stringField()]),
      state: { status: "answered", answer: { q0: "user choice" } },
    });
    const runtime = startAutoQuestion(harness.deps());
    try {
      await runtime.handleEvent(createdEvent());
      await harness.scheduler.advance(AUTO_ANSWER_DELAY_MS);
      expect(harness.forms.replies).toEqual([]);
      expect(harness.storage.keys()).toEqual([]);
    } finally {
      runtime.dispose();
    }
  });

  test("a form that changed shape is left alone", async () => {
    const harness = createHarness();
    harness.forms.getImpl = async () => pendingDetail([{ key: "q0", type: "boolean" }]);
    const runtime = startAutoQuestion(harness.deps());
    try {
      await runtime.handleEvent(createdEvent());
      await harness.scheduler.advance(AUTO_ANSWER_DELAY_MS);
      expect(harness.forms.replies).toEqual([]);
    } finally {
      runtime.dispose();
    }
  });

  test("get and reply failures attempt once without retries", async () => {
    const failingGet = createHarness();
    failingGet.forms.getImpl = async () => {
      throw new Error("gone");
    };
    const getRuntime = startAutoQuestion(failingGet.deps());
    try {
      await getRuntime.handleEvent(createdEvent());
      await failingGet.scheduler.advance(AUTO_ANSWER_DELAY_MS * 3);
      expect(failingGet.forms.replies).toEqual([]);
      expect(failingGet.storage.keys()).toEqual([]);
    } finally {
      getRuntime.dispose();
    }

    const failingReply = createHarness();
    failingReply.forms.replyImpl = async () => {
      throw new Error("conflict");
    };
    const replyRuntime = startAutoQuestion(failingReply.deps());
    try {
      await replyRuntime.handleEvent(createdEvent());
      await failingReply.scheduler.advance(AUTO_ANSWER_DELAY_MS * 3);
      expect(failingReply.forms.replyCalls).toBe(1);
      expect(failingReply.storage.keys()).toEqual([]);
    } finally {
      replyRuntime.dispose();
    }
  });
});

describe("reload recovery", () => {
  test("foreign location recovery neither answers nor removes the owner's deadline", async () => {
    const storage = new FakeStorage();
    const owner = createHarness(storage);
    const first = startAutoQuestion(owner.deps());
    await first.handleEvent(createdEvent());
    first.dispose();

    for (const scope of [
      { directory: "/another-project", workspaceID: WORKSPACE },
      { directory: DIRECTORY, workspaceID: "another-workspace" },
    ]) {
      const foreign = createHarness(storage);
      const foreignRuntime = startAutoQuestion(foreign.deps(scope));
      await foreignRuntime.recover();
      await foreign.scheduler.advance(750_000);
      expect(foreign.forms.getCalls).toBe(0);
      expect(foreign.forms.replies).toEqual([]);
      expect(storage.keys()).toHaveLength(1);
      foreignRuntime.dispose();
    }

    const resumed = createHarness(storage);
    const resumedRuntime = startAutoQuestion(resumed.deps());
    await resumedRuntime.recover();
    await resumed.scheduler.advance(750_000);
    expect(resumed.forms.replies).toEqual([{ sessionID: "s1", formID: "f1", answer: { q0: AUTO_ANSWER_TEXT } }]);
    expect(storage.keys()).toEqual([]);
    resumedRuntime.dispose();
  });

  test("a reload keeps the original deadline", async () => {
    const storage = new FakeStorage();
    const first = createHarness(storage);
    const firstRuntime = startAutoQuestion(first.deps());
    await firstRuntime.handleEvent(createdEvent({ created: START }));
    await first.scheduler.advance(100_000);
    expect(first.forms.replies).toEqual([]);
    firstRuntime.dispose();

    const second = createHarness(storage);
    second.clock.set(first.clock.now());
    const secondRuntime = startAutoQuestion(second.deps());
    try {
      await secondRuntime.recover();
      await second.scheduler.advance(AUTO_ANSWER_DELAY_MS - 100_000 - 1);
      expect(second.forms.replies).toEqual([]);
      await second.scheduler.advance(1);
      expect(second.forms.replies).toHaveLength(1);
    } finally {
      secondRuntime.dispose();
    }
  });

  test("recovery pages through stored deadlines", async () => {
    const storage = new FakeStorage(1);
    const seeder = createHarness(storage);
    const seederRuntime = startAutoQuestion(seeder.deps());
    await seederRuntime.handleEvent(createdEvent({ formID: "f1", created: START }));
    await seederRuntime.handleEvent(createdEvent({ formID: "f2", created: START }));
    await seederRuntime.handleEvent(createdEvent({ formID: "f3", created: START }));
    seederRuntime.dispose();
    expect(storage.keys()).toHaveLength(3);

    const recovered = createHarness(storage);
    const recoveredRuntime = startAutoQuestion(recovered.deps());
    try {
      await recoveredRuntime.recover();
      await recovered.scheduler.advance(AUTO_ANSWER_DELAY_MS);
      expect(recovered.forms.replies.map((reply) => reply.formID).sort()).toEqual([
        "f1",
        "f2",
        "f3",
      ]);
    } finally {
      recoveredRuntime.dispose();
    }
  });

  test("recovery ignores forms that already settled", async () => {
    const storage = new FakeStorage();
    const seeder = createHarness(storage);
    const seederRuntime = startAutoQuestion(seeder.deps());
    await seederRuntime.handleEvent(createdEvent({ created: START }));
    seederRuntime.dispose();

    const recovered = createHarness(storage);
    recovered.forms.getImpl = async () => {
      throw new Error("deleted");
    };
    const recoveredRuntime = startAutoQuestion(recovered.deps());
    try {
      await recoveredRuntime.recover();
      await recovered.scheduler.advance(AUTO_ANSWER_DELAY_MS + 1);
      expect(recovered.forms.replies).toEqual([]);
      expect(storage.keys()).toEqual([]);
    } finally {
      recoveredRuntime.dispose();
    }
  });
});

describe("cleanup", () => {
  test("a storage scan completing after disposal cannot re-arm timers", async () => {
    const harness = createHarness();
    const scan = Promise.withResolvers<StorageScanResult>();
    const runtime = startAutoQuestion(harness.deps({
      storage: { ...harness.storage.port, scan: () => scan.promise },
    }));
    runtime.dispose();
    scan.resolve({ entries: [{
      key: "auto-question/v1/s1/f1",
      value: { sessionID: "s1", formID: "f1", deadline: START + 750_000 },
    }] });
    await flush();
    expect(harness.scheduler.pending()).toBe(0);
    await harness.scheduler.advance(750_000);
    expect(harness.forms.getCalls).toBe(0);
  });

  test("aborting an in-flight read preserves its deadline for reload", async () => {
    const harness = createHarness();
    const read = Promise.withResolvers<unknown>();
    harness.forms.getImpl = () => read.promise;
    const runtime = startAutoQuestion(harness.deps());
    await runtime.handleEvent(createdEvent());
    await harness.scheduler.advance(750_000);
    expect(harness.forms.getCalls).toBe(1);
    runtime.dispose();
    read.reject(new Error("aborted during unload"));
    await flush();
    expect(harness.storage.keys()).toHaveLength(1);
    expect(harness.forms.replies).toEqual([]);
  });

  test("disposal cancels timers but preserves stored deadlines", async () => {
    const harness = createHarness();
    const runtime = startAutoQuestion(harness.deps());
    await runtime.handleEvent(createdEvent());
    expect(harness.scheduler.pending()).toBe(1);
    runtime.dispose();
    expect(harness.scheduler.pending()).toBe(0);
    expect(harness.storage.keys()).toHaveLength(1);
    await harness.scheduler.advance(AUTO_ANSWER_DELAY_MS * 2);
    expect(harness.forms.replies).toEqual([]);
  });

  test("an in-flight check never submits after disposal", async () => {
    const harness = createHarness();
    let release: ((value: unknown) => void) | undefined;
    const gate = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    harness.forms.getImpl = () => gate;
    const runtime = startAutoQuestion(harness.deps());
    try {
      await runtime.handleEvent(createdEvent());
      await harness.scheduler.advance(AUTO_ANSWER_DELAY_MS);
      expect(harness.forms.getCalls).toBe(1);
      runtime.dispose();
      release?.(pendingDetail([stringField()]));
      await flush();
      expect(harness.forms.replies).toEqual([]);
      expect(harness.storage.keys()).toHaveLength(1);
    } finally {
      runtime.dispose();
    }
  });
});
