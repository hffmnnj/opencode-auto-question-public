# Install and disable

OpenCode compatibility: 2.0.32.

```sh
cd /path/to/opencode-auto-question
bun install --frozen-lockfile
bun run check
```

Add this entry to `plugins` in `~/.config/opencode-v2/opencode.json`, preserving all existing entries:

```json
"file:///path/to/opencode-auto-question"
```

The watched global configuration reloads plugins without restarting the server. Check `/api/plugin` on the existing authenticated main server at `http://127.0.0.1:4108`, using the desired `location[directory]` query. The `opencode-auto-question` entry should be active. Do not launch a second OpenCode server for verification.

To disable, remove only this plugin entry from the global configuration. Unloading cancels its timers. Stored deadlines remain available if it is enabled again; only forms still pending are eligible for a reply.

The plugin replies through the native form API. It does not submit user prompts or grant permissions. Native form settlement rejects a second reply with HTTP 409, preserving an answer already submitted manually.
