# Roadmap

- [x] Inspect OpenCode 2.0.32 plugin and native Question form contracts.
- [x] Implement scoped event handling, durable deadlines, native replies, and focused timing/lifecycle tests.
- [x] Verify locally, install in global V2 configuration without restarting services, and check the real form API.
- [ ] Publish the private repository and pull request with usage and verification results.

## Verification

- `bun run check`: TypeScript passes, 20 tests pass, and the bundle builds.
- Authenticated main-server API: plugin state is `active`; exact custom string and multiselect answers are accepted and stored. A second settlement receives HTTP 409 and does not overwrite the first.
- A real 750-second timer smoke test is running against a scratch form in an existing completed worker session. It creates no session and performs no model execution.
