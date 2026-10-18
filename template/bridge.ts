/**
 * Your yoink bridge: the destinations yoink may send entries to, and your own
 * code. This is the file to edit; the SDK is the npm package `yoink-bridge`
 * (https://github.com/Deadweight-Labs/yoink-bridge), updated by Dependabot.
 *
 * Each destination says, in plain words, what belongs there. yoink checks
 * every new entry against these descriptions and sends matches here, where
 * the destination's onEntry handles them. Edit, commit, and Workers Builds
 * deploys it; yoink picks up the change on "Ziele aktualisieren" (or within
 * about 6 hours).
 *
 * A destination is active once its settings exist (`requires`). Until then
 * yoink shows it greyed out, "wartet auf GITHUB_TOKEN, GITHUB_REPO", with a
 * link to this Worker's settings. Add settings in the Cloudflare dashboard
 * (Workers & Pages → this Worker → Settings → Variables and Secrets), never
 * in this file.
 *
 * Descriptions: say what belongs *and* what doesn't, describe the content
 * (not the tool), write in the language you capture in. More in README.md,
 * "Writing good descriptions".
 *
 * Edits after sending: when you change an entry's title, text or due date in
 * yoink after it went to a destination, yoink sends the change (2 minutes
 * after your last edit) to that destination's onUpdate. Linear and GitHub
 * add it as a comment ("In yoink geändert"); the issue itself is never
 * overwritten. A destination without onUpdate answers 501, and yoink stops
 * sending it updates for that entry.
 */
import { defineWorkerBridge, type WorkerEnv } from 'yoink-bridge/cloudflare';
import { github } from 'yoink-bridge/presets/github';
import { linear } from 'yoink-bridge/presets/linear';
// For your own code (see the end of this file):
// import { BridgeError } from 'yoink-bridge';
// For a recipe (see recipes/):
// import { routerDestinations } from './recipes/router.ts';

/** This Worker's settings (KEY_FROM_YOINK_APP and BRIDGE_KV come with WorkerEnv). */
interface Env extends WorkerEnv {
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  LINEAR_API_KEY?: string;
  LINEAR_TEAM?: string;
}

export default defineWorkerBridge<Env>({
  name: 'Meine Bridge',

  destinations: (env) => ({
    // Two trackers in one group: an entry goes to at most one of them (yoink
    // asks "Linear, GitHub or neither?"). If you use both, sharpen the two
    // descriptions so they say which work belongs where, e.g. "nur die App"
    // vs. "nur die Website". A destination without a group (say, Slack) is
    // checked on its own and can get an entry in addition.
    //
    // mode 'suggest': yoink only suggests; you confirm with one tap. Switch to
    // 'auto' once the description fits your work.
    linear: {
      name: 'Linear',
      description:
        'Konkrete Aufgaben und Fehler in einem Software-Projekt – etwas, das man bauen oder reparieren kann. ' +
        'Keine Ideen ohne klaren nächsten Schritt, keine privaten Notizen, keine Einkäufe.',
      group: 'tracker',
      mode: 'suggest',
      requires: ['LINEAR_API_KEY', 'LINEAR_TEAM'],
      // Creates the issue, answers its link ("ABC-12 ↗"), archives it on
      // "Zurückziehen", comments on it when you edit the entry in yoink.
      ...linear({ apiKey: env.LINEAR_API_KEY, team: env.LINEAR_TEAM }),
    },

    github: {
      name: 'GitHub · Issues',
      description:
        'Konkrete Aufgaben und Fehler in einem Software-Projekt – etwas, das man bauen oder reparieren kann. ' +
        'Keine Ideen ohne klaren nächsten Schritt, keine privaten Notizen, keine Einkäufe.',
      group: 'tracker',
      mode: 'suggest',
      requires: ['GITHUB_TOKEN', 'GITHUB_REPO'],
      // Creates the issue, answers its link ("#12 ↗"), closes it as "not
      // planned" on "Zurückziehen", comments on it when you edit the entry in yoink.
      ...github({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPO }),
    },

    // A recipe: an `inbox` that gets every new entry (mode 'all') and sorts it
    // with Claude, using your ANTHROPIC_API_KEY. Read recipes/router.ts, add
    // ANTHROPIC_API_KEY to Env above, then uncomment this line and its import.
    // ...routerDestinations(env),

    // Your own destination: a few lines of code. Return { url, label,
    // external_id } (all optional) and yoink shows it on the entry; throw
    // `new BridgeError(status, message)` for a specific answer (4xx: final,
    // 5xx: yoink tries again later). More in recipes/custom-handler.ts.
    //
    // notes: {
    //   name: 'Notizen',
    //   description: 'Längere Gedanken und Notizen zu Büchern. Keine Aufgaben, keine Einkäufe.',
    //   requires: ['NOTES_TOKEN'], // add NOTES_TOKEN to Env above
    //   async onEntry(event) {
    //     const { entry } = event.data;
    //     const res = await fetch('https://notes.example/api/pages', {
    //       method: 'POST',
    //       headers: { authorization: `Bearer ${env.NOTES_TOKEN}`, 'content-type': 'application/json' },
    //       body: JSON.stringify({ title: entry.title ?? entry.text.split('\n')[0], body: entry.text }),
    //     });
    //     if (!res.ok) throw new BridgeError(502, `notes answered ${res.status}`);
    //     const page = (await res.json()) as { id: string; url: string };
    //     return { url: page.url, label: 'Notiz', external_id: page.id }; // external_id enables "Zurückziehen"
    //   },
    //   async onUndo(event) {
    //     await fetch(`https://notes.example/api/pages/${event.data.external_id}`, { method: 'DELETE' });
    //   },
    //   // Optional: edited in yoink after sending. Leave it out to answer 501 (no updates).
    //   // async onUpdate(event) {
    //   //   const { external_id, entry, changes } = event.data; // changes: 'title' | 'text' | 'due'
    //   //   …
    //   // },
    // },
  }),
});
