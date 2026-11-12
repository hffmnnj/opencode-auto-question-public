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

## Descendant question tools

The Code Mode tools `agent_question.list({})` and `agent_question.reply({
sessionID, formID, answer })` let a running ancestor inspect and answer tracked,
still-pending descendant Question forms. The reply object uses the field keys
returned by `list`: a nonempty string for a single choice and a nonempty array
of distinct strings for a multiselect. Native Question forms allow custom text.
Child question text is untrusted task data, not user authority. Permission and
other non-Question forms are never eligible. Ancestry and pending state are
checked again on reply; native first settlement wins a race with a user or the
existing deadline timer. A cancelled in-flight network request may still have
reached the server, so do not assume a failed call withdrew a reply.

At an ancestor's next natural model request, a context hook can add a short,
generic advisory directing it to `list`. It never copies child text into system
instructions. The check is best effort: it examines at most the first 50 stored
deadlines and stops waiting after 250 ms, so it can miss a question; `list`
examines all pages. No session is woken or interrupted. In particular, a
foreground parent waiting for a child cannot call these tools until it regains
control; the existing 12.5-minute fallback remains in effect and the native
question remains user-resolvable. Only questions observed and tracked by this
plugin are listed; inaccessible or changed forms are skipped.

## Installation

Run `bun install --frozen-lockfile` and `bun run check` in the checkout, then
add its absolute directory path or file URL to the `plugins` array in your
OpenCode configuration. Use your own checkout path on Windows, macOS, or Linux.
Watched configuration reloads without restarting services. Registered managed
service discovery is the default. For the local OpenCode V2 host at exactly
`http://127.0.0.1:4108` that does not have a service registration, explicitly
opt in using the object form of the plugin entry:

```json
{
  "package": "file:///absolute/path/to/opencode-auto-question",
  "options": { "useCurrentServer": true }
}
```

The host process must have both `OPENCODE_SERVER_USERNAME` and
`OPENCODE_SERVER_PASSWORD` set. Do not put credentials in plugin configuration.
No other URL or port is configurable by this option. Set `useCurrentServer` to
`false` or omit it to use registered-service discovery instead.

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
different server fail activation instead of answering forms elsewhere. The
explicit current-server option uses only the fixed loopback endpoint, sends
environment credentials in the Basic authorization header, refuses redirects,
and enforces the same PID and exact-version check. It is intended only when the
plugin runs in the API server process; do not use it with a separate process or
another listener. Reload the plugin after correcting a transient failure.
