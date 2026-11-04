import type { Plugin } from "@opencode/plugin";

/**
 * Deadline for auto-answering an unanswered Question form: 12 minutes 30 seconds.
 */
export const AUTO_ANSWER_DELAY_MS = 750_000;

/**
 * Exact custom answer written to every Question field when its deadline fires.
 * String fields receive this text; multiselect fields receive a one-element
 * array containing it. No offered option is ever selected.
 */
export const AUTO_ANSWER_TEXT =
  "Please proceed with your best discretion on the recommended option. Choose whatever is the smartest and high-quality choice in the long term.";

const STORAGE_PREFIX = "auto-question/v1/";

export type StoragePort = Plugin.Context["storage"];

export interface ClockPort {
  now(): number;
}

export interface SchedulerPort {
  schedule(delayMs: number, callback: () => void): () => void;
}

export interface FormsPort {
  get(sessionID: string, formID: string): Promise<unknown>;
  reply(
    sessionID: string,
    formID: string,
    answer: Record<string, string | ReadonlyArray<string>>,
  ): Promise<void>;
}

export interface SessionsPort {
  locationOf(sessionID: string): Promise<{ readonly directory: string; readonly workspaceID?: string } | undefined>;
}

export interface AutoQuestionDeps {
  readonly directory: string;
  readonly workspaceID?: string;
  readonly clock: ClockPort;
  readonly scheduler: SchedulerPort;
  readonly storage: StoragePort;
  readonly events: AsyncIterable<unknown>;
  readonly forms: FormsPort;
  readonly sessions: SessionsPort;
}

export interface AutoQuestionRuntime {
  handleEvent(event: unknown): Promise<void>;
  recover(): Promise<void>;
  dispose(): void;
  readonly done: Promise<void>;
}

interface TrackedField {
  readonly key: string;
  readonly multi: boolean;
}

interface TrackedEntry {
  readonly sessionID: string;
  readonly formID: string;
  readonly cancel: () => void;
}

interface EventLocation {
  readonly directory: string;
  readonly workspaceID: string | undefined;
}

