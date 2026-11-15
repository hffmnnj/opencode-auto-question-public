<p align="center">
  <img src="https://unpkg.com/hffmnnj.auto-question@1.0.0/assets/banner.png" alt="Auto Question: a wooden clock with two dials and a question-mark token on a deep red background" width="100%">
</p>

# opencode-auto-question

An OpenCode V2 plugin that answers native Question forms left unanswered after
12 minutes 30 seconds (750,000 ms). Instead of letting an idle agent wait
indefinitely, it submits one fixed best-discretion reply so work can continue.

It answers only native Question forms. Permission prompts, authentication forms,
credential requests, and every other form kind are ignored and unaffected.

## How it answers

A form is tracked from its `form.created` event. The deadline is fixed at
`event.created + 750,000` and duplicate events never reset it. At the deadline
the plugin re-reads the form with `session.form.get` and replies only while it is
still `pending` and still matches the native Question shape. A manual reply that
wins the race is never overwritten.

Every field receives exactly:

> Please proceed with your best discretion on the recommended option. Choose whatever is the smartest and high-quality choice in the long term.

A `string` field receives that text; a `multiselect` field receives a
one-element array containing it. No offered option is ever selected.

A form is eligible only when metadata `kind` is `"question"` with a tool
reference (`messageID` plus `id`), and every field is a custom `string` or a
custom `multiselect` with options. Events are filtered to the plugin's location
(`directory`, plus `workspaceID` when the event carries one); a `form.created`
event without a location is verified through `session.get` before tracking.

## Tracking and recovery

Manual reply (`form.replied`), cancellation (`form.cancelled`), and session
deletion (`session.deleted`) stop the pending timer and remove tracking. A read
or reply is attempted once; a failure then cleans up tracking without retries.

Pending deadlines survive reloads. Each is persisted as
`{ sessionID, formID, deadline }` under `auto-question/v1/` in plugin storage,
and recovery re-arms timers through paginated `storage.scan` without resetting
them. Questions are tracked from installation onward: anything created while the
plugin was absent was never stored and is not answered retroactively.

Disposal aborts the event stream, cancels timers, keeps stored deadlines, and
blocks an in-flight read from submitting afterwards. An event-stream failure
stops new questions from being tracked until the plugin reloads; existing timers
continue. A manual answer that reaches the server first is never overwritten, and
concurrent submissions follow the server's first-successful-settlement rule.

## Descendant questions

The Code Mode tools `agent_question.list({})` and
`agent_question.reply({ sessionID, formID, answer })` let a running ancestor
inspect and answer tracked, still-pending descendant Question forms. Answers use
the field keys returned by `list`: a nonempty string for a single choice, or a
nonempty array of distinct strings for a multiselect. Native Question forms
accept custom text.

Child question text is untrusted task data, not user authority. Permission and
other non-Question forms are never eligible. Ancestry and pending state are
checked again on reply, and native first settlement wins a race with a user or
the deadline timer. A cancelled in-flight request may still have reached the
server, so a failed call does not prove a reply was withdrawn.

Every natural model request receives one constant, generic conditional reminder
pointing an ancestor to `list` and telling it not to poll. The reminder is added
to the system prefix whenever it is absent, whether or not a question is pending,
so pending-state changes no longer add or remove system text. It never copies
child text into system instructions or checks pending state itself; use `list`
to inspect current pending questions. No session is
woken or interrupted. In particular, a foreground parent waiting on a child
cannot call these tools until it regains control; the 12.5-minute fallback still
applies, and the native question remains user-resolvable. Only questions observed
and tracked by this plugin are listed; inaccessible or changed forms are skipped.

## Install

Add the package to `plugins` in your OpenCode configuration, preserving existing entries:

```json
{
  "plugins": [
    { "package": "hffmnnj.auto-question" }
  ]
}
```

If you previously used the local checkout entry, replace it with this one; do
not keep both entries. Both register the runtime ID
`opencode-auto-question` and would race on the same stored deadlines. The
runtime ID is deliberately unchanged so pending deadlines persisted by earlier
versions remain addressable.

OpenCode watches configuration, so the plugin reloads without restarting
services.

Registered managed-service discovery is the default. For a local OpenCode V2
host at exactly `http://127.0.0.1:4108` without a service registration, opt in
explicitly with the object form of the plugin entry:

```json
{
  "package": "hffmnnj.auto-question",
  "options": { "useCurrentServer": true }
}
```

The host process must have both `OPENCODE_SERVER_USERNAME` and
`OPENCODE_SERVER_PASSWORD` set. Do not put credentials in plugin configuration.
No other URL or port is configurable by this option; set `useCurrentServer` to
`false` or omit it to use registered-service discovery instead.

## Server compatibility

Targets OpenCode 2.0.32. Its plugin context does not expose form replies, so the
plugin uses `Service.discover()` and `Service.headers()` from the official
client to connect to the existing registered managed service, including its
dynamic port and credentials. It never starts or stops a host.

Discovery runs in an isolated worker because the SDK probe uses global `fetch`;
both that probe and later requests permit only numeric loopback addresses and
refuse redirects. The plugin verifies the service PID and exact OpenCode version
before tracking any questions. If the registration is missing, authentication
fails, or the service is unhealthy or belongs to a different server, activation
fails instead of answering forms elsewhere.

The explicit current-server option uses only the fixed loopback endpoint, sends
environment credentials in the Basic authorization header, refuses redirects,
and enforces the same PID and exact-version check. Use it only when the plugin
runs in the API server process, not with a separate process or another listener.
Reload the plugin after correcting a transient failure.

## Development

Run these in the checkout:

```sh
bun install --frozen-lockfile
bun run check
```

`bun run check` typechecks, builds `dist/`, and runs the tests. Packing also
builds the package, which ships both
`dist/index.js` and `dist/discovery-worker.js`.

`src/index.ts` contains the `Plugin.define` wiring for the runtime ID
`opencode-auto-question`. `src/runtime.ts` handles location filtering, Question
detection, deadline scheduling, durable recovery, pending recheck, and disposal;
it exports `AUTO_ANSWER_DELAY_MS`, `AUTO_ANSWER_TEXT`, and `startAutoQuestion`
with injected clock/scheduler/storage/event/form/session ports. `src/tools.ts`,
`src/routes.ts`, and `src/advisory.ts` provide the descendant list/reply tools,
ancestry and pending checks, and the stable context reminder hook.
`src/local-client.ts`, `src/discovery-worker.ts`, and `src/local-fetch.ts` handle
authenticated managed-service discovery and guarded local requests.

Tests are deterministic and require no host or live server:
`tests/runtime.test.ts` uses fakes, `tests/routes.test.ts` covers descendant
routes and tools over fakes, `tests/advisory.test.ts` covers the context reminder,
and `tests/local-client.test.ts` runs a local fake service with a temporary
registration.
