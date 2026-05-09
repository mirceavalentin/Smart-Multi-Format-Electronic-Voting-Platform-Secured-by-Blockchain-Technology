/**
 * logger.ts — Lightweight structured console logger.
 *
 * A thin wrapper around `console` that prepends a `[nodeName]` tag and a
 * severity marker to every line. In a multi-container deployment, each
 * container writes to its own stdout, so the node name prefix makes it
 * trivial to identify the source of any log line when viewing aggregated
 * logs (e.g. `podman-compose logs -f`).
 *
 * Usage:
 *   const log = createLogger("gateway");
 *   log.info("Server started");      // [gateway] Server started
 *   log.warn("Peer disconnected");   // [gateway] ⚠ Peer disconnected
 *   log.error("DB write failed");    // [gateway] ✘ DB write failed
 */

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function createLogger(nodeName: string): Logger {
  const tag = `[${nodeName}]`;
  return {
    info:  (msg) => console.log(`${tag} ${msg}`),
    warn:  (msg) => console.warn(`${tag} ⚠ ${msg}`),
    error: (msg) => console.error(`${tag} ✘ ${msg}`),
  };
}
