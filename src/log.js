/** Minimal leveled logger writing to stderr (stdout stays clean for the CLI output and MCP stdio). */

const LEVELS = { debug: 10, info: 20, warning: 30, error: 40, silent: 100 };
let current = LEVELS[String(process.env.ODELIC_LOG || '').toLowerCase()] ?? LEVELS.warning;

export function setLogLevel(level) {
  if (!(level in LEVELS)) throw new RangeError(`unknown log level ${level}`);
  current = LEVELS[level];
}

function emit(level, args) {
  if (LEVELS[level] >= current) console.error('odelic:', ...args);
}

export const log = {
  debug: (...a) => emit('debug', a),
  info: (...a) => emit('info', a),
  warning: (...a) => emit('warning', a),
  error: (...a) => emit('error', a),
};
