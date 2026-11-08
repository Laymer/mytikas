import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
const password = randomBytes(32).toString("hex"),
  session = randomBytes(48).toString("hex");
const content = `POSTGRES_USER=mytikas\nPOSTGRES_DB=mytikas\nPOSTGRES_PASSWORD=${password}\nDATABASE_URL=postgres://mytikas:${password}@localhost:5432/mytikas\nSESSION_SECRET=${session}\nAPP_ORIGIN=http://localhost:8080\nPORT=8080\nDISCORD_WEBHOOK_URL=\n`;
try {
  await writeFile(".env", content, { flag: "wx", mode: 0o600 });
  console.log(
    "Created .env with local secrets. Existing files are never overwritten.",
  );
} catch (error) {
  if (error.code === "EEXIST") {
    console.error(".env already exists; left unchanged.");
    process.exitCode = 1;
  } else throw error;
}
