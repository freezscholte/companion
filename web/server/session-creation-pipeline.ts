/**
 * Shared session-creation pipeline.
 *
 * Both `POST /sessions/create` (JSON) and `POST /sessions/create-stream` (SSE)
 * perform the same multi-step sequence:
 *   1. Validate & resolve environment
 *   2. Git operations (worktree / checkout / fetch+pull)
 *   3. Docker image pull + container creation + workspace copy + init script
 *   4. CLI launch
 *   5. Post-launch bookkeeping (container retrack, worktree tracking)
 *
 * The only difference is how errors and progress are reported to the caller.
 * This module extracts the shared logic and uses a `ProgressReporter` interface
 * so each endpoint can plug in its own reporting strategy.
 */

import * as envManager from "./env-manager.js";
import * as gitUtils from "./git-utils.js";
import { containerManager, type ContainerConfig, type ContainerInfo } from "./container-manager.js";
import { hasContainerClaudeAuth } from "./claude-container-auth.js";
import { hasContainerCodexAuth } from "./codex-container-auth.js";
import { imagePullManager } from "./image-pull-manager.js";
import type { CliLauncher, SdkSessionInfo } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import type { WorktreeTracker } from "./worktree-tracker.js";
import type { CreationStepId, BackendType } from "./session-types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** The raw request body accepted by both session-creation endpoints. */
export interface SessionCreateBody {
  resumeSessionAt?: string;
  forkSession?: boolean;
  backend?: string;
  env?: Record<string, string>;
  envSlug?: string;
  cwd?: string;
  branch?: string;
  createBranch?: boolean;
  useWorktree?: boolean;
  container?: {
    image?: string;
    ports?: number[];
    volumes?: string[];
  };
  model?: string;
  permissionMode?: string;
  claudeBinary?: string;
  codexBinary?: string;
  allowedTools?: string[];
  codexInternetAccess?: boolean;
}

/** Abstraction over error/progress reporting so the pipeline is transport-agnostic. */
export interface ProgressReporter {
  /** Report a fatal error — the pipeline will stop after this. */
  error(message: string, status?: number, step?: CreationStepId): Promise<void>;
  /** Report step progress (no-op for the non-streaming endpoint). */
  progress(step: CreationStepId, label: string, status: "in_progress" | "done" | "error", detail?: string): Promise<void>;
  /** Subscribe to image pull progress lines. Return an unsubscribe function. */
  onImagePullProgress?(image: string, cb: (line: string) => void): () => void;
  /** Subscribe to init script output lines. */
  onInitScriptOutput?(line: string): void;
}

/** Result of a successful pipeline run. */
export interface PipelineResult {
  session: SdkSessionInfo;
  worktreeInfo?: WorktreeInfo;
  containerInfo?: ContainerInfo;
  /** The possibly-rewritten cwd (e.g. worktree path). */
  cwd: string;
}

interface WorktreeInfo {
  isWorktree: boolean;
  repoRoot: string;
  branch: string;
  actualBranch: string;
  worktreePath: string;
}

/** Dependencies injected from the route handler. */
export interface PipelineDeps {
  launcher: CliLauncher;
  wsBridge: WsBridge;
  worktreeTracker: WorktreeTracker;
  /** Container port for VS Code editor inside containers. */
  editorContainerPort: number;
  /** Container port for Codex app-server WebSocket. */
  codexAppServerContainerPort: number;
}

// ─── Sentinel used to signal early-exit (error already reported) ────────────

class PipelineAbort extends Error {
  constructor() {
    super("pipeline_abort");
    this.name = "PipelineAbort";
  }
}

// ─── Pipeline ───────────────────────────────────────────────────────────────

/**
 * Run the full session-creation pipeline.
 *
 * Returns `PipelineResult` on success, or `null` if an error was reported
 * via the reporter and the pipeline was aborted.
 */
