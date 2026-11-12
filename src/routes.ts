import {
  isQuestionMetadata, readStored, storageKey, STORAGE_PREFIX,
  type ClockPort, type FormsPort, type StoragePort,
} from "./runtime.ts";

type Answer = Record<string, string | readonly string[]>;
interface SessionRecord { readonly id: string; readonly parentID?: string }
export interface RouteDeps {
  readonly storage: StoragePort;
  readonly forms: FormsPort;
  readonly clock: ClockPort;
  readonly session: (id: string, signal?: AbortSignal) => Promise<SessionRecord>;
}
interface Option { readonly value: string; readonly label: string; readonly description?: string }
interface Field {
  readonly key: string;
  readonly type: "string" | "multiselect";
  readonly custom: true;
  readonly title?: string;
  readonly description?: string;
  readonly options: readonly Option[];
  readonly minItems?: number;
  readonly maxItems?: number;
}
export interface PendingQuestion {
  readonly sessionID: string;
  readonly formID: string;
  readonly deadline: number;
  readonly fields: readonly Field[];
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function fieldsOf(detail: unknown, sessionID: string, formID: string): Field[] | undefined {
  if (!object(detail) || detail.id !== formID || detail.sessionID !== sessionID ||
      !object(detail.state) || detail.state.status !== "pending" ||
      !isQuestionMetadata(detail.metadata) || !Array.isArray(detail.fields) || detail.fields.length === 0) return;
  const result: Field[] = [];
  const keys = new Set<string>();
  for (const field of detail.fields) {
    if (!object(field) || typeof field.key !== "string" || !field.key || keys.has(field.key) ||
        (field.type !== "string" && field.type !== "multiselect") || field.custom !== true ||
        !optionalText(field.title) || !optionalText(field.description) ||
        (!Array.isArray(field.options) && !(field.type === "string" && field.options === undefined)) ||
        field.hidden === true || field.when !== undefined || field.format !== undefined ||
        field.pattern !== undefined || field.minLength !== undefined || field.maxLength !== undefined) return;
    const options: Option[] = [];
    for (const option of field.options ?? []) {
      if (!object(option) || typeof option.value !== "string" || typeof option.label !== "string" ||
          !optionalText(option.description)) return;
      options.push({ value: option.value, label: option.label, ...(option.description === undefined ? {} : { description: option.description }) });
    }
    const min = field.minItems;
    const max = field.maxItems;
    if ((min !== undefined && (!Number.isSafeInteger(min) || (min as number) < 0)) ||
        (max !== undefined && (!Number.isSafeInteger(max) || (max as number) < 0)) ||
        (typeof min === "number" && typeof max === "number" && min > max)) return;
    keys.add(field.key);
    result.push({ key: field.key, type: field.type, custom: true, options,
      ...(field.title === undefined ? {} : { title: field.title }),
      ...(field.description === undefined ? {} : { description: field.description }),
      ...(typeof min === "number" ? { minItems: min } : {}),
      ...(typeof max === "number" ? { maxItems: max } : {}) });
  }
  return result;
}

function validAnswer(fields: readonly Field[], answer: unknown): answer is Answer {
  if (!object(answer) || Object.keys(answer).length !== fields.length) return false;
  return fields.every((field) => {
    if (!Object.hasOwn(answer, field.key)) return false;
    const value = answer[field.key];
    if (field.type === "string") return typeof value === "string" && value.trim().length > 0;
    return Array.isArray(value) && value.length >= Math.max(1, field.minItems ?? 0) &&
      (field.maxItems === undefined || value.length <= field.maxItems) &&
      value.every((item) => typeof item === "string" && item.trim().length > 0) &&
      new Set(value).size === value.length;
  });
}

// All plugin instances in this process share this reservation; native form settlement
// still arbitrates against user replies and the existing deadline timer.
const replying = new Set<string>();

export function createQuestionRoutes(deps: RouteDeps) {
  async function ancestor(caller: string, child: string, signal?: AbortSignal): Promise<boolean> {
    if (caller === child) return false;
    const seen = new Set<string>();
    let id = child;
    let found = false;
    for (let depth = 0; depth < 64; depth++) {
      signal?.throwIfAborted();
      if (seen.has(id)) return false;
      seen.add(id);
      const session = await deps.session(id, signal);
      signal?.throwIfAborted();
      if (session.id !== id || (session.parentID !== undefined && !session.parentID)) return false;
      if (id === caller) found = true;
      if (session.parentID === undefined) return found;
      id = session.parentID;
    }
    return false;
  }

  async function getPending(caller: string, sessionID: string, formID: string, signal?: AbortSignal): Promise<PendingQuestion | undefined> {
    signal?.throwIfAborted();
    if (!(await ancestor(caller, sessionID, signal))) return;
    const key = storageKey(sessionID, formID);
    const record = readStored(await deps.storage.get(key));
    signal?.throwIfAborted();
    if (!record || record.sessionID !== sessionID || record.formID !== formID || record.deadline <= deps.clock.now()) return;
    const detail = await deps.forms.get(sessionID, formID, signal);
    signal?.throwIfAborted();
    const fields = fieldsOf(detail, sessionID, formID);
    if (!fields || record.deadline <= deps.clock.now()) return;
    return { sessionID, formID, deadline: record.deadline, fields };
  }

  async function list(caller: string, signal?: AbortSignal): Promise<PendingQuestion[]> {
    const questions: PendingQuestion[] = [];
    let after: string | undefined;
    const cursors = new Set<string>();
    do {
      signal?.throwIfAborted();
      const page = await deps.storage.scan({ prefix: STORAGE_PREFIX, ...(after === undefined ? {} : { after }) });
      signal?.throwIfAborted();
      for (const entry of page.entries) {
        const record = readStored(entry.value);
        if (!record || entry.key !== storageKey(record.sessionID, record.formID) || record.deadline <= deps.clock.now()) continue;
        try {
          const question = await getPending(caller, record.sessionID, record.formID, signal);
          if (question) questions.push(question);
        } catch {
          signal?.throwIfAborted();
          // An inaccessible or settled child is not exposed to this caller.
        }
      }
      if (page.next !== undefined && cursors.has(page.next)) throw new Error("Invalid storage cursor");
      if (page.next !== undefined) cursors.add(page.next);
      after = page.next;
    } while (after !== undefined);
    return questions;
  }

  // A single bounded storage page keeps natural model requests responsive.
  async function hasPending(caller: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const page = await deps.storage.scan({ prefix: STORAGE_PREFIX, limit: 50 });
    signal?.throwIfAborted();
    for (const entry of page.entries) {
      const record = readStored(entry.value);
      if (!record || entry.key !== storageKey(record.sessionID, record.formID) || record.deadline <= deps.clock.now()) continue;
      try {
        if (await getPending(caller, record.sessionID, record.formID, signal)) return true;
      } catch {
        signal?.throwIfAborted();
      }
    }
    return false;
  }

  async function reply(caller: string, sessionID: string, formID: string, answer: unknown, signal?: AbortSignal): Promise<void> {
    const key = storageKey(sessionID, formID);
    if (replying.has(key)) throw new Error("Question reply already in progress");
    replying.add(key);
    try {
      const question = await getPending(caller, sessionID, formID, signal);
      if (!question) throw new Error("Question unavailable");
      if (!validAnswer(question.fields, answer)) throw new Error("Invalid question answer");
      // Recheck the durable registration after the asynchronous form read.
      const record = readStored(await deps.storage.get(key));
      signal?.throwIfAborted();
      if (!record || record.sessionID !== sessionID || record.formID !== formID ||
          record.deadline !== question.deadline || record.deadline <= deps.clock.now()) throw new Error("Question unavailable");
      await deps.forms.reply(sessionID, formID, answer);
    } finally {
      replying.delete(key);
    }
  }
  return { list, reply, hasPending };
}
