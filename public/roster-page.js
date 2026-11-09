import { api, $, message } from "./common.js";
import { renderRosters, rosterNavigation } from "./roster.js";
try {
  const me = await api("/api/auth/me");
  rosterNavigation(me);
  if (!me.canViewRosters)
    throw new Error(
      "Sign in with confirmed guild membership to view Raid Roster.",
    );
  await renderRosters($("#workspace"));
} catch (e) {
  $("#workspace").replaceChildren();
  message(e.message);
}
