/**
 * The one page of `yoink-bridge/cloudflare`: a landing page at `GET /` with a
 * QR code and link that open yoink with the bridge URL filled in, and a hint
 * while the key is missing. No secrets, no forms, no scripts, no third-party
 * assets.
 */
export type Lang = 'en' | 'de';

/** German when the browser prefers it, English otherwise. */
export function pickLanguage(acceptLanguage: string | null): Lang {
  if (!acceptLanguage) return 'en';
  const ranked = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().toLowerCase().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { tag, q: q ? Number(q.slice(2)) || 0 : 1 };
    })
    .filter((r) => r.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const { tag } of ranked) {
    if (tag === 'de' || tag.startsWith('de-')) return 'de';
    if (tag === 'en' || tag.startsWith('en-')) return 'en';
  }
  return 'en';
}

const STRINGS = {
  en: {
    running: 'This yoink bridge is running.',
    connect: 'Connect yoink',
    steps:
      'On your iPhone, tap the button or scan the QR code: yoink opens with this bridge’s address and connects ' +
      'with the key it created when you set up the bridge. Or enter this address in yoink yourself.',
    open: 'Open in yoink',
    noKey: 'This page never shows the key.',
    qr: 'QR code that opens yoink with this bridge’s address',
    keyMissing: 'The key is missing: YOINK_SECRET is not set, so yoink can’t connect yet.',
    keyInvalid: 'YOINK_SECRET is not a valid key. It starts with whsec_, exactly as yoink copies it.',
    keyHowTo:
      'In yoink: Settings › Outputs › Set up bridge › Copy key. Then in Cloudflare: Workers & Pages › this Worker › ' +
      'Settings › Variables and Secrets › Add, type “Secret”, name YOINK_SECRET, paste the key, Deploy.',
    keySettings: 'Open this Worker’s settings',
    notFound: 'Not found.',
  },
  de: {
    running: 'Diese yoink-Bridge läuft.',
    connect: 'yoink verbinden',
    steps:
      'Auf dem iPhone den Button antippen oder den QR-Code scannen: yoink öffnet sich mit der Adresse dieser Bridge ' +
      'und verbindet sich mit dem Schlüssel, den es beim Einrichten erzeugt hat. Oder die Adresse in yoink selbst eingeben.',
    open: 'In yoink öffnen',
    noKey: 'Diese Seite zeigt den Schlüssel nie.',
    qr: 'QR-Code, der yoink mit der Adresse dieser Bridge öffnet',
    keyMissing: 'Der Schlüssel fehlt: YOINK_SECRET ist nicht gesetzt, darum kann yoink sich noch nicht verbinden.',
    keyInvalid: 'YOINK_SECRET ist kein gültiger Schlüssel. Er beginnt mit whsec_, genau so, wie yoink ihn kopiert.',
    keyHowTo:
      'In yoink: Einstellungen › Ausgänge › Bridge einrichten › Schlüssel kopieren. Dann in Cloudflare: Workers & Pages › ' +
      'dieser Worker › Settings › Variables and Secrets › Add, Typ „Secret“, Name YOINK_SECRET, Schlüssel einfügen, Deploy.',
    keySettings: 'Einstellungen dieses Workers öffnen',
    notFound: 'Nicht gefunden.',
  },
} as const;

export function strings(lang: Lang) {
  return STRINGS[lang];
}

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const STYLE = `
:root{color-scheme:light dark;--fg:#1d1d1f;--bg:#fff;--muted:#6e6e73;--accent:#0a66d6}
@media (prefers-color-scheme:dark){:root{--fg:#f5f5f7;--bg:#111;--muted:#a1a1a6;--accent:#4c9bff}}
body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:36rem;margin:0 auto;padding:2rem 1.25rem 3rem}h1{font-size:1.5rem;margin:0 0 .5rem}h2{font-size:1.1rem;margin:1.75rem 0 .5rem}
.muted{color:var(--muted)}a{color:var(--accent)}code{font:14px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
.warn{border:1px solid #d70;border-radius:8px;padding:.75rem 1rem;margin:1rem 0}
.qr{width:13rem;max-width:100%;margin:1rem 0;border-radius:8px;overflow:hidden}.qr svg{display:block;width:100%;height:auto}
a.button{display:inline-block;padding:.6rem 1rem;border-radius:8px;background:var(--accent);color:#fff;text-decoration:none}
`;

/** Security headers; the nonce allows the one inline style. */
export function pageHeaders(nonce: string): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow',
    'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  };
}

export interface LandingView {
  /** Bridge name, if any. */
  name?: string;
  /** The bridge URL yoink connects to. */
  url: string;
  /** `yoink://ausgang?v=1&url=…&name=…`, without a key. */
  link: string;
  qrSvg: string;
  /** Set while `YOINK_SECRET` is missing or not a valid key. */
  keyProblem?: 'missing' | 'invalid';
  /** Dashboard link to this Worker's settings, if known. */
  settingsUrl?: string;
}

export function renderLanding(lang: Lang, view: LandingView, nonce: string): string {
  const t = strings(lang);
  const title = view.name ? `${view.name} · yoink bridge` : 'yoink bridge';
  return (
    `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">` +
    `<title>${escapeHtml(title)}</title><style nonce="${nonce}">${STYLE}</style></head><body><main>` +
    `<h1>${escapeHtml(view.name ?? 'yoink bridge')}</h1><p class="muted">${t.running}</p>` +
    (view.keyProblem ? keyWarning(t, view) : '') +
    `<h2>${t.connect}</h2><p>${t.steps}</p>` +
    `<p><a class="button" href="${escapeHtml(view.link)}">${t.open}</a></p>` +
    `<div class="qr" role="img" aria-label="${escapeHtml(t.qr)}">${view.qrSvg}</div>` +
    `<p><code>${escapeHtml(view.url)}</code></p><p class="muted">${t.noKey}</p>` +
    `</main></body></html>`
  );
}

function keyWarning(t: ReturnType<typeof strings>, view: LandingView): string {
  const settings = view.settingsUrl ? ` <a href="${escapeHtml(view.settingsUrl)}">${t.keySettings}</a>` : '';
  return (
    `<div class="warn" role="alert"><p><strong>${view.keyProblem === 'invalid' ? t.keyInvalid : t.keyMissing}</strong></p>` +
    `<p>${t.keyHowTo}${settings}</p></div>`
  );
}

/**
 * Dashboard link to this Worker's settings (where its secrets are added). On
 * `<worker>.<subdomain>.workers.dev` the Worker name is known; otherwise
 * there is no reliable link. `:account` lets the dashboard pick the account.
 */
export function dashboardLink(hostname: string): string | undefined {
  const match = /^([a-z0-9-]+)\.[a-z0-9-]+\.workers\.dev$/i.exec(hostname);
  return match
    ? `https://dash.cloudflare.com/?to=/:account/workers/services/view/${match[1]!.toLowerCase()}/production/settings`
    : undefined;
}
