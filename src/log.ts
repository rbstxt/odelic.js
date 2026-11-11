/** Minimal leveled logger writing to stderr (stdout stays clean for the CLI output and MCP stdio). */

const LEVELS = { debug: 10, info: 20, warning: 30, error: 40, silent: 100 } as const;
export type LogLevel = keyof typeof LEVELS;

const isLevel = (v: string): v is LogLevel => Object.hasOwn(LEVELS, v);
const fromEnv = String(process.env.ODELIC_LOG ?? '').toLowerCase();
let current: number = isLevel(fromEnv) ? LEVELS[fromEnv] : LEVELS.warning;

export function setLogLevel(level: LogLevel): void {
  if (!isLevel(level)) throw new RangeError(`unknown log level ${level}`);
  current = LEVELS[level];
}

function emit(level: LogLevel, args: unknown[]): void {
  if (LEVELS[level] >= current) console.error('odelic:', ...args);
}

export const log = {
  debug: (...a: unknown[]) => emit('debug', a),
  info: (...a: unknown[]) => emit('info', a),
  warning: (...a: unknown[]) => emit('warning', a),
  error: (...a: unknown[]) => emit('error', a),
};
