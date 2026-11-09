# Install and disable

OpenCode compatibility: 2.0.32.

```sh
cd <checkout-directory>
bun install --frozen-lockfile
bun run check
```

Add the absolute path or file URL of the checkout to `plugins` in your OpenCode configuration, preserving all existing entries. For example:

```json
"/path/to/opencode-auto-question"
```

The watched configuration reloads plugins without restarting the server. Check the plugin list for the desired location on the existing managed service. The `opencode-auto-question` entry should be active. Do not launch a second OpenCode server for verification. A registered, authenticated numeric-loopback service owned by the plugin's own process is required; discovery failure prevents activation.

To disable, remove only this plugin entry from the global configuration. Unloading cancels its timers. Stored deadlines remain available if it is enabled again; only forms still pending are eligible for a reply.

The plugin replies through the native form API. It does not submit user prompts or grant permissions. Native form settlement rejects a second reply with HTTP 409, preserving an answer already submitted manually.
