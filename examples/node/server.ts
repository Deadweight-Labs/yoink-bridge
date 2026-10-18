// Minimal Node bridge. Run it behind HTTPS (yoink only delivers to https://),
// e.g. with Caddy, a Cloudflare Tunnel or Tailscale Funnel in front.
//
//   node --env-file=.env examples/node/server.ts      # Node 22.18+, no build step
//
// .env (git-ignored) holds KEY_FROM_YOINK_APP: the key yoink created (Einstellungen ›
// Ausgänge › Bridge einrichten › Schlüssel kopieren), or `npm run cli -- keygen`
// for a local test.
//
// In your own project, `npm install yoink-bridge` and import from
// 'yoink-bridge' and 'yoink-bridge/node' instead of ../../src.
import { createServer } from 'node:http';
import { createBridge, describeBridge } from '../../src/index.ts';
import { toNodeHandler } from '../../src/node.ts';

const secret = process.env.KEY_FROM_YOINK_APP;
if (!secret) {
  console.error('Set KEY_FROM_YOINK_APP: the key from yoink (Einstellungen › Ausgänge › Bridge einrichten › Schlüssel kopieren).');
  process.exit(1);
}

const bridge = createBridge({
  secret,
  name: 'Home server',
  destinations: {
    reading: {
      name: 'Reading list',
      description:
        'Articles, papers and long reads to read later, usually a shared link. ' +
        'Not videos, not things to buy.',
      async onEntry(event, ctx) {
        const { entry } = event.data;
        // ---- your code here ----
        console.log(`[${ctx.id}] reading: ${entry.source_url ?? entry.title ?? entry.text}`);
        return { label: 'Saved', external_id: entry.id };
        // ---- end of your code ----
      },
      async onUndo(event) {
        console.log(`withdraw ${event.data.external_id}`);
      },
    },
  },
});

// Prints the destinations exactly as yoink will read them.
console.log(describeBridge(bridge));

const port = Number(process.env.PORT ?? 8787);
createServer(toNodeHandler(bridge)).listen(port, () => {
  console.log(`yoink bridge listening on http://localhost:${port}`);
});
