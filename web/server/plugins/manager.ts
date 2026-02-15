import type {
  PermissionAutomationDecision,
  PluginCapability,
  PluginDefinition,
  PluginEvent,
  PluginEventResult,
  PluginHealth,
  PluginRuntimeInfo,
  PluginStats,
} from "./types.js";
import { PluginStateStore } from "./state-store.js";
import { getBuiltinPlugins } from "./builtins.js";

export interface EmitResult {
  insights: NonNullable<PluginEventResult["insights"]>;
  permissionDecision?: PermissionAutomationDecision;
  userMessageMutation?: NonNullable<PluginEventResult["userMessageMutation"]>;
  aborted: boolean;
}

export interface PluginDryRunResult {
  pluginId: string;
  applied: boolean;
  blockedByCapabilities: PluginCapability[];
  result: EmitResult;
}

interface EmitOptions {
  onInsight?: (insight: EmitResult["insights"][number]) => void;
}

const DEFAULT_TIMEOUT_MS = 3000;
const STATS_WINDOW_SIZE = 100;
const DEGRADED_FAILURE_THRESHOLD = 3;

class PluginTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Plugin timeout after ${timeoutMs}ms`);
    this.name = "PluginTimeoutError";
  }
}

export class PluginConfigValidationError extends Error {
  pluginId: string;

  constructor(pluginId: string, message: string) {
    super(message);
    this.name = "PluginConfigValidationError";
    this.pluginId = pluginId;
  }
}

function toPluginErrorInsight(pluginId: string, event: PluginEvent, err: unknown) {
  return {
    id: `${pluginId}-${Date.now()}-error`,
    plugin_id: pluginId,
    title: "Plugin error",
    message: err instanceof Error ? err.message : String(err),
    level: "error" as const,
    timestamp: Date.now(),
    event_name: event.name,
    session_id: event.meta.sessionId,
  };
}

function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new PluginTimeoutError(timeoutMs));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function createEmptyStats(): PluginStats {
  return {
    invocations: 0,
    successes: 0,
    errors: 0,
    timeouts: 0,
    aborted: 0,
    lastDurationMs: 0,
    avgDurationMs: 0,
    p95DurationMs: 0,
  };
}

function createDefaultHealth(enabled: boolean): PluginHealth {
  return {
    status: enabled ? "healthy" : "disabled",
    updatedAt: Date.now(),
  };
}

export class PluginManager {
  private definitions = new Map<string, PluginDefinition<any>>();
  private stateStore: PluginStateStore;
  private warnedInvalidConfig = new Set<string>();
  private stats = new Map<string, PluginStats>();
  private health = new Map<string, PluginHealth>();
  private durationWindows = new Map<string, number[]>();
  private outcomeWindows = new Map<string, Array<"success" | "error" | "timeout" | "aborted">>();

  constructor(stateStore?: PluginStateStore) {
    this.stateStore = stateStore || new PluginStateStore();
    for (const plugin of getBuiltinPlugins()) {
      this.register(plugin);
    }
  }

  register(plugin: PluginDefinition<any>): void {
    this.definitions.set(plugin.id, plugin);
    if (!this.stats.has(plugin.id)) this.stats.set(plugin.id, createEmptyStats());
    if (!this.health.has(plugin.id)) this.health.set(plugin.id, createDefaultHealth(plugin.defaultEnabled));
    if (!this.outcomeWindows.has(plugin.id)) this.outcomeWindows.set(plugin.id, []);
  }

  private resolveConfig(
    plugin: PluginDefinition<any>,
    stateConfig: unknown,
    options: { persistDefaultOnInvalid?: boolean } = {},
  ): unknown {
    const rawConfig = stateConfig ?? plugin.defaultConfig;
    if (!plugin.validateConfig) return rawConfig;
    try {
      return plugin.validateConfig(rawConfig);
    } catch (err) {
      if (!this.warnedInvalidConfig.has(plugin.id)) {
        console.warn(`[plugins] Invalid config for plugin ${plugin.id}, falling back to defaults:`, err);
        this.warnedInvalidConfig.add(plugin.id);
      }
      if (options.persistDefaultOnInvalid && stateConfig !== undefined) {
        this.stateStore.update((draft) => {
          draft.config[plugin.id] = plugin.defaultConfig;
        });
      }
      return plugin.defaultConfig;
    }
  }

  private getRequestedCapabilities(plugin: PluginDefinition<any>): PluginCapability[] {
    return plugin.capabilities ? [...plugin.capabilities] : [];
  }

  private resolveCapabilityGrants(plugin: PluginDefinition<any>, state = this.stateStore.getState()): Record<PluginCapability, boolean> {
    const requested = this.getRequestedCapabilities(plugin);
    const grants = state.grants?.[plugin.id] || {};
    const out: Record<PluginCapability, boolean> = {} as Record<PluginCapability, boolean>;
    for (const cap of requested) {
      // Backward-compatible default: granted unless explicitly revoked.
      out[cap] = grants[cap] !== false;
    }
    return out;
  }

  private getGrantedCapabilities(plugin: PluginDefinition<any>, state = this.stateStore.getState()): PluginCapability[] {
    const grants = this.resolveCapabilityGrants(plugin, state);
    return this.getRequestedCapabilities(plugin).filter((cap) => grants[cap]);
  }

  private sanitizeResultForCapabilities(
    plugin: PluginDefinition<any>,
    result: PluginEventResult,
    grants: Record<PluginCapability, boolean>,
  ): { sanitized: PluginEventResult; blocked: PluginCapability[] } {
    // Backward compatibility: v1 plugins with no declared capabilities keep existing behavior.
    if (!plugin.capabilities || plugin.capabilities.length === 0) {
      return { sanitized: result, blocked: [] };
    }

    const blocked: PluginCapability[] = [];
    const sanitized: PluginEventResult = { ...result };

    if (result.permissionDecision && !grants["permission:auto-decide"]) {
      sanitized.permissionDecision = undefined;
      blocked.push("permission:auto-decide");
    }

    if (result.userMessageMutation && !grants["message:mutate"]) {
      sanitized.userMessageMutation = undefined;
      blocked.push("message:mutate");
    }

    if (result.eventDataPatch && !grants["event:patch"]) {
      sanitized.eventDataPatch = undefined;
      blocked.push("event:patch");
    }

    if (result.insights?.length) {
      sanitized.insights = result.insights.map((insight) => {
        const next = { ...insight };
        if (next.toast && !grants["insight:toast"]) {
          next.toast = false;
          if (!blocked.includes("insight:toast")) blocked.push("insight:toast");
        }
        if (next.sound && !grants["insight:sound"]) {
          next.sound = false;
          if (!blocked.includes("insight:sound")) blocked.push("insight:sound");
        }
        if (next.desktop && !grants["insight:desktop"]) {
          next.desktop = false;
          if (!blocked.includes("insight:desktop")) blocked.push("insight:desktop");
        }
        return next;
      });
    }

    if (blocked.length > 0) {
      sanitized.insights = [
        ...(sanitized.insights || []),
        {
          id: `${plugin.id}-${Date.now()}-capability-blocked`,
          plugin_id: plugin.id,
          title: "Capability blocked",
          message: `Blocked by capability grants: ${blocked.join(", ")}`,
          level: "warning",
          timestamp: Date.now(),
        },
      ];
    }

    return { sanitized, blocked };
  }

  private updateStatsOnRun(pluginId: string, durationMs: number, outcome: "success" | "error" | "timeout" | "aborted", error?: string): void {
    const prev = this.stats.get(pluginId) || createEmptyStats();
    const next: PluginStats = {
      ...prev,
      invocations: prev.invocations + 1,
      lastDurationMs: durationMs,
      lastInvokedAt: Date.now(),
    };

    if (outcome === "success") next.successes += 1;
    if (outcome === "error") next.errors += 1;
    if (outcome === "timeout") next.timeouts += 1;
    if (outcome === "aborted") next.aborted += 1;
    if (error) next.lastError = error;

    const win = [...(this.durationWindows.get(pluginId) || []), durationMs];
    if (win.length > STATS_WINDOW_SIZE) win.splice(0, win.length - STATS_WINDOW_SIZE);
    this.durationWindows.set(pluginId, win);

    const recentOutcomes = [...(this.outcomeWindows.get(pluginId) || []), outcome];
    if (recentOutcomes.length > STATS_WINDOW_SIZE) {
      recentOutcomes.splice(0, recentOutcomes.length - STATS_WINDOW_SIZE);
    }
    this.outcomeWindows.set(pluginId, recentOutcomes);

    const sum = win.reduce((acc, v) => acc + v, 0);
    next.avgDurationMs = win.length > 0 ? Math.round(sum / win.length) : 0;

    const sorted = [...win].sort((a, b) => a - b);
    if (sorted.length > 0) {
      const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
      next.p95DurationMs = sorted[Math.max(0, idx)] || 0;
    }

    this.stats.set(pluginId, next);

    const recentFailures = recentOutcomes.filter((row) => row === "error" || row === "timeout" || row === "aborted").length;
    const degraded = recentFailures >= DEGRADED_FAILURE_THRESHOLD;
    this.health.set(pluginId, {
      status: degraded ? "degraded" : "healthy",
      reason: degraded ? "High recent failure rate" : undefined,
      updatedAt: Date.now(),
    });
  }

  private updateHealthFromEnabled(pluginId: string, enabled: boolean): void {
    if (!enabled) {
      this.health.set(pluginId, {
        status: "disabled",
        reason: "Plugin disabled",
        updatedAt: Date.now(),
      });
      return;
    }

    const existing = this.health.get(pluginId);
    if (!existing || existing.status === "disabled") {
      this.health.set(pluginId, {
        status: "healthy",
        updatedAt: Date.now(),
      });
    }
  }

  list(): PluginRuntimeInfo[] {
    const state = this.stateStore.getState();
    return Array.from(this.definitions.values()).map((plugin) => {
      const savedEnabled = state.enabled[plugin.id];
      const enabled = typeof savedEnabled === "boolean" ? savedEnabled : plugin.defaultEnabled;
      const config = this.resolveConfig(plugin, state.config[plugin.id], { persistDefaultOnInvalid: true });
      const requested = this.getRequestedCapabilities(plugin);
      const granted = this.getGrantedCapabilities(plugin, state);
      this.updateHealthFromEnabled(plugin.id, enabled);

      return {
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        events: plugin.events,
        priority: plugin.priority,
        blocking: plugin.blocking,
        timeoutMs: plugin.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        failPolicy: plugin.failPolicy ?? "continue",
        enabled,
        config,
        capabilitiesRequested: requested,
        capabilitiesGranted: granted,
        riskLevel: plugin.riskLevel ?? "low",
        apiVersion: plugin.apiVersion ?? 1,
        health: this.health.get(plugin.id) || createDefaultHealth(enabled),
        stats: this.stats.get(plugin.id) || createEmptyStats(),
      };
    });
  }

  getStats(id: string): PluginStats | null {
    if (!this.definitions.has(id)) return null;
    return this.stats.get(id) || createEmptyStats();
  }

  setEnabled(id: string, enabled: boolean): PluginRuntimeInfo | null {
    const plugin = this.definitions.get(id);
    if (!plugin) return null;

    this.stateStore.update((draft) => {
      draft.enabled[id] = enabled;
    });
    this.updateHealthFromEnabled(id, enabled);

    return this.list().find((row) => row.id === id) || null;
  }

  updateConfig(id: string, rawConfig: unknown): PluginRuntimeInfo | null {
    const plugin = this.definitions.get(id);
    if (!plugin) return null;

    let config: unknown;
    try {
      config = plugin.validateConfig ? plugin.validateConfig(rawConfig) : rawConfig;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new PluginConfigValidationError(id, `Invalid config for plugin ${id}: ${message}`);
    }

    this.stateStore.update((draft) => {
      draft.config[id] = config;
    });
    this.warnedInvalidConfig.delete(id);

    return this.list().find((row) => row.id === id) || null;
  }

  updateCapabilityGrants(
    id: string,
    grants: Record<string, boolean>,
  ): PluginRuntimeInfo | null {
    const plugin = this.definitions.get(id);
    if (!plugin) return null;

    const requested = this.getRequestedCapabilities(plugin);
    this.stateStore.update((draft) => {
      const current = { ...(draft.grants[id] || {}) } as Record<PluginCapability, boolean>;
      for (const cap of requested) {
        if (typeof grants[cap] === "boolean") {
          current[cap] = grants[cap];
        }
      }
      draft.grants[id] = current;
    });

    return this.list().find((row) => row.id === id) || null;
  }

  private async executePlugin(
    plugin: PluginDefinition<any>,
    event: PluginEvent,
    stateConfig: unknown,
  ): Promise<{ result?: PluginEventResult; error?: unknown; blockedCapabilities: PluginCapability[]; durationMs: number }> {
    const config = this.resolveConfig(plugin, stateConfig, { persistDefaultOnInvalid: true });
    const timeoutMs = plugin.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const state = this.stateStore.getState();
    const grants = this.resolveCapabilityGrants(plugin, state);

    const startedAt = Date.now();
    try {
      const raw = await runWithTimeout(Promise.resolve(plugin.onEvent(event, config)), timeoutMs);
      const durationMs = Date.now() - startedAt;
      if (!raw) {
        return { result: undefined, blockedCapabilities: [], durationMs };
      }
      const { sanitized, blocked } = this.sanitizeResultForCapabilities(plugin, raw, grants);
      return { result: sanitized, blockedCapabilities: blocked, durationMs };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      return { error, blockedCapabilities: [], durationMs };
    }
  }

  async dryRun(pluginId: string, event: PluginEvent, rawConfig?: unknown): Promise<PluginDryRunResult | null> {
    const plugin = this.definitions.get(pluginId);
    if (!plugin) return null;

    const exec = await this.executePlugin(plugin, event, rawConfig);
    if (exec.error) {
      return {
        pluginId,
        applied: false,
        blockedByCapabilities: [],
        result: {
          insights: [toPluginErrorInsight(pluginId, event, exec.error)],
          aborted: false,
        },
      };
    }

    return {
      pluginId,
      applied: !!exec.result,
      blockedByCapabilities: exec.blockedCapabilities,
      result: {
        insights: exec.result?.insights || [],
        permissionDecision: exec.result?.permissionDecision,
        userMessageMutation: exec.result?.userMessageMutation,
        aborted: false,
      },
    };
  }

  async emit(event: PluginEvent, options: EmitOptions = {}): Promise<EmitResult> {
    const state = this.stateStore.getState();
    const insights: EmitResult["insights"] = [];
    let permissionDecision: PermissionAutomationDecision | undefined;
    let userMessageMutation: EmitResult["userMessageMutation"];
    let aborted = false;
    let mutableEvent: PluginEvent = event;

    const candidates = Array.from(this.definitions.values())
      .filter((plugin) => plugin.events.includes("*") || plugin.events.includes(event.name))
      .sort((a, b) => b.priority - a.priority);

    for (const plugin of candidates) {
      const savedEnabled = state.enabled[plugin.id];
      const enabled = typeof savedEnabled === "boolean" ? savedEnabled : plugin.defaultEnabled;
      this.updateHealthFromEnabled(plugin.id, enabled);
      if (!enabled) continue;

      if (!plugin.blocking) {
        void this.executePlugin(plugin, mutableEvent, state.config[plugin.id])
          .then((exec) => {
            if (exec.error) {
              const isTimeout = exec.error instanceof PluginTimeoutError;
              this.updateStatsOnRun(plugin.id, exec.durationMs, isTimeout ? "timeout" : "error", exec.error instanceof Error ? exec.error.message : String(exec.error));
              options.onInsight?.(toPluginErrorInsight(plugin.id, event, exec.error));
              return;
            }
            this.updateStatsOnRun(plugin.id, exec.durationMs, "success");
            if (!exec.result?.insights?.length) return;
            for (const insight of exec.result.insights) {
              options.onInsight?.(insight);
            }
          })
          .catch((err) => {
            this.updateStatsOnRun(plugin.id, 0, "error", err instanceof Error ? err.message : String(err));
            options.onInsight?.(toPluginErrorInsight(plugin.id, event, err));
          });
        continue;
      }

      const failPolicy = plugin.failPolicy ?? "continue";
      const exec = await this.executePlugin(plugin, mutableEvent, state.config[plugin.id]);

      if (exec.error) {
        const errText = exec.error instanceof Error ? exec.error.message : String(exec.error);
        if (failPolicy === "abort_current_action") {
          this.updateStatsOnRun(plugin.id, exec.durationMs, "aborted", errText);
        } else {
          const isTimeout = exec.error instanceof PluginTimeoutError;
          this.updateStatsOnRun(plugin.id, exec.durationMs, isTimeout ? "timeout" : "error", errText);
        }
        insights.push(toPluginErrorInsight(plugin.id, event, exec.error));
        if (failPolicy === "abort_current_action") {
          aborted = true;
          break;
        }
        continue;
      }

      this.updateStatsOnRun(plugin.id, exec.durationMs, "success");
      const result = exec.result;
      if (!result) continue;

      if (result.eventDataPatch && mutableEvent.data && typeof mutableEvent.data === "object") {
        mutableEvent = {
          ...mutableEvent,
          data: {
            ...(mutableEvent.data as Record<string, unknown>),
            ...result.eventDataPatch,
          },
        } as PluginEvent;
      }
      if (result.insights?.length) insights.push(...result.insights);
      if (!permissionDecision && result.permissionDecision) {
        permissionDecision = result.permissionDecision;
      }
      if (result.userMessageMutation) {
        userMessageMutation = {
          ...userMessageMutation,
          ...result.userMessageMutation,
        };
        if (
          mutableEvent.name === "user.message.before_send"
          && mutableEvent.data
          && typeof mutableEvent.data === "object"
        ) {
          const nextData = { ...(mutableEvent.data as Record<string, unknown>) };
          if (typeof result.userMessageMutation.content === "string") {
            nextData.content = result.userMessageMutation.content;
          }
          if (Array.isArray(result.userMessageMutation.images)) {
            nextData.images = result.userMessageMutation.images;
          }
          mutableEvent = { ...mutableEvent, data: nextData } as PluginEvent;
        }
      }
    }

    return { insights, permissionDecision, userMessageMutation, aborted };
  }
}
