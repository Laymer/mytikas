import { node, api, action, message } from "./common.js";
export const classes = {
  Warrior: "#C79C6E",
  Paladin: "#F58CBA",
  Hunter: "#ABD473",
  Rogue: "#FFF569",
  Priest: "#FFFFFF",
  Shaman: "#0070DE",
  Mage: "#69CCF0",
  Warlock: "#9482C9",
  Druid: "#FF7D0A",
};
export function rosterNavigation(me) {
  const nav = document.querySelector("header nav");
  nav.querySelector("[data-roster-link]")?.remove();
  if (me.canViewRosters) {
    const a = node("a", "Raid Roster");
    a.href = "/roster.html";
    a.dataset.rosterLink = "true";
    nav.append(a);
  }
}
export async function renderRosters(root, editable = false) {
  const [{ rosters }, membersData] = await Promise.all([
    api("/api/rosters"),
    editable
      ? api("/api/admin/roster-members")
      : Promise.resolve({ members: [] }),
  ]);
  root.replaceChildren(node("h2", "Raid Roster"));
  const legend = node("p", undefined, "meta");
  for (const [role, label] of [
    ["tank", "Tank (blue)"],
    ["healer", "Healer (green)"],
    ["dps", "DPS (red)"],
  ])
    legend.append(node("span", `● ${label} `, `role-dot role-${role}`));
  legend.append(node("span", "Each roster has five columns."));
  root.append(legend);
  const members = membersData.members;
  const redraws = [];
  async function refreshMembers() {
    const data = await api("/api/admin/roster-members");
    members.splice(0, members.length, ...data.members);
  }
  for (let saved of rosters) {
    const section = node("section", undefined, "card");
    root.append(section);
    let draft = structuredClone(saved.slots),
      busy = false;
    function draw() {
      section.replaceChildren(node("h3", `${saved.size} players`));
      const scroll = node("div", undefined, "roster-scroll");
      scroll.tabIndex = 0;
      scroll.setAttribute("role", "region");
      scroll.setAttribute(
        "aria-label",
        `${saved.size} player roster, scroll horizontally`,
      );
      const grid = node("div", undefined, "roster-grid");
      scroll.append(grid);
      section.append(scroll);
      for (const slot of draft) {
        const member = members.find((m) => m.id === slot.memberId),
          name = member?.character_name || slot.characterName,
          klass = member ? member.class : slot.class;
        const cell = node(
          editable ? "button" : "div",
          undefined,
          "roster-cell",
        );
        if (editable) cell.type = "button";
        const dot = node(
          "span",
          `● ${slot.role}`,
          `role-dot role-${slot.role.toLowerCase()}`,
        );
        const character = node(
          "strong",
          slot.memberId ? name : "Empty slot",
          `class-${klass || "unknown"}`,
        );
        cell.append(
          dot,
          character,
          node(
            "span",
            slot.memberId ? klass || "Unknown class" : "Unassigned",
            "meta",
          ),
        );
        cell.setAttribute(
          "aria-label",
          `Slot ${slot.position + 1}: ${slot.role}, ${slot.memberId ? name : "Empty slot"}, ${klass || "Unknown class"}`,
        );
        if (editable)
          cell.addEventListener("click", () => {
            if (!busy) edit(slot, cell);
          });
        grid.append(cell);
      }
      if (editable) {
        section.append(
          action("Save", async () => {
            if (busy) return;
            busy = true;
            try {
              const data = await api(`/api/admin/rosters/${saved.size}`, {
                revision: saved.revision,
                slots: draft.map(({ position, role, memberId }) => ({
                  position,
                  role,
                  memberId,
                })),
              });
              saved = data.rosters.find((r) => r.size === saved.size);
              draft = structuredClone(saved.slots);
              draw();
              message("Roster saved.", true);
            } finally {
              busy = false;
            }
          }),
          action("Cancel", async () => {
            if (busy) return;
            await refreshMembers();
            const data = await api("/api/rosters");
            saved = data.rosters.find((r) => r.size === saved.size);
            draft = structuredClone(saved.slots);
            draw();
          }),
        );
      }
    }
    function edit(slot, trigger) {
      const dialog = node("dialog"),
        form = node("form");
      const memberLabel = node("label", "Member"),
        select = node("select");
      select.id = "slot-member";
      memberLabel.htmlFor = select.id;
      const empty = node("option", "Empty slot");
      empty.value = "";
      select.append(empty);
      for (const m of members) {
        const option = node("option", m.character_name);
        option.value = m.id;
        option.disabled = draft.some(
          (s) => s.position !== slot.position && s.memberId === m.id,
        );
        select.append(option);
      }
      select.value = slot.memberId || "";
      const roleLabel = node("label", "Role"),
        role = node("select");
      role.id = "slot-role";
      roleLabel.htmlFor = role.id;
      for (const r of ["TANK", "HEALER", "DPS"]) {
        const o = node("option", r);
        o.value = r;
        role.append(o);
      }
      role.value = slot.role;
      const close = () => {
        dialog.close();
        dialog.remove();
        trigger.focus();
      };
      form.append(
        memberLabel,
        select,
        roleLabel,
        role,
        action("Apply to draft", async () => {
          slot.memberId = select.value || null;
          slot.role = role.value;
          slot.characterName =
            members.find((m) => m.id === slot.memberId)?.character_name || null;
          slot.class =
            members.find((m) => m.id === slot.memberId)?.class || null;
          close();
          draw();
          section.querySelectorAll(".roster-cell")[slot.position].focus();
        }),
        action("Cancel slot edit", async () => close()),
      );
      form.addEventListener("submit", (e) => e.preventDefault());
      dialog.addEventListener("cancel", () => {
        dialog.remove();
        trigger.focus();
      });
      dialog.append(form);
      document.body.append(dialog);
      dialog.showModal();
      select.focus();
    }
    redraws.push(draw);
    draw();
  }
  if (editable) {
    const section = node("section", undefined, "card");
    section.append(node("h3", "Member classes"));
    root.append(section);
    for (const member of members) {
      const row = node("div", undefined, "toolbar"),
        label = node("label", member.character_name),
        select = node("select");
      select.id = `class-${member.id}`;
      label.htmlFor = select.id;
      const auto = node("option", "Use armory class");
      auto.value = "";
      select.append(auto);
      for (const name of Object.keys(classes)) {
        const o = node("option", name);
        o.value = name;
        select.append(o);
      }
      select.value = member.class_override || "";
      row.append(
        label,
        select,
        node(
          "span",
          `Armory: ${member.armory_class || "Unknown"} · ${member.class_result || "Queued"}`,
          "meta",
        ),
        action("Save class", async () => {
          await api(`/api/admin/members/${member.id}/class`, {
            class: select.value || null,
          });
          await refreshMembers();
          for (const redraw of redraws) redraw();
        }),
        action("Refresh armory class", async () => {
          await api(`/api/admin/members/${member.id}/refresh-class`, {});
          message(
            "Class refresh queued. Manual overrides are preserved.",
            true,
          );
        }),
      );
      section.append(row);
    }
  }
}
