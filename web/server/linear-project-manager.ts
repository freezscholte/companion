import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export interface LinearProjectMapping {
  /** Normalized git repo root path (the key) */
  repoRoot: string;
  /** Linear team UUID */
  teamId: string;
  /** Human-readable team key, e.g. "ENG" */
  teamKey: string;
  /** Human-readable team name, e.g. "Engineering" */
  teamName: string;
  /** When the mapping was created */
  createdAt: number;
  /** When the mapping was last updated */
  updatedAt: number;
}

const DEFAULT_PATH = join(homedir(), ".companion", "linear-projects.json");

let loaded = false;
let filePath = DEFAULT_PATH;
let mappings: LinearProjectMapping[] = [];

function normalizeRoot(root: string): string {
  return root.replace(/\/+$/, "") || "/";
}

function ensureLoaded(): void {
  if (loaded) return;
  try {
    if (existsSync(filePath)) {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      if (Array.isArray(raw)) {
        mappings = raw.filter(
          (m: unknown): m is LinearProjectMapping =>
            typeof m === "object" &&
            m !== null &&
            typeof (m as LinearProjectMapping).repoRoot === "string" &&
            typeof (m as LinearProjectMapping).teamId === "string",
        );
      } else {
        mappings = [];
      }
    }
  } catch {
    mappings = [];
  }
  loaded = true;
}

function persist(): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(mappings, null, 2), "utf-8");
}

export function listMappings(): LinearProjectMapping[] {
  ensureLoaded();
  return [...mappings];
}

export function getMapping(repoRoot: string): LinearProjectMapping | null {
  ensureLoaded();
  const key = normalizeRoot(repoRoot);
  return mappings.find((m) => m.repoRoot === key) ?? null;
}

export function upsertMapping(
  repoRoot: string,
  data: { teamId: string; teamKey: string; teamName: string },
): LinearProjectMapping {
  ensureLoaded();
  const key = normalizeRoot(repoRoot);
  const now = Date.now();
  const existing = mappings.find((m) => m.repoRoot === key);
  if (existing) {
    existing.teamId = data.teamId;
    existing.teamKey = data.teamKey;
    existing.teamName = data.teamName;
    existing.updatedAt = now;
  } else {
    mappings.push({
      repoRoot: key,
      teamId: data.teamId,
      teamKey: data.teamKey,
      teamName: data.teamName,
      createdAt: now,
      updatedAt: now,
    });
  }
  persist();
  return mappings.find((m) => m.repoRoot === key)!;
}

export function removeMapping(repoRoot: string): boolean {
  ensureLoaded();
  const key = normalizeRoot(repoRoot);
  const idx = mappings.findIndex((m) => m.repoRoot === key);
  if (idx === -1) return false;
  mappings.splice(idx, 1);
  persist();
  return true;
}

export function _resetForTest(customPath?: string): void {
  loaded = false;
  filePath = customPath || DEFAULT_PATH;
  mappings = [];
}
