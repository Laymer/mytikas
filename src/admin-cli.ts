import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { stdin, stdout } from "node:process";
import { config } from "./config.js";
import { createPool, transaction } from "./db.js";
import { email, password, HttpError } from "./validation.js";
import { hashPassword } from "./app.js";
if (!stdin.isTTY)
  throw new Error(
    "Run this interactive command in a terminal: docker compose exec app node dist/admin-cli.js",
  );
let hidden = false;
const output = new Writable({
  write(chunk, _encoding, callback) {
    if (!hidden) stdout.write(chunk);
    callback();
  },
});
const rl = createInterface({ input: stdin, output, terminal: true });
const pool = createPool(config().databaseUrl);
try {
  const address = email(await rl.question("First admin email: "));
  stdout.write("Password (12–128 characters, hidden): ");
  hidden = true;
  const pass = password(await rl.question(""));
  hidden = false;
  stdout.write("\n");
  stdout.write("Repeat password (hidden): ");
  hidden = true;
  const repeat = await rl.question("");
  hidden = false;
  stdout.write("\n");
  if (pass !== repeat) throw new Error("Passwords did not match.");
  const hash = await hashPassword(pass);
  await transaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(1)");
    if (
      (await c.query("SELECT 1 FROM users WHERE role='ADMIN' LIMIT 1")).rowCount
    )
      throw new HttpError(
        409,
        "An admin already exists. Use the admin panel to grant additional roles.",
      );
    await c.query(
      "INSERT INTO users(email,password_hash,role,activation_exempt) VALUES ($1,$2,'ADMIN',true)",
      [address, hash],
    );
  });
  console.log("First admin created. Sign in on /account.html.");
} catch (e) {
  hidden = false;
  console.error(e instanceof Error ? e.message : "Admin creation failed.");
  process.exitCode = 1;
} finally {
  rl.close();
  await pool.end();
}
