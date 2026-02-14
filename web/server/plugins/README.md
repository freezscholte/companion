# Plugin System (V2)

This folder contains Companion's server-side plugin runtime.

## Event Contract

All events use a versioned envelope:

```ts
{
  name: PluginEventName,
  meta: {
    eventId: string,
    eventVersion: 2,
    timestamp: number,
    source: "routes" | "ws-bridge" | "codex-adapter" | "plugin-manager",
    sessionId?: string,
    backendType?: "claude" | "codex",
    correlationId?: string,
  },
  data: PluginEventMap[name],
}
```

`eventVersion` is mandatory for forward compatibility.

## Execution Semantics

Each plugin declares execution policy:

- `priority`: higher value runs first on the same event.
- `blocking`: if `true`, awaited in order; if `false`, fire-and-forget.
- `timeoutMs`: max execution time before timeout error.
- `failPolicy`:
  - `continue`: keep running the remaining plugins.
  - `abort_current_action`: stop processing remaining plugins for this event.

## Plugin Definition

```ts
const plugin: PluginDefinition<MyConfig> = {
  id: "my-plugin",
  name: "My Plugin",
  version: "1.0.0",
  description: "My plugin description",
  events: ["result.received"],
  priority: 100,
  blocking: true,
  timeoutMs: 1000,
  failPolicy: "continue",
  defaultEnabled: false,
  defaultConfig: { /* ... */ },
  validateConfig: (raw) => normalizedConfig,
  onEvent: async (event, config) => {
    // return insights and/or permissionDecision
  },
};
```

## Integration Checklist

1. Create a plugin file in this folder.
2. Export it from `builtins.ts` via `getBuiltinPlugins()`.
3. Add config validation for deterministic runtime behavior.
4. Add tests in `manager.test.ts` (or plugin-specific tests).
5. Expose config shape in the `/plugins` UI (JSON config editor already available).

## Notes

- Permission automation should remain explicit and rule-based.
- Non-blocking plugins should only perform side effects (notifications, telemetry, etc.).
- Use `correlationId` for traceability between request/response events.
