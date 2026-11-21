import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Machine } from "./machine/core.mjs";

const idPattern = /^[1-9]\d{0,19}$/;
const hash = (text) => createHash("sha256").update(text).digest("hex");
class SetupError extends Error {}
function requireSetup(ok, message) {
  if (!ok) throw new SetupError(message);
}

function privateText(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    requireSetup(
      stat.isFile() &&
        stat.uid === process.getuid() &&
        (stat.mode & 0o777) === 0o600,
      "Use a regular owner-only file with mode 600.",
    );
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}
function syncDirectory(file) {
  const fd = fs.openSync(dirname(file), "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function replacePrivate(file, text) {
  const tmp = file + "." + randomUUID() + ".tmp";
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    syncDirectory(file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
async function reportSettings(machine, fetcher) {
  const input = JSON.parse(
    privateText(join(machine.home, "integrations", "member-home.json")),
  );
  const { DISCORD_GUILD_ID: guild, DISCORD_BOT_TOKEN: token } = input;
  requireSetup(
    typeof guild === "string" && idPattern.test(guild),
    "Set the numeric DISCORD_GUILD_ID in the private configuration.",
  );
  requireSetup(
    typeof token === "string" && token.length > 0 && !/\s|\0/.test(token),
    "Set DISCORD_BOT_TOKEN in the private configuration.",
  );
  let channel = input.DISCORD_BLACKLIST_CHANNEL_ID;
  if (channel === undefined || channel === "") {
    const response = await fetcher(
      "https://discord.com/api/v10/guilds/" + guild + "/channels",
      {
        headers: { Authorization: "Bot " + token },
        redirect: "error",
        signal: AbortSignal.timeout(12000),
      },
    );
    requireSetup(
      response.ok,
      "Discord could not list channels in the configured guild.",
    );
    const channels = await response.json();
    requireSetup(
      Array.isArray(channels),
      "Discord returned an invalid channel list.",
    );
    const matches = channels.filter(
      (c) =>
        c?.name === "blacklist" &&
        c.guild_id === guild &&
        [0, 5].includes(c.type),
    );
    requireSetup(
      matches.length === 1,
      "Set DISCORD_BLACKLIST_CHANNEL_ID explicitly. The guild must have exactly one matching #blacklist text channel for discovery.",
    );
    channel = matches[0].id;
  }
  requireSetup(
    typeof channel === "string" && idPattern.test(channel),
    "Set a numeric DISCORD_BLACKLIST_CHANNEL_ID.",
  );
  return {
    DISCORD_GUILD_ID: guild,
    DISCORD_BOT_TOKEN: token,
    DISCORD_BLACKLIST_CHANNEL_ID: channel,
  };
}
function preview(machine, d, settings) {
  const envArgs = Object.keys(settings).flatMap((key) => ["-e", key]);
  const raw = machine.dc(
    d,
    ["exec", "-T", ...envArgs, "worker", "node", "dist/blacklist-preview.js"],
    {
      env: { ...machine.env, ...settings },
      timeout: 1800000,
    },
  );
  const data = JSON.parse(raw),
    counts = {};
  for (const key of [
    "messages",
    "reports",
    "characters",
    "matchedApplications",
  ]) {
    requireSetup(
      Number.isSafeInteger(data[key]) && data[key] >= 0,
      "Preview returned invalid counts.",
    );
    counts[key] = data[key];
  }
  requireSetup(
    typeof data.lastId === "string" &&
      (data.lastId === "0" || idPattern.test(data.lastId)),
    "Preview returned an invalid message checkpoint.",
  );
  return { ...counts, lastId: data.lastId };
}

async function recreate(machine, d) {
  machine.dc(d, ["rm", "--stop", "--force", "tunnel"]);
  machine.dc(
    d,
    [
      "up",
      "-d",
      "--no-deps",
      "--force-recreate",
      "--no-build",
      "--wait",
      "--wait-timeout",
      "180",
      "app",
      "worker",
    ],
    { timeout: 240000 },
  );
  machine.dc(d, ["exec", "-T", "worker", "node", "dist/worker-health.js"]);
  machine.dc(d, ["up", "-d", "--no-deps", "--force-recreate", "tunnel"]);
  // The new connector may need time to register before the public route responds.
  for (let attempt = 1; ; attempt++) {
    try {
      await machine.publicCheck();
      return;
    } catch (error) {
      if (attempt === 12) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}
async function rollback(machine, d, marker) {
  const record = JSON.parse(privateText(marker));
  requireSetup(
    /^compose-before-blacklist-[a-f0-9-]{36}\.json$/.test(record.backup),
    "Invalid rollback record.",
  );
  const before = privateText(join(d.root, record.backup));
  requireSetup(
    hash(before) === record.beforeHash &&
      [record.beforeHash, record.candidateHash].includes(
        hash(privateText(d.compose)),
      ),
    "The deployment changed after activation began. Review the private backup before recovery.",
  );
  replacePrivate(d.compose, before);
  await recreate(machine, d);
  fs.unlinkSync(marker);
  syncDirectory(marker);
}

export async function blacklistHost(
  mode,
  home = join(homedir(), ".mytikas"),
  makeMachine = (dir) => new Machine(dir),
  fetcher = fetch,
) {
  requireSetup(
    mode === "preview" || mode === "enable",
    "Use preview or enable.",
  );
  const lock = join(home, "operation.lock");
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (e) {
    if (e.code === "EEXIST")
      throw new SetupError("Another managed operation holds the machine lock.");
    throw e;
  }
  try {
    const machine = makeMachine(home),
      d = machine.state.active;
    requireSetup(
      machine.state.phase === "active" &&
        d &&
        basename(d.compose) === "compose.json" &&
        dirname(d.compose) === d.root,
      "An active managed Compose deployment is required.",
    );
    const context = JSON.parse(
      machine.run("docker", ["context", "inspect", machine.state.context]),
    )[0];
    requireSetup(
      context?.Endpoints?.docker?.Host?.startsWith("unix://"),
      "Select the local managed Docker context.",
    );
    const marker = join(d.root, ".blacklist-enable-pending.json");
    if (fs.existsSync(marker)) {
      requireSetup(
        mode === "enable",
        "An interrupted enable requires recovery. Run enable to restore the prior configuration.",
      );
      await rollback(machine, d, marker);
      return { status: "restored" };
    }
    const original = privateText(d.compose),
      config = JSON.parse(original);
    const settings = await reportSettings(machine, fetcher);
    const counts = preview(machine, d, settings);
    if (mode === "preview")
      return {
        status: "preview",
        channelId: settings.DISCORD_BLACKLIST_CHANNEL_ID,
        ...counts,
      };
    let changed = false;
    for (const name of ["app", "worker"]) {
      const service = config.services[name].environment;
      const runtimeEnv = machine.inspect(machine.id(d, name)).Config.Env;
      requireSetup(
        service.MEMBERSHIP_DECISIONS_PAUSED === "1" &&
          runtimeEnv.includes("MEMBERSHIP_DECISIONS_PAUSED=1"),
        "Pause membership decisions on the running app and worker before enabling the import.",
      );
      for (const [key, value] of Object.entries(settings)) {
        if (name === "app" && key === "DISCORD_BLACKLIST_CHANNEL_ID") continue;
        // Compose interpolates dollars even inside a JSON string.
        const escaped = value.replaceAll("$", () => "$$");
        if (service[key] !== escaped || !runtimeEnv.includes(key + "=" + value))
          changed = true;
        service[key] = escaped;
      }
    }
    if (changed) {
      const candidate = JSON.stringify(config, null, 2) + "\n";
      const backup = "compose-before-blacklist-" + randomUUID() + ".json";
      replacePrivate(join(d.root, backup), original);
      replacePrivate(
        marker,
        JSON.stringify({
          backup,
          beforeHash: hash(original),
          candidateHash: hash(candidate),
        }),
      );
      try {
        replacePrivate(d.compose, candidate);
        machine.dc(d, ["config", "--quiet"]);
        await recreate(machine, d);
      } catch {
        await rollback(machine, d, marker);
        throw new SetupError(
          "Activation failed. The previous Compose configuration was restored and checked. Imported records remain in the database.",
        );
      }
      fs.unlinkSync(marker);
      syncDirectory(marker);
    }
    return {
      status: "enabled",
      channelId: settings.DISCORD_BLACKLIST_CHANNEL_ID,
      ...counts,
    };
  } finally {
    fs.rmdirSync(lock);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(JSON.stringify(await blacklistHost(process.argv[2])));
  } catch (error) {
    console.error(
      error instanceof SetupError
        ? error.message
        : "Managed blacklist operation failed. Check private configuration, worker preview and Docker health. Run enable to recover a pending change.",
    );
    process.exitCode = 1;
  }
}
