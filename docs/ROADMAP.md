# Roadmap

## Current status

`opencode-auto-question` is an OpenCode V2 plugin for OpenCode 2.0.32 that
answers native Question forms left pending for 750,000 ms. Every field receives
the fixed best-discretion text as a custom answer; no offered option is
selected.

Permission prompts, authentication forms, credential requests, and every other
form kind are ignored. A manual reply always wins, deadlines survive plugin
reloads, and the plugin replies only while the form is still pending. Code Mode
tools let an ancestor list and answer tracked descendant Question forms. See the
[README](../README.md) for install, configuration, and behavior details.

## Follow-ups

- After a transient event-stream failure, new questions are not tracked until
  the plugin reloads; already-armed timers keep working. Add reconnect behavior
  if needed.