export async function runSessionCreationPipeline(
  body: SessionCreateBody,
  reporter: ProgressReporter,
  deps: PipelineDeps,
): Promise<PipelineResult | null> {
  try {
    return await _run(body, reporter, deps);
  } catch (e) {
    if (e instanceof PipelineAbort) return null;
    throw e;
  }
}

// ─── Internal implementation ────────────────────────────────────────────────

async function _run(
  body: SessionCreateBody,
  r: ProgressReporter,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  const { launcher, wsBridge, worktreeTracker, editorContainerPort, codexAppServerContainerPort } = deps;

  // ── 1. Validate basics ──────────────────────────────────────────────────

  const resumeSessionAt =
    typeof body.resumeSessionAt === "string" && body.resumeSessionAt.trim()
      ? body.resumeSessionAt.trim()
      : undefined;
  const forkSession = body.forkSession === true;
  const backend = (body.backend ?? "claude") as BackendType;

  if (backend !== "claude" && backend !== "codex") {
    await r.error(`Invalid backend: ${String(backend)}`, 400);
    throw new PipelineAbort();
  }

  // ── 2. Resolve environment ──────────────────────────────────────────────

  await r.progress("resolving_env", "Resolving environment...", "in_progress");

  let envVars: Record<string, string> | undefined = body.env;
  const companionEnv = body.envSlug ? envManager.getEnv(body.envSlug) : null;

  if (body.envSlug) {
    if (companionEnv) {
      console.log(
        `[session-pipeline] Injecting env "${companionEnv.name}" (${Object.keys(companionEnv.variables).length} vars):`,
        Object.keys(companionEnv.variables).join(", "),
      );
      envVars = { ...companionEnv.variables, ...body.env };
    } else {
      console.warn(`[session-pipeline] Environment "${body.envSlug}" not found, ignoring`);
    }
  }

  await r.progress("resolving_env", "Environment resolved", "done");

  // ── 3. Git operations ───────────────────────────────────────────────────

  let cwd = body.cwd;
  let worktreeInfo: WorktreeInfo | undefined;

  if (body.branch && !/^[a-zA-Z0-9/_.\-]+$/.test(body.branch)) {
    await r.error("Invalid branch name", 400, "checkout_branch");
    throw new PipelineAbort();
  }

  if (body.useWorktree && body.branch && cwd) {
    await r.progress("creating_worktree", "Creating worktree...", "in_progress");
    const repoInfo = gitUtils.getRepoInfo(cwd);
    if (repoInfo) {
      const result = gitUtils.ensureWorktree(repoInfo.repoRoot, body.branch, {
        baseBranch: repoInfo.defaultBranch,
        createBranch: body.createBranch,
        forceNew: true,
      });
      cwd = result.worktreePath;
      worktreeInfo = {
        isWorktree: true,
        repoRoot: repoInfo.repoRoot,
        branch: body.branch,
        actualBranch: result.actualBranch,
        worktreePath: result.worktreePath,
      };
    }
    await r.progress("creating_worktree", "Worktree ready", "done");
  } else if (body.branch && cwd) {
    const repoInfo = gitUtils.getRepoInfo(cwd);
    if (repoInfo) {
      await r.progress("fetching_git", "Fetching from remote...", "in_progress");
      const fetchResult = gitUtils.gitFetch(repoInfo.repoRoot);
      if (!fetchResult.success) {
        console.warn(`[session-pipeline] git fetch failed (non-fatal): ${fetchResult.output}`);
      }
      await r.progress(
        "fetching_git",
        fetchResult.success ? "Fetch complete" : "Fetch skipped (offline?)",
        "done",
      );

      if (repoInfo.currentBranch !== body.branch) {
        await r.progress("checkout_branch", `Checking out ${body.branch}...`, "in_progress");
        gitUtils.checkoutOrCreateBranch(repoInfo.repoRoot, body.branch, {
          createBranch: body.createBranch,
          defaultBranch: repoInfo.defaultBranch,
        });
        await r.progress("checkout_branch", `On branch ${body.branch}`, "done");
      }

      await r.progress("pulling_git", "Pulling latest changes...", "in_progress");
      const pullResult = gitUtils.gitPull(repoInfo.repoRoot);
      if (!pullResult.success) {
        console.warn(`[session-pipeline] git pull warning (non-fatal): ${pullResult.output}`);
      }
      await r.progress("pulling_git", "Up to date", "done");
    }
  }

  // ── 4. Docker / Container setup ─────────────────────────────────────────

  const effectiveImage = companionEnv
    ? (body.envSlug ? envManager.getEffectiveImage(body.envSlug) : null)
    : (body.container?.image || null);

  let containerInfo: ContainerInfo | undefined;
  let containerId: string | undefined;
  let containerName: string | undefined;
  let containerImage: string | undefined;

  // Auth check for containerized sessions
  if (effectiveImage && backend === "claude" && !hasContainerClaudeAuth(envVars)) {
    await r.error(
      "Containerized Claude requires auth available inside the container. " +
      "Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_AUTH_TOKEN) in the selected environment.",
      400,
    );
    throw new PipelineAbort();
  }
  if (effectiveImage && backend === "codex" && !hasContainerCodexAuth(envVars)) {
    await r.error(
      "Containerized Codex requires auth available inside the container. " +
      "Set OPENAI_API_KEY in the selected environment, or ensure ~/.codex/auth.json exists on the host.",
      400,
    );
    throw new PipelineAbort();
  }

  if (effectiveImage) {
    // ── 4a. Ensure image is available ───────────────────────────────────
    if (!imagePullManager.isReady(effectiveImage)) {
      const pullState = imagePullManager.getState(effectiveImage);
      if (pullState.status === "idle" || pullState.status === "error") {
        imagePullManager.ensureImage(effectiveImage);
      }

      await r.progress("pulling_image", "Pulling Docker image...", "in_progress");

      // Stream pull progress if the reporter supports it
      const unsub = r.onImagePullProgress
        ? r.onImagePullProgress(effectiveImage, (line) => {
            r.progress("pulling_image", "Pulling Docker image...", "in_progress", line).catch(() => {});
          })
        : null;

      const ready = await imagePullManager.waitForReady(effectiveImage, 300_000);
      unsub?.();

      if (ready) {
        await r.progress("pulling_image", "Image ready", "done");
      } else {
        const state = imagePullManager.getState(effectiveImage);
        await r.error(
          state.error ||
          `Docker image ${effectiveImage} could not be pulled or built. Use the environment manager to pull/build the image first.`,
          503,
          "pulling_image",
        );
        throw new PipelineAbort();
      }
    }

    // ── 4b. Create container ────────────────────────────────────────────
    await r.progress("creating_container", "Starting container...", "in_progress");

    const tempId = crypto.randomUUID().slice(0, 8);
    const requestedPorts = companionEnv?.ports
      ?? (Array.isArray(body.container?.ports)
        ? body.container!.ports.map(Number).filter((n: number) => n > 0)
        : []);
    const containerPorts = Array.from(
      new Set([
        ...requestedPorts,
        editorContainerPort,
        ...(backend === "codex" ? [codexAppServerContainerPort] : []),
      ]),
    );
    const cConfig: ContainerConfig = {
      image: effectiveImage,
      ports: containerPorts,
      volumes: companionEnv?.volumes ?? body.container?.volumes,
      env: envVars,
    };

    try {
      containerInfo = containerManager.createContainer(tempId, cwd!, cConfig);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await r.error(
        `Docker is required to run this environment image (${effectiveImage}) ` +
        `but container startup failed: ${reason}`,
        503,
        "creating_container",
      );
      throw new PipelineAbort();
    }
    containerId = containerInfo.containerId;
    containerName = containerInfo.name;
    containerImage = effectiveImage;

    await r.progress("creating_container", "Container running", "done");

    // ── 4c. Copy workspace ──────────────────────────────────────────────
    await r.progress("copying_workspace", "Copying workspace files...", "in_progress");
    try {
      await containerManager.copyWorkspaceToContainer(containerInfo.containerId, cwd!);
      containerManager.reseedGitAuth(containerInfo.containerId);
      await r.progress("copying_workspace", "Workspace copied", "done");
    } catch (err) {
      containerManager.removeContainer(tempId);
      const reason = err instanceof Error ? err.message : String(err);
      await r.error(`Failed to copy workspace to container: ${reason}`, 503, "copying_workspace");
      throw new PipelineAbort();
    }

    // ── 4d. Init script ─────────────────────────────────────────────────
    if (companionEnv?.initScript?.trim()) {
      await r.progress("running_init_script", "Running init script...", "in_progress");
      try {
        console.log(
          `[session-pipeline] Running init script for env "${companionEnv.name}" in container ${containerInfo.name}...`,
        );
        const initTimeout = Number(process.env.COMPANION_INIT_SCRIPT_TIMEOUT) || 120_000;
        const result = await containerManager.execInContainerAsync(
          containerInfo.containerId,
          ["sh", "-lc", companionEnv.initScript],
          {
            timeout: initTimeout,
            onOutput: r.onInitScriptOutput,
          },
        );
        if (result.exitCode !== 0) {
          console.error(
            `[session-pipeline] Init script failed for env "${companionEnv.name}" (exit ${result.exitCode}):\n${result.output}`,
          );
          containerManager.removeContainer(tempId);
          const truncated =
            result.output.length > 2000
              ? result.output.slice(0, 500) + "\n...[truncated]...\n" + result.output.slice(-1500)
              : result.output;
          await r.error(
            `Init script failed (exit ${result.exitCode}):\n${truncated}`,
            503,
            "running_init_script",
          );
          throw new PipelineAbort();
        }
        console.log(`[session-pipeline] Init script completed successfully for env "${companionEnv.name}"`);
        await r.progress("running_init_script", "Init script complete", "done");
      } catch (e) {
        if (e instanceof PipelineAbort) throw e;
        containerManager.removeContainer(tempId);
        const reason = e instanceof Error ? e.message : String(e);
        await r.error(`Init script execution failed: ${reason}`, 503, "running_init_script");
        throw new PipelineAbort();
      }
    }
  }

  // ── 5. Launch CLI ───────────────────────────────────────────────────────

  await r.progress("launching_cli", "Launching Claude Code...", "in_progress");

  const session = launcher.launch({
    model: body.model,
    permissionMode: body.permissionMode,
    cwd,
    claudeBinary: body.claudeBinary,
    codexBinary: body.codexBinary,
    codexInternetAccess: backend === "codex",
    codexSandbox: backend === "codex" ? "danger-full-access" : undefined,
    allowedTools: body.allowedTools,
    env: envVars,
    backendType: backend,
    containerId,
    containerName,
    containerImage,
    containerCwd: containerInfo?.containerCwd,
    resumeSessionAt,
    forkSession,
  });

  // ── 6. Post-launch bookkeeping ──────────────────────────────────────────

  if (containerInfo) {
    containerManager.retrack(containerInfo.containerId, session.sessionId);
    wsBridge.markContainerized(session.sessionId, cwd!);
  }

  if (worktreeInfo) {
    worktreeTracker.addMapping({
      sessionId: session.sessionId,
      repoRoot: worktreeInfo.repoRoot,
      branch: worktreeInfo.branch,
      actualBranch: worktreeInfo.actualBranch,
      worktreePath: worktreeInfo.worktreePath,
      createdAt: Date.now(),
    });
  }

  await r.progress("launching_cli", "Session started", "done");

  return { session, worktreeInfo, containerInfo, cwd: cwd! };
}
