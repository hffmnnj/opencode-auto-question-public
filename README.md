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

## Installation

Run `bun install --frozen-lockfile && bun run check`, then add
`"file:///path/to/opencode-auto-question"` to the `plugins` array
in `~/.config/opencode-v2/opencode.json`. Watched configuration reloads
without restarting services. There are no configuration options in v1.

## Layout

- `src/index.ts` — `Plugin.define` wiring (`id: opencode-auto-question`).
- `src/runtime.ts` — location filtering, Question detection, deadline
  scheduling, durable recovery, pending recheck, and disposal. Exports
  `AUTO_ANSWER_DELAY_MS`, `AUTO_ANSWER_TEXT`, and `startAutoQuestion` with
  injected clock/scheduler/storage/event/form/session ports.
- `tests/runtime.test.ts` — deterministic behavioral tests over fakes
  (no sleeps, no live server).

## Server compatibility

Tested against OpenCode 2.0.32. Its plugin context does not expose form replies,
so the plugin uses the official `@opencode/client` against the existing main
server at `http://127.0.0.1:4108`. It uses the server's existing
`OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD` environment variables,
never starts a host, refuses redirects, and verifies that the endpoint belongs
to the plugin's own process before tracking any questions. Missing credentials
or a different server cause plugin activation to fail rather than answer forms
elsewhere. This v1 is specific to that installation's main-server address.
