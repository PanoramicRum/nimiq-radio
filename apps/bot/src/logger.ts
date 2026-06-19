/** Minimal structured console logger — keeps the bot dependency-light (no pino). */
export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

function emit(stream: "log" | "warn" | "error", level: string, msg: string, fields?: Record<string, unknown>): void {
  const time = new Date().toISOString();
  const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
  console[stream](`${time} ${level} ${msg}${suffix}`);
}

export const logger: Logger = {
  info: (msg, fields) => emit("log", "INFO", msg, fields),
  warn: (msg, fields) => emit("warn", "WARN", msg, fields),
  error: (msg, fields) => emit("error", "ERROR", msg, fields),
};
