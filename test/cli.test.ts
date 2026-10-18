import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCheckArgs, validateCheckUrl } from '../src/check.ts';
import { secretFromEnvText, UsageError, type CliIO } from '../src/cli-shared.ts';
import { withSecretLine } from '../src/keygen.ts';
import { runCli } from '../src/run-cli.ts';
import { buildSetupLink, createBridge, describeBridge, generateSecret, secretProblem, signWebhook, verifyWebhook } from '../src/index.ts';
import pkg from '../package.json' with { type: 'json' };

const FIXED_SECRET = 'whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const fixedRandom = (n: number) => Uint8Array.from({ length: n }, (_, i) => i);

describe('generateSecret and secretProblem', () => {
  it('is whsec_ + base64 of 32 random bytes', () => {
    expect(generateSecret(fixedRandom)).toBe(FIXED_SECRET);
    const secret = generateSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(secret.slice(6), 'base64')).toHaveLength(32);
    expect(generateSecret()).not.toBe(secret);
  });

  it('produces keys the verifier accepts', async () => {
    const secret = generateSecret();
    const signature = await signWebhook({ secret, id: 'msg_1', timestamp: 1, body: '{}' });
    const headers = { 'webhook-id': 'msg_1', 'webhook-timestamp': '1', 'webhook-signature': signature };
    expect(await verifyWebhook({ secret, headers, body: '{}', now: 1 })).toEqual({ ok: true });
  });

  it('secretProblem accepts exactly what yoink creates (whitespace around it is fine)', () => {
    expect(secretProblem(FIXED_SECRET)).toBeNull();
    expect(secretProblem(` ${FIXED_SECRET}\n`)).toBeNull();
    for (const missing of [undefined, null, '', '  \n']) expect(secretProblem(missing)).toBe('missing');
    const invalid = [
      FIXED_SECRET.slice(6), // no prefix
      FIXED_SECRET.slice(0, -4), // cut off: 29 bytes
      `whsec_${Buffer.alloc(24).toString('base64')}`, // valid base64, but not 32 bytes
      'whsec_not base64!',
      'secret',
      42,
    ];
    for (const value of invalid) expect(secretProblem(value), String(value)).toBe('invalid');
  });
});

describe('buildSetupLink', () => {
  it('carries only v, url and name, never a key', () => {
    expect(buildSetupLink({ url: 'https://bridge.example.workers.dev/' })).toBe(
      'yoink://ausgang?v=1&url=https%3A%2F%2Fbridge.example.workers.dev%2F',
    );
    expect(buildSetupLink({ url: 'https://r.example/', secret: FIXED_SECRET } as never)).not.toContain('secret');
  });

  it('percent-encodes &, #, spaces (as %20), umlauts and emoji', () => {
    const link = buildSetupLink({ url: 'https://bridge.example/hook?team=a&b=1', name: 'Meine Bridge & Co. #1 über 🎬' });
    expect(link).toBe(
      'yoink://ausgang?v=1' +
        '&url=https%3A%2F%2Fbridge.example%2Fhook%3Fteam%3Da%26b%3D1' +
        '&name=Meine%20Bridge%20%26%20Co.%20%231%20%C3%BCber%20%F0%9F%8E%AC',
    );
    expect(link).not.toContain('+');
  });

  it('round-trips through a URL parser', () => {
    const input = { url: 'https://bridge.example/hook?x=1&y=2', name: 'Linear: Bugs\nin „yoink“' };
    const params = new URL(buildSetupLink(input)).searchParams;
    expect(Object.fromEntries(params)).toEqual({ v: '1', ...input });
  });

  it('leaves out an empty or missing name', () => {
    expect(buildSetupLink({ url: 'https://r.example/', name: '  ' })).not.toContain('name=');
    expect(buildSetupLink({ url: 'https://r.example/', name: ' A ' })).toMatch(/&name=A$/);
  });
});

