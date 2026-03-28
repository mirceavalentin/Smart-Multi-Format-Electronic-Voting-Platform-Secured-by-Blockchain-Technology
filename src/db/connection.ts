/**
 * ============================================================================
 *  db/connection.ts — MongoDB connection manager.
 * ============================================================================
 *
 * Provides a single `connectToDatabase()` function that the server entry
 * point calls before starting the HTTP listener.
 *
 * WHY A DEDICATED CONNECTION MODULE?
 *
 * Separation of concerns: the Express server shouldn't know *how* to
 * connect to MongoDB or what retry policy to use. Extracting this logic
 * into its own module makes it independently testable and swappable
 * (e.g. for an in-memory DB during unit tests).
 *
 * WHY RETRY LOGIC?
 *
 * In a containerised (Podman / Docker) environment the Node.js app
 * container often starts before MongoDB has finished its initialisation
 * sequence (journal allocation, WiredTiger cache warm-up, etc.).
 * During that window, `mongoose.connect()` throws ECONNREFUSED and
 * the process crashes — killing the container.
 *
 * The docker-compose `depends_on: { condition: service_healthy }` block
 * mitigates this at the orchestrator level, but defence-in-depth
 * requires that the application ALSO handles transient failures.
 * This retry loop provides that second safety net.
 * ============================================================================
 */

import mongoose from "mongoose";

/**
 * Connect to MongoDB with exponential back-off retry logic.
 *
 * @param uri        - The full MongoDB connection string
 *                     (e.g. "mongodb://gateway-db:27017/voting_node_db").
 * @param maxRetries - How many times to attempt the connection before
 *                     giving up and letting the process crash.
 * @param delayMs    - Initial delay between retries in milliseconds.
 */
export async function connectToDatabase(
  uri: string,
  maxRetries: number = 10,
  delayMs: number = 3000,
): Promise<void> {
  const nodeName = process.env["NODE_NAME"] ?? "node";

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await mongoose.connect(uri);
      console.log(`[${nodeName}] ✔ Connected to MongoDB at ${uri}`);
      return;
    } catch (err) {
      console.warn(
        `[${nodeName}] MongoDB connection attempt ${attempt}/${maxRetries} failed. ` +
          `Retrying in ${delayMs / 1000}s...`,
      );
      if (attempt === maxRetries) {
        console.error(
          `[${nodeName}] ✘ Could not connect to MongoDB after ${maxRetries} attempts.`,
        );
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
