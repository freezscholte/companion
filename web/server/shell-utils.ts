/**
 * Shared shell utilities used across server modules.
 */

/** Escape a value for safe interpolation into a shell command string. */
export function shellEscapeArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
