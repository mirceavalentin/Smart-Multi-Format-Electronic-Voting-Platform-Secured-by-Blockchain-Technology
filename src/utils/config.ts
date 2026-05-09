/**
 * config.ts — Centralised environment variable parsing.
 *
 * All env vars are read and validated in one place at startup.
 * Having a single config object makes it easy to see every knob a node
 * exposes, avoids scattered `process.env` lookups throughout the codebase,
 * and makes tests easier to set up (just mock `loadConfig()`).
 */

export interface NodeConfig {
  /** Human-readable name for this node, used in logs and queue names. */
  nodeName: string;

  /** TCP port the Express HTTP server listens on. */
  httpPort: number;

  /** Full MongoDB connection string for this node's database. */
  mongoUri: string;

  /** AMQP URL for the RabbitMQ broker, e.g. amqp://admin:admin@rabbitmq-1:5672 */
  rabbitmqUrl: string;

  /**
   * Whether this node acts as a block-producing Validator.
   * Gateways (IS_VALIDATOR=false) accept votes via HTTP and publish them
   * to RabbitMQ, but never mine blocks.
   */
  isValidator: boolean;

  /**
   * How often (in milliseconds) a Validator drains its mempool and
   * seals a new block. Default: 15 000 ms (15 seconds).
   */
  validatorIntervalMs: number;
}

/**
 * Read and parse all environment variables required by this node.
 * Called once during startup in server.ts.
 */
export function loadConfig(): NodeConfig {
  return {
    nodeName:            process.env["NODE_NAME"]            ?? "node-local",
    httpPort:            parseInt(process.env["PORT"] ?? process.env["HTTP_PORT"] ?? "3000", 10),
    mongoUri:            process.env["MONGO_URI"]            ?? "mongodb://localhost:27017/voting_node_db",
    rabbitmqUrl:         process.env["RABBITMQ_URL"]         ?? "amqp://admin:admin@localhost:5672",
    isValidator:         (process.env["IS_VALIDATOR"]        ?? "false") === "true",
    validatorIntervalMs: parseInt(process.env["VALIDATOR_INTERVAL_MS"] ?? "15000", 10),
  };
}
