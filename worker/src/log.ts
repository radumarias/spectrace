export type Level = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, unknown>;

/**
 * Structured logging: one JSON object per line, picked up by Workers Logs.
 * `LOG_FORMAT=pretty` prints a readable line for local work.
 * This is the only file allowed to use `console`.
 */
export function log(level: Level, message: string, fields: Fields = {}, format = "json"): void {
  const out = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (format === "pretty") {
    const extra = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : "";
    out(`${level.toUpperCase()} ${message}${extra}`);
  } else {
    out(JSON.stringify({ level, message, ...fields }));
  }
}
