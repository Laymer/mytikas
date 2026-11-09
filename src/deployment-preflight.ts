import { config } from "./config.js";
import { createPool } from "./db.js";
import { schemaReady } from "./migrate.js";
import { smtpTransport, mailFailureCategory } from "./email.js";

// Never print exceptions: configuration and SMTP errors can contain credentials.
try {
  const cfg = config();
  const mode = process.argv[2];
  if (mode === "smtp") {
    const transport = smtpTransport(cfg);
    try { await transport.verify(); }
    catch (error) { console.error(`SMTP preflight failed: ${mailFailureCategory(error)}`); process.exitCode = 1; }
    finally { transport.close(); }
  } else if (mode === "schema") {
    const pool = createPool(cfg.databaseUrl);
    try { if (!await schemaReady(pool)) throw new Error("schema"); }
    finally { await pool.end(); }
  } else if (mode !== "config") throw new Error("mode");
  if (!process.exitCode) console.log("Candidate preflight passed.");
} catch {
  console.error("Candidate preflight failed; check protected configuration and schema. Use docs/PRODUCTION-ROLLOUT.md for staged upgrades.");
  process.exitCode = 1;
}