describe('runCli', () => {
  let dir: string;
  let out: string;
  let err: string;
  const io = (overrides: Partial<CliIO> = {}): CliIO => ({
    stdout: (t) => void (out += t),
    stderr: (t) => void (err += t),
    isTTY: false,
    env: {},
    randomBytes: fixedRandom,
    ...overrides,
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'yoink-bridge-'));
    out = '';
    err = '';
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('handles help, version and unknown commands', async () => {
    expect(await runCli(['--help'], io())).toBe(0);
    expect(out).toContain('yoink-bridge check  --url <bridge-url>');
    expect(out).toContain('yoink-bridge keygen [--env-file <path>]');
    expect(out).not.toMatch(/password|pair/i);
    expect(await runCli(['keygen', '--help'], io())).toBe(0);
    expect(await runCli(['--version'], io())).toBe(0);
    expect(out).toContain(pkg.version);
    expect(await runCli([], io())).toBe(1);
    expect(await runCli(['pair'], io())).toBe(1);
    expect(err).toContain('Unknown command: pair');
  });

  it('keygen prints a key line on stdout and the dev-only note on stderr', async () => {
    expect(await runCli(['keygen'], io())).toBe(0);
    expect(out).toBe(`YOINK_SECRET=${FIXED_SECRET}\n`);
    expect(err).toContain('For local development only');
    expect(err).toContain('Einstellungen › Ausgänge › Bridge einrichten › Schlüssel kopieren');
    expect(await runCli(['keygen', '--secret', 'x'], io())).toBe(1);
  });

  it('keygen --env-file fills the empty line of .dev.vars.example (mode 600), appends otherwise', async () => {
    const envFile = join(dir, '.dev.vars');
    await writeFile(envFile, '# The key from yoink\nYOINK_SECRET=\n# GITHUB_TOKEN=\n');
    expect(await runCli(['keygen', '--env-file', envFile], io())).toBe(0);
    expect(await readFile(envFile, 'utf8')).toBe(`# The key from yoink\nYOINK_SECRET=${FIXED_SECRET}\n# GITHUB_TOKEN=\n`);
    expect((await stat(envFile)).mode & 0o777).toBe(0o600);
    expect(out).toContain(`Wrote a new YOINK_SECRET to ${envFile}`);
    expect(out).not.toContain(FIXED_SECRET);

    const fresh = join(dir, 'fresh.vars');
    expect(await runCli(['keygen', '--env-file', fresh], io())).toBe(0);
    expect(await readFile(fresh, 'utf8')).toBe(`YOINK_SECRET=${FIXED_SECRET}\n`);
    expect(withSecretLine('PORT=1', 'whsec_k')).toBe('PORT=1\nYOINK_SECRET=whsec_k\n');
    expect(withSecretLine('export YOINK_SECRET=""\n', 'whsec_k')).toBe('export YOINK_SECRET=whsec_k\n');
    expect(withSecretLine('YOINK_SECRET= # from yoink\n', 'whsec_k')).toBe('YOINK_SECRET=whsec_k\n');
    expect(withSecretLine('YOINK_SECRET="" # from yoink\n', 'whsec_k')).toBe('YOINK_SECRET=whsec_k\n');
  });

  it('keygen --env-file refuses to replace a key that is already set', async () => {
    const envFile = join(dir, '.dev.vars');
    await writeFile(envFile, `YOINK_SECRET=${FIXED_SECRET}\n`);
    expect(await runCli(['keygen', '--env-file', envFile], io({ randomBytes: undefined }))).toBe(1);
    expect(err).toContain('already sets YOINK_SECRET');
    expect(await readFile(envFile, 'utf8')).toBe(`YOINK_SECRET=${FIXED_SECRET}\n`);
  });
});

