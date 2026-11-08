const guild = { discordUrl: null, faction: null, focus: null, language: null, schedule: null, requirements: null };
const lore = `The Ascent of Mytikas

(A record found in the ashes of a burned-out camp above the ridge, written in the old tongue of the first Olympus)

They called us the ones who never came back down.

When the King first raised the banner of Olympus and the lower slopes filled with tens of thousands, he did not need another host. He needed the peak. He needed the small band that could be sent into the dark places of the mountain and return with the work already finished. He named us for the true summit — Mytikas — and gave us one order that never changed: remove what must be removed, and leave no banner behind.

We were never listed among the numbered guilds. We wore no tabard in the open. When the great crowds gathered in the cities of the lowlands and the trade channels choked with the name of Olympus, we were already elsewhere. A rival company that had begun to hunt the King’s own. A Lord who had started to speak as though the mountain belonged to him. An entire raid night that had been marked for slaughter by those who hated the banner. We arrived without announcement. We left nothing that could be clipped or counted. The mountain simply continued, and certain names were no longer spoken.

Then the order came from the summit itself.
The King commanded that Mytikas would not march with the rest. The lower slopes would be rebuilt in the open, loud and countless, so that every eye in Azeroth would watch the army rise. The peak would remain empty. We were ordered to scatter, to let our old names die, and to wait until the true mountain was high enough. No messages. No signals. No trace. For a long time the rest of Olympus believed the summit had simply never existed, or that we had been lost when the lower camps were remade.

We were not lost.

While the lower guilds argued over names and banners, we climbed in silence on new flesh. We watched the paths the enemies of the King were already marking for the first nights of the true world. We learned the exact hours the crowds would be loudest, the exact moments the mountain would be watched by everyone and guarded by no one.

Tonight the world opens.

The lower slopes will fill again. The numbered guilds will form in the open, banners high, the King at their head. Every eye will be on the range. None will be on the summit.
We are Mytikas. We were never missing. We were waiting for the mountain to be high enough that only the ones who were meant to see the peak would look up and find us already there. The King’s signal has been given. The work begins again.`;
const article = document.querySelector('#lore');
if (!article.children.length) lore.split('\n\n').forEach(text => { const p = document.createElement('p'); p.textContent = text; article.append(p); });
const recruitment = document.querySelector('#recruitment-content');
Object.entries(guild).filter(([key,value]) => key !== 'discordUrl' && value).forEach(([key,value]) => { const p = document.createElement('p'); p.textContent = `${key}: ${value}`; recruitment.append(p); });
