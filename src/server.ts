import { config } from "./config.js";
import { createPool } from "./db.js";
import { createApp } from "./app.js";
const cfg = config(),
  pool = createPool(cfg.databaseUrl);
const server = createApp(pool, cfg).listen(cfg.port, "0.0.0.0", () =>
  console.log(`Mytikas listening at ${cfg.origin}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    server.close(() => {
      void pool.end();
    });
  });