describe('check', () => {
  const BRIDGE_URL = 'https://bridge.example.workers.dev/';
  let dir: string;
  let out: string;
  let err: string;
  const bridge = createBridge({
    secret: FIXED_SECRET,
    name: 'Meine Bridge',
    destinations: {
      bugs: { name: 'Linear · Bugs', description: 'Bugs in the yoink app.', projects: ['yoink'], group: 'tracker', onEntry: () => {} },
      shopping: { name: 'Shopping', description: 'Things to buy.', mode: 'suggest', onEntry: () => {} },
    },
  });
  const requests: Request[] = [];
  /** Routes the CLI's request straight into the bridge. */
  const viaBridge = async (url: string, init: RequestInit) => {
    const request = new Request(url, init);
    requests.push(request.clone());
    return bridge.fetch(request);
  };
  const io = (overrides: Partial<CliIO> = {}): CliIO => ({
    stdout: (t) => void (out += t),
    stderr: (t) => void (err += t),
    isTTY: false,
    env: {},
    fetch: viaBridge,
    readSecret: async () => {
      throw new UsageError('no terminal in tests');
    },
    ...overrides,
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'yoink-bridge-'));
    out = '';
    err = '';
    requests.length = 0;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('sends a signed ping like yoink and prints the destinations yoink reads', async () => {
    const code = await runCli(['check', '--url', BRIDGE_URL], io({ env: { YOINK_SECRET: FIXED_SECRET } }));
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(out).toBe(`${BRIDGE_URL} answered 200: URL and key work.\n\n${describeBridge(bridge)}`);
    expect(out).toContain('bugs: Linear · Bugs');
    expect(out).toContain('  group:       tracker (the only one of this group so far)');

    const [request] = requests;
    expect(request!.method).toBe('POST');
    expect(request!.headers.get('webhook-id')).toMatch(/^msg_check_[0-9a-f]{24}$/);
    const body = await request!.json();
    expect(body).toMatchObject({ version: 1, type: 'ping', data: { app: { name: 'yoink' } } });
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('takes the key from --secret, then --env-file, then the environment, then asks', async () => {
    const envFile = join(dir, '.dev.vars');
    await writeFile(envFile, `SLACK_WEBHOOK_URL=https://x\nYOINK_SECRET="${FIXED_SECRET}"\n`);
    const wrong = { YOINK_SECRET: generateSecret() };
    expect(await runCli(['check', '--url', BRIDGE_URL, '--env-file', envFile], io({ env: wrong }))).toBe(0);
    expect(out).toContain('yoink reads 2 destinations from "Meine Bridge"');
    expect(await runCli(['check', '--url', BRIDGE_URL, '--secret', FIXED_SECRET, '--env-file', join(dir, 'none')], io({ env: wrong }))).toBe(0);

    let asked = '';
    const readSecret = async (prompt: string) => {
      asked = prompt;
      return ` ${FIXED_SECRET} `;
    };
    expect(await runCli(['check', '--url', BRIDGE_URL], io({ readSecret }))).toBe(0);
    expect(asked).toBe('Key (whsec_…): ');
  });

  it('explains a wrong key', async () => {
    const other = generateSecret();
    expect(await runCli(['check', '--url', BRIDGE_URL], io({ env: { YOINK_SECRET: other } }))).toBe(1);
    expect(err).toContain('answered 401: {"error":"invalid signature"}');
    expect(err).toContain('Is YOINK_SECRET the same key on both sides');
    expect(out).toBe('');
  });

  it('reports redirects, unreachable bridges and a missing or malformed key', async () => {
    const env = { YOINK_SECRET: FIXED_SECRET };
    const redirect = async () => new Response(null, { status: 301, headers: { location: 'https://elsewhere/' } });
    expect(await runCli(['check', '--url', BRIDGE_URL], io({ env, fetch: redirect }))).toBe(1);
    expect(err).toContain('does not follow redirects');

    err = '';
    const down = async (): Promise<Response> => {
      throw new TypeError('fetch failed');
    };
    expect(await runCli(['check', '--url', BRIDGE_URL], io({ env, fetch: down }))).toBe(1);
    expect(err).toContain(`could not reach ${BRIDGE_URL}: fetch failed`);

    err = '';
    expect(await runCli(['check', '--url', BRIDGE_URL], io())).toBe(1);
    expect(err).toContain('no terminal in tests');

    err = '';
    const envFile = join(dir, '.env');
    await writeFile(envFile, 'PORT=1\n');
    expect(await runCli(['check', '--url', BRIDGE_URL, '--env-file', envFile], io())).toBe(1);
    expect(err).toContain('does not set YOINK_SECRET, and it is not in the environment either');

    err = '';
    expect(await runCli(['check', '--url', BRIDGE_URL, '--secret', 'whsec_***'], io())).toBe(1);
    expect(err).toContain('--secret is not a valid whsec_… key');
    expect(err).not.toContain('***');
  });

  it('accepts https, and http only on localhost', () => {
    expect(validateCheckUrl('http://localhost:8787')).toBe('http://localhost:8787/');
    expect(validateCheckUrl('http://127.0.0.1:8787/x')).toBe('http://127.0.0.1:8787/x');
    expect(() => validateCheckUrl('http://bridge.example')).toThrow(UsageError);
    expect(() => parseCheckArgs([])).toThrow(/--url is required/);
    expect(() => parseCheckArgs(['--url', BRIDGE_URL, '--password'])).toThrow(UsageError);
    expect(parseCheckArgs(['--url', BRIDGE_URL, '--secret', 'k'])).toEqual({ url: BRIDGE_URL, envFile: undefined, secret: 'k' });
  });

  it('parses dotenv lines', () => {
    expect(secretFromEnvText('A=1\nexport YOINK_SECRET = whsec_x \n')).toBe('whsec_x');
    expect(secretFromEnvText("YOINK_SECRET='whsec_y'")).toBe('whsec_y');
    expect(secretFromEnvText('YOINK_SECRET=')).toBeUndefined();
    expect(secretFromEnvText('# YOINK_SECRET=whsec_z')).toBeUndefined();
    expect(secretFromEnvText('YOINK_SECRET= # the key from the yoink app')).toBeUndefined();
    expect(secretFromEnvText('YOINK_SECRET=whsec_x # from yoink')).toBe('whsec_x');
    expect(secretFromEnvText('YOINK_SECRET=whsec_x#from yoink')).toBe('whsec_x');
    expect(secretFromEnvText('YOINK_SECRET="whsec_x" # from yoink')).toBe('whsec_x');
    expect(secretFromEnvText('YOINK_SECRET="" # from yoink')).toBeUndefined();
    expect(secretFromEnvText('YOINK_SECRET=#from yoink\r\n')).toBeUndefined();
  });
});
