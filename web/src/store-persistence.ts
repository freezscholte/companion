/**
 * LocalStorage persistence helpers for the Zustand store.
 *
 * Extracted from store.ts — these functions read initial state from
 * localStorage on app boot. They're pure functions with no store
 * dependency, making them easy to test in isolation.
 */

import type { QuickTerminalPlacement, DiffBase } from "./store-types.js";

export const AUTH_STORAGE_KEY = "companion_auth_token";

export function getInitialSessionNames(): Map<string, string> {
  if (typeof window === "undefined") return new Map();
  try {
    return new Map(JSON.parse(localStorage.getItem("cc-session-names") || "[]"));
  } catch {
    return new Map();
  }
}

export function getInitialSessionId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("cc-current-session") || null;
}

export function getInitialDarkMode(): boolean {
  if (typeof window === "undefined") return false;
  const stored = localStorage.getItem("cc-dark-mode");
  if (stored !== null) return stored === "true";
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function getInitialNotificationSound(): boolean {
  if (typeof window === "undefined") return true;
  const stored = localStorage.getItem("cc-notification-sound");
  if (stored !== null) return stored === "true";
  return true;
}

export function getInitialNotificationDesktop(): boolean {
  if (typeof window === "undefined") return false;
  const stored = localStorage.getItem("cc-notification-desktop");
  if (stored !== null) return stored === "true";
  return false;
}

export function getInitialDismissedVersion(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("cc-update-dismissed") || null;
}

export function getInitialCollapsedProjects(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    return new Set(JSON.parse(localStorage.getItem("cc-collapsed-projects") || "[]"));
  } catch {
    return new Set();
  }
}

export function getInitialQuickTerminalPlacement(): QuickTerminalPlacement {
  if (typeof window === "undefined") return "bottom";
  const stored = window.localStorage.getItem("cc-terminal-placement");
  if (stored === "top" || stored === "right" || stored === "bottom" || stored === "left") return stored;
  return "bottom";
}

export function getInitialDiffBase(): DiffBase {
  if (typeof window === "undefined") return "last-commit";
  const stored = window.localStorage.getItem("cc-diff-base");
  if (stored === "last-commit" || stored === "default-branch") return stored;
  return "last-commit";
}

export function getInitialAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(AUTH_STORAGE_KEY) || null;
}