type ParsedEvent =
  | {
      readonly kind: "created";
      readonly sessionID: string;
      readonly formID: string;
      readonly created: number;
      readonly location: EventLocation | undefined;
      readonly metadata: unknown;
      readonly fields: unknown;
    }
  | {
      readonly kind: "settled";
      readonly sessionID: string;
      readonly formID: string | undefined;
      readonly location: EventLocation | undefined;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function readLocation(value: unknown): EventLocation | undefined {
  if (!isRecord(value)) return undefined;
  const directory = value["directory"];
  if (typeof directory !== "string") return undefined;
  const workspaceID = value["workspaceID"];
  return {
    directory,
    workspaceID: typeof workspaceID === "string" ? workspaceID : undefined,
  };
}

/**
 * Mirrors the native Question tool contract: metadata kind "question" plus a
 * tool reference carrying the originating message. Anything else (permissions,
 * auth, credentials, arbitrary forms) is rejected.
 */
function isQuestionMetadata(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false;
  if (metadata["kind"] !== "question") return false;
  const tool = metadata["tool"];
  if (!isRecord(tool)) return false;
  return typeof tool["messageID"] === "string" && typeof tool["id"] === "string";
}

/**
 * Accepts only the native Question field shape: non-empty fields where every
 * field is a custom string or a custom multiselect with options.
 */
function readQuestionFields(fields: unknown): ReadonlyArray<TrackedField> | undefined {
  if (!Array.isArray(fields) || fields.length === 0) return undefined;
  const parsed: Array<TrackedField> = [];
  for (const field of fields) {
    if (!isRecord(field)) return undefined;
    const key = field["key"];
    const type = field["type"];
    if (typeof key !== "string" || key.length === 0) return undefined;
    if (type === "string") {
      if (field["custom"] !== true) return undefined;
      parsed.push({ key, multi: false });
    } else if (type === "multiselect") {
      if (field["custom"] !== true || !Array.isArray(field["options"])) return undefined;
      parsed.push({ key, multi: true });
    } else {
      return undefined;
    }
  }
  return parsed;
}

function readFormDetail(detail: unknown):
  | { readonly metadata: unknown; readonly fields: unknown; readonly status: string }
  | undefined {
  if (!isRecord(detail)) return undefined;
  const state = detail["state"];
  if (!isRecord(state) || typeof state["status"] !== "string") return undefined;
  if (!Array.isArray(detail["fields"])) return undefined;
  return { metadata: detail["metadata"], fields: detail["fields"], status: state["status"] };
}

function readStored(value: unknown):
  | { readonly sessionID: string; readonly formID: string; readonly deadline: number }
  | undefined {
  if (!isRecord(value)) return undefined;
  const sessionID = value["sessionID"];
  const formID = value["formID"];
  const deadline = value["deadline"];
  if (typeof sessionID !== "string" || typeof formID !== "string") return undefined;
  if (typeof deadline !== "number" || !Number.isFinite(deadline)) return undefined;
  return { sessionID, formID, deadline };
}

function parseEvent(event: unknown): ParsedEvent | undefined {
  if (!isRecord(event)) return undefined;
  if (typeof event["type"] !== "string") return undefined;
  const hasLocation = event["location"] !== undefined;
  const location = hasLocation ? readLocation(event["location"]) : undefined;
  if (hasLocation && location === undefined) return undefined;
  const data = event["data"];
  if (!isRecord(data)) return undefined;
  if (event["type"] === "form.created") {
    const form = data["form"];
    if (!isRecord(form)) return undefined;
    const sessionID = readStringField(form, "sessionID");
    const formID = readStringField(form, "id");
    if (sessionID === undefined || formID === undefined) return undefined;
    if (typeof event["created"] !== "number" || !Number.isFinite(event["created"])) return undefined;
    return {
      kind: "created",
      sessionID,
      formID,
      created: event["created"],
      location,
      metadata: form["metadata"],
      fields: form["fields"],
    };
  }
  if (event["type"] === "form.replied" || event["type"] === "form.cancelled") {
    const sessionID = readStringField(data, "sessionID");
    const formID = readStringField(data, "id");
    if (sessionID === undefined || formID === undefined) return undefined;
    return { kind: "settled", sessionID, formID, location };
  }
  if (event["type"] === "session.deleted") {
    const sessionID = readStringField(data, "sessionID");
    if (sessionID === undefined) return undefined;
    return { kind: "settled", sessionID, formID: undefined, location };
  }
  return undefined;
}

function buildAnswer(
  fields: ReadonlyArray<TrackedField>,
): Record<string, string | ReadonlyArray<string>> {
  const answer: Record<string, string | ReadonlyArray<string>> = {};
  for (const field of fields) {
    answer[field.key] = field.multi ? [AUTO_ANSWER_TEXT] : AUTO_ANSWER_TEXT;
  }
  return answer;
}

function storageKey(sessionID: string, formID: string): string {
  return `${STORAGE_PREFIX}${sessionID}/${formID}`;
}

export function startAutoQuestion(deps: AutoQuestionDeps): AutoQuestionRuntime {
  let disposed = false;
  const tracked = new Map<string, TrackedEntry>();

  function locationMatches(location: EventLocation): boolean {
    if (location.directory !== deps.directory) return false;
    return location.workspaceID === undefined || location.workspaceID === deps.workspaceID;
  }

  async function inScope(
    location: EventLocation | undefined,
    sessionID: string,
  ): Promise<boolean> {
    if (location !== undefined) return locationMatches(location);
    try {
      const current = await deps.sessions.locationOf(sessionID);
      return current !== undefined && locationMatches({ directory: current.directory, workspaceID: current.workspaceID });
    } catch {
      return false;
    }
  }

  async function forget(key: string): Promise<void> {
    try {
      await deps.storage.remove(key);
    } catch {
      // Durable cleanup is best effort; in-memory tracking is already gone.
    }
  }

  function arm(key: string, sessionID: string, formID: string, deadline: number): void {
    if (disposed || tracked.has(key)) return;
    const delay = Math.max(0, deadline - deps.clock.now());
    const cancel = deps.scheduler.schedule(delay, () => {
      void fire(key, sessionID, formID).catch(() => undefined);
    });
    tracked.set(key, { sessionID, formID, cancel });
  }

  async function track(sessionID: string, formID: string, deadline: number): Promise<void> {
    const key = storageKey(sessionID, formID);
    if (disposed || tracked.has(key)) return;
    arm(key, sessionID, formID, deadline);
    try {
      const record: Record<string, string | number> = { sessionID, formID, deadline };
      await deps.storage.set(key, record);
    } catch {
      // In-memory tracking still answers this session; only reload recovery is lost.
    }
  }

  async function fire(key: string, sessionID: string, formID: string): Promise<void> {
    tracked.delete(key);
    if (disposed) return;
    try {
      // Plugin storage is shared between locations. Leave another location's
      // deadline intact so its own instance can recover and answer it.
      if (!(await inScope(undefined, sessionID)) || disposed) return;
      const detail = await deps.forms.get(sessionID, formID);
      if (disposed) return;
      const form = readFormDetail(detail);
      const fields = form === undefined ? undefined : readQuestionFields(form.fields);
      if (
        form === undefined ||
        form.status !== "pending" ||
        fields === undefined ||
        !isQuestionMetadata(form.metadata)
      ) {
        await forget(key);
        return;
      }
      if (disposed) return;
      await deps.forms.reply(sessionID, formID, buildAnswer(fields));
      await forget(key);
    } catch {
      if (!disposed) await forget(key);
    }
  }

  async function untrack(sessionID: string, formID: string | undefined): Promise<void> {
    const removals: Array<Promise<void>> = [];
    for (const [key, entry] of tracked) {
      if (entry.sessionID !== sessionID) continue;
      if (formID !== undefined && entry.formID !== formID) continue;
      entry.cancel();
      tracked.delete(key);
      removals.push(forget(key));
    }
    await Promise.all(removals);
  }

  async function handleEvent(event: unknown): Promise<void> {
    if (disposed) return;
    try {
      const parsed = parseEvent(event);
      if (parsed === undefined) return;
      if (parsed.kind === "created") {
        if (!(await inScope(parsed.location, parsed.sessionID))) return;
        if (!isQuestionMetadata(parsed.metadata)) return;
        if (readQuestionFields(parsed.fields) === undefined) return;
        await track(parsed.sessionID, parsed.formID, parsed.created + AUTO_ANSWER_DELAY_MS);
        return;
      }
      if (parsed.location !== undefined && !locationMatches(parsed.location)) return;
      await untrack(parsed.sessionID, parsed.formID);
    } catch {
      // Event handling never throws; a bad event must not kill the pump.
    }
  }

  async function recover(): Promise<void> {
    try {
      let after: string | undefined;
      for (;;) {
        const page = await deps.storage.scan(
          after === undefined ? { prefix: STORAGE_PREFIX } : { prefix: STORAGE_PREFIX, after },
        );
        if (disposed) return;
        for (const entry of page.entries) {
          const record = readStored(entry.value);
          if (record === undefined) {
            await forget(entry.key);
            continue;
          }
          const key = storageKey(record.sessionID, record.formID);
          if (key !== entry.key) await forget(entry.key);
          if (!tracked.has(key)) arm(key, record.sessionID, record.formID, record.deadline);
        }
        if (page.next === undefined) break;
        after = page.next;
      }
    } catch {
      // Recovery is best effort; live events keep tracking new questions.
    }
  }

  async function pump(): Promise<void> {
    try {
      for await (const event of deps.events) {
        if (disposed) break;
        await handleEvent(event);
      }
    } catch {
      // Stream errors (including abort) stop the pump without retry storms.
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const entry of tracked.values()) entry.cancel();
    tracked.clear();
  }

  const done = pump();
  void recover().catch(() => undefined);

  return { handleEvent, recover, dispose, done };
}
