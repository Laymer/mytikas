import { config } from "./config.js";
import { createPool } from "./db.js";
import { createApp } from "./app.js";
const cfg = config(),
  pool = createPool(cfg.databaseUrl);
const server = createApp(pool, cfg).listen(cfg.port, "0.0.0.0", () =>
  console.log(`Mytikas listening at ${cfg.origin}`),
);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => {
      console.error("Web shutdown deadline exceeded");
      process.exit(1);
    }, 30000);
    server.close(() => {
      void pool.end().then(() => clearTimeout(deadline)).catch(() => process.exit(1));
    });
  });
