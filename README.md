# opencode-auto-question

Automatically answers unanswered OpenCode V2 Question tool forms after
12 minutes 30 seconds (750,000 ms) with a fixed best-discretion reply.

## Behavior

- Tracks a Question form from its `form.created` event. The deadline is
  `event.created + 750,000` and is never reset by duplicate events.
- At the deadline the plugin re-reads the form with `session.form.get` and
  replies only when the form is still `pending` and still matches the native
  Question shape. A user reply that wins the race is therefore never
  overwritten.
- Every field receives exactly:

  > Please proceed with your best discretion on the recommended option. Choose whatever is the smartest and high-quality choice in the long term.

  A `string` field receives that text; a `multiselect` field receives a
  one-element array containing it. No offered option is ever selected.
- Only native Question forms are answered: metadata `kind` must be
  `"question"` with a tool reference (`messageID` plus `id`), and every field
  must be a custom `string` or a custom `multiselect` with options.
  Permission prompts, auth forms, credentials, and any other form kind are
  ignored and therefore unaffected.
- Events are filtered to the plugin location (`directory`, plus
  `workspaceID` when the event carries one). A `form.created` event without
  a location is verified through `session.get` before tracking.
- Manual reply (`form.replied`), cancellation (`form.cancelled`), and session
  deletion (`session.deleted`) stop the pending timer and remove tracking.
- Tracked deadlines survive reloads: each pending form persists
  `{ sessionID, formID, deadline }` under `auto-question/v1/` in plugin
  storage, and recovery re-arms timers through paginated `storage.scan`
  without resetting deadlines. New questions are tracked from installation;
  questions created while the plugin was absent were never stored and are not
  answered retroactively.
- Failures attempt once: a failed read or reply cleans up tracking without
  retries. Disposal aborts the event stream, cancels timers, keeps stored
  deadlines, and blocks an in-flight read from submitting afterwards.
- An event-stream failure stops tracking new questions until plugin reload;
  existing timers continue. A manual answer that reaches the server before the
  timeout reply is never overwritten; concurrent submissions use the server's
  first-successful-settlement rule.

## Installation

Run `bun install --frozen-lockfile` and `bun run check` in the checkout, then
add its absolute directory path or file URL to the `plugins` array in your
OpenCode configuration. Use your own checkout path on Windows, macOS, or Linux.
Watched configuration reloads without restarting services. There are no
configuration options in v1.

## Layout

- `src/index.ts` — `Plugin.define` wiring (`id: opencode-auto-question`).
- `src/local-client.ts`, `src/discovery-worker.ts`, `src/local-fetch.ts` —
  authenticated managed-service discovery and guarded local requests.
- `src/runtime.ts` — location filtering, Question detection, deadline
  scheduling, durable recovery, pending recheck, and disposal. Exports
  `AUTO_ANSWER_DELAY_MS`, `AUTO_ANSWER_TEXT`, and `startAutoQuestion` with
  injected clock/scheduler/storage/event/form/session ports.
- `tests/runtime.test.ts` — deterministic behavioral tests over fakes
  (no sleeps, no live server); `tests/local-client.test.ts` uses a local fake
  service and a temporary registration.

## Server compatibility

Targets OpenCode 2.0.32. Its plugin context does not expose form replies, so
the plugin uses `Service.discover()` and `Service.headers()` from the official
client to connect to the existing registered managed service, including its
dynamic port and credentials. It never starts or stops a host. Discovery runs
in an isolated worker because the SDK's probe uses global fetch; both that
probe and later requests permit only numeric loopback addresses and refuse
redirects. The plugin verifies the service PID and exact OpenCode version before
tracking any questions. Missing registration, authentication, an unhealthy or
different server, or unsupported explicit/standalone servers fail activation
instead of answering forms elsewhere. Reload the plugin after correcting a
transient discovery failure. This change has not been tested with a live host.
