import { useEffect, useState } from "react";
import { api, type PluginRuntimeInfo } from "../api.js";
import { useStore } from "../store.js";

interface PluginsPageProps {
  embedded?: boolean;
}

function stringifyConfig(config: unknown): string {
  try {
    return JSON.stringify(config ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

export function PluginsPage({ embedded = false }: PluginsPageProps) {
  const plugins = useStore((s) => s.plugins);
  const setPlugins = useStore((s) => s.setPlugins);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [draftById, setDraftById] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    api
      .listPlugins()
      .then((list) => {
        setPlugins(list);
        const drafts = new Map<string, string>();
        for (const plugin of list) {
          drafts.set(plugin.id, stringifyConfig(plugin.config));
        }
        setDraftById(drafts);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }, [setPlugins]);

  async function updatePlugin(plugin: PluginRuntimeInfo, enabled: boolean) {
    setSavingId(plugin.id);
    setError("");
    try {
      const updated = enabled ? await api.enablePlugin(plugin.id) : await api.disablePlugin(plugin.id);
      setPlugins(plugins.map((p) => (p.id === updated.id ? updated : p)));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingId(null);
    }
  }

  async function saveConfig(plugin: PluginRuntimeInfo) {
    setSavingId(plugin.id);
    setError("");
    try {
      const raw = draftById.get(plugin.id) || "{}";
      const parsed = JSON.parse(raw) as unknown;
      const updated = await api.updatePluginConfig(plugin.id, parsed);
      setPlugins(plugins.map((p) => (p.id === updated.id ? updated : p)));
      setDraftById((prev) => {
        const next = new Map(prev);
        next.set(plugin.id, stringifyConfig(updated.config));
        return next;
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className={`${embedded ? "h-full" : "h-[100dvh]"} bg-cc-bg text-cc-fg font-sans-ui antialiased overflow-y-auto`}>
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-cc-fg">Plugins</h1>
            <p className="mt-1 text-sm text-cc-muted">
              Enable automations and configure event-based triggers.
            </p>
          </div>
          {!embedded && (
            <button
              onClick={() => {
                window.location.hash = "";
              }}
              className="px-3 py-1.5 rounded-lg text-sm text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            >
              Back
            </button>
          )}
        </div>

        {loading && <p className="text-sm text-cc-muted">Loading plugins...</p>}
        {error && <p className="text-sm text-cc-error">{error}</p>}

        {plugins.map((plugin) => (
          <section key={plugin.id} className="bg-cc-card border border-cc-border rounded-xl p-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-cc-fg">{plugin.name}</h2>
                <p className="text-xs text-cc-muted">{plugin.description}</p>
                <p className="text-[11px] text-cc-muted mt-1">
                  id: <code className="font-mono-code">{plugin.id}</code> · v{plugin.version}
                </p>
                <p className="text-[11px] text-cc-muted mt-1">
                  priority: {plugin.priority} · mode: {plugin.blocking ? "blocking" : "non-blocking"}
                </p>
                <p className="text-[11px] text-cc-muted mt-1">
                  timeout: {plugin.timeoutMs}ms · fail policy: {plugin.failPolicy}
                </p>
              </div>
              <button
                onClick={() => updatePlugin(plugin, !plugin.enabled)}
                disabled={savingId === plugin.id}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                  plugin.enabled
                    ? "bg-cc-success/10 text-cc-success hover:bg-cc-success/20"
                    : "bg-cc-hover text-cc-muted hover:text-cc-fg"
                }`}
              >
                {savingId === plugin.id ? "Saving..." : plugin.enabled ? "Enabled" : "Disabled"}
              </button>
            </div>

            <div>
              <p className="text-[11px] text-cc-muted mb-1">Events: {plugin.events.join(", ")}</p>
              <textarea
                value={draftById.get(plugin.id) || "{}"}
                onChange={(e) => {
                  const value = e.target.value;
                  setDraftById((prev) => {
                    const next = new Map(prev);
                    next.set(plugin.id, value);
                    return next;
                  });
                }}
                rows={8}
                className="w-full px-3 py-2.5 text-xs bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg font-mono-code focus:outline-none focus:border-cc-primary/60"
              />
            </div>

            <div className="flex justify-end">
              <button
                onClick={() => saveConfig(plugin)}
                disabled={savingId === plugin.id}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer disabled:bg-cc-hover disabled:text-cc-muted disabled:cursor-not-allowed"
              >
                Save config
              </button>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
