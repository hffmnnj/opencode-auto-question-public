# Automatic Question answers

## Goal
Answer unanswered OpenCode V2 Question tool forms after 12.5 minutes (750,000 milliseconds), using exactly:

> Please proceed with your best discretion on the recommended option. Choose whatever is the smartest and high-quality choice in the long term.

## Scope
A standalone `opencode-auto-question` plugin for OpenCode 2.0.32, installed in the global V2 configuration. Use native form replies, not synthetic user prompts. Each question field receives the text as a custom answer; multiselect fields receive a one-element array. Start the deadline when the form is created. Remember tracked deadlines across plugin reloads. Only handle forms whose metadata kind is `question` and whose fields match the native Question shape.

## Not doing
- No auto-approval of permissions, OAuth, credentials, or arbitrary forms.
- No model calls, automatic option selection, session creation, or injected prompts.
- No changes to OpenCode binaries or service restarts.
- No UI or configurable timeout in v1.

## Acceptance checks
1. No answer at 749,999 ms; submit the exact text at 750,000 ms.
2. Single, multiple, and batched questions receive correctly shaped custom answers.
3. Manual reply, cancellation, session deletion, and plugin cleanup prevent later answers.
4. Forms outside the plugin location and non-Question forms are ignored.
5. Duplicate events and reload recovery do not reset deadlines or produce duplicate replies; recheck native pending state immediately before replying.
6. Typecheck, focused tests, and build pass, the real server accepts the reply shape, and the installed plugin appears active.
