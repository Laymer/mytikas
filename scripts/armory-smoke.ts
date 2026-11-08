import {
  profileUrl,
  parseProfile,
  membershipResult,
  limitedText,
} from "../src/armory.js";
const name = process.argv.slice(2).join(" ") || "Xaryu Forever";
console.log(`LIVE armory smoke check: ${profileUrl(name)}`);
try {
  const response = await fetch(profileUrl(name), {
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: {
      "User-Agent": "Mytikas-local-prototype/1.0",
      Accept: "text/html",
    },
  });
  console.log(`HTTP ${response.status}`);
  if (!response.ok) {
    await response.body?.cancel();
    process.exitCode = 1;
  } else {
    const c = parseProfile(await limitedText(response, 2_000_000));
    console.log(
      JSON.stringify(
        {
          name: c.name,
          surname: c.surname,
          region: c.region,
          ruleset: c.ruleset?.slug,
          guild: c.guild?.name,
          result: membershipResult(c, name),
        },
        null,
        2,
      ),
    );
  }
} catch (e) {
  console.error(
    `Live check failed: ${e instanceof Error ? e.message : "unavailable"}`,
  );
  process.exitCode = 1;
}
