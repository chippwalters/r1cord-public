// Tailscale on this PC: status parsing, the Serve commands, the outside check of what Serve
// publishes, the consented MSI install and the probe listener. The client, the network and msiexec
// are all faked; nothing here runs tailscale.exe or contacts pkgs.tailscale.com.
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { ServeConsentError, TailscaleError, createTailscale, parseStatus, policySnippet } = require('../../src/core/tailscale');

const EXE = 'C:\\Program Files\\Tailscale\\tailscale.exe';
const TAILSCALE_SIGNER = { status: 'Valid', subject: 'CN=Tailscale Inc., O=Tailscale Inc., L=Toronto, S=Ontario, C=CA' };

const cleanup = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-tailscale-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const STATUS_JSON = {
  BackendState: 'Running',
  TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'],
  MagicDNSSuffix: 'example-tailnet.ts.net',
  CurrentTailnet: { Name: 'example@example.com', MagicDNSSuffix: 'example-tailnet.ts.net' },
  Self: {
    ID: 'nSELF',
    HostName: 'office-pc',
    DNSName: 'office-pc.example-tailnet.ts.net.',
    TailscaleIPs: ['100.101.102.103'],
    Tags: ['tag:r1cord-server'],
    KeyExpiry: '2027-03-01T00:00:00Z',
  },
  Peer: {
    'nodekey:aaa': {
      ID: 'nR1',
      HostName: 'r1',
      OS: 'android',
      DNSName: 'r1.example-tailnet.ts.net.',
      TailscaleIPs: ['100.64.0.9', 'fd7a:115c:a1e0::9'],
      Tags: ['tag:r1cord'],
      Online: true,
    },
    'nodekey:bbb': { ID: 'nNAS', HostName: 'nas', DNSName: 'nas.example-tailnet.ts.net.', TailscaleIPs: ['100.64.0.2'], Online: false },
  },
};

function fakeRun(handler = () => ({ code: 0, stdout: '', stderr: '' })) {
  const calls = [];
  const run = async (argv, options = {}) => {
    calls.push({ argv, options });
    return handler(argv, options);
  };
  return { run, calls };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

/** spawnServe/killProcess stand-ins: each spawn gets a fresh fake child; kills are recorded. */
function fakeServe() {
  const spawned = [];
  const killed = [];
  return {
    spawned,
    killed,
    spawnServe: (argv) => {
      const child = fakeChild();
      spawned.push({ argv, child });
      return child;
    },
    killProcess: (child) => {
      killed.push(child);
      return Promise.resolve();
    },
  };
}

describe('status', () => {
  it('parses tailscale status --json, dropping the DNS trailing dot', () => {
    const status = parseStatus(STATUS_JSON);
    expect(status).toMatchObject({
      installed: true,
      running: true,
      backendState: 'Running',
      dnsName: 'office-pc.example-tailnet.ts.net',
      tailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'],
      magicDnsSuffix: 'example-tailnet.ts.net',
      keyExpiry: '2027-03-01T00:00:00Z',
      tags: ['tag:r1cord-server'],
    });
    expect(status.peers).toEqual([
      { id: 'nR1', hostName: 'r1', dnsName: 'r1.example-tailnet.ts.net', ips: ['100.64.0.9', 'fd7a:115c:a1e0::9'], tags: ['tag:r1cord'], online: true, os: 'android' },
      { id: 'nNAS', hostName: 'nas', dnsName: 'nas.example-tailnet.ts.net', ips: ['100.64.0.2'], tags: [], online: false, os: '' },
    ]);
  });

  it('reports a logged-out client as installed but not running', async () => {
    const { run, calls } = fakeRun(() => ({ code: 0, stdout: JSON.stringify({ BackendState: 'NeedsLogin', Self: {} }), stderr: '' }));
    const status = await createTailscale({ run, exe: EXE }).status();
    expect(calls[0].argv).toEqual([EXE, 'status', '--json']);
    expect(status).toMatchObject({ installed: true, running: false, backendState: 'NeedsLogin', dnsName: '', peers: [] });
  });

  it('reports a stopped service with its error instead of throwing', async () => {
    const { run } = fakeRun(() => ({ code: 1, stdout: '', stderr: 'failed to connect to local tailscaled; it doesn’t appear to be running\n' }));
    const status = await createTailscale({ run, exe: EXE }).status();
    expect(status.installed).toBe(true);
    expect(status.running).toBe(false);
    expect(status.error).toMatch(/failed to connect/);
  });
});

describe('serve', () => {
  it('shares only /v1 of the API listener, in the background, without prompting', async () => {
    const { run, calls } = fakeRun();
    const serve = fakeServe();
    const ts = createTailscale({ run, exe: EXE, ...serve });
    const pending = ts.enableServe(8766);
    const { argv, child } = serve.spawned[0];
    expect(argv).toEqual([EXE, 'serve', '--bg', '--yes', '--set-path', '/v1', 'http://127.0.0.1:8766/v1']);
    child.stdout.emit('data', Buffer.from('Available within your tailnet:\n\nhttps://office-pc.example-tailnet.ts.net/v1\n|-- proxy http://127.0.0.1:8766/v1\n'));
    child.emit('close', 0);
    await expect(pending).resolves.toBeUndefined();
    expect(serve.killed).toEqual([]);
    await ts.disableServe();
    expect(calls[0].argv).toEqual([EXE, 'serve', '--https=443', '--set-path', '/v1', 'off']);
  });

  it('refuses a bad port and surfaces a client failure', async () => {
    const serve = fakeServe();
    const ts = createTailscale({ exe: EXE, ...serve });
    await expect(ts.enableServe(0)).rejects.toThrow(TailscaleError);
    await expect(ts.enableServe('8766; calc')).rejects.toThrow(TailscaleError);
    expect(serve.spawned).toHaveLength(0);
    const pending = ts.enableServe(8766);
    serve.spawned[0].child.stderr.emit('data', Buffer.from('serve config denied\n'));
    serve.spawned[0].child.emit('close', 1);
    await expect(pending).rejects.toThrow(/serve config denied/);
  });

  it('stops at once and returns the approval URL when Serve is not enabled on the tailnet', async () => {
    const serve = fakeServe();
    const ts = createTailscale({ exe: EXE, ...serve });
    const pending = ts.enableServe(8766);
    const { child } = serve.spawned[0];
    // Split mid-URL: nothing may be taken until the URL is complete.
    child.stdout.emit('data', Buffer.from('\nServe is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/ser'));
    expect(serve.killed).toEqual([]);
    child.stdout.emit('data', Buffer.from('ve?node=nABC123CNTRL\n\n'));
    // The CLI never exits on its own here; no close event and no timer is needed.
    const error = await pending.catch((e) => e);
    expect(error).toBeInstanceOf(ServeConsentError);
    expect(error).toBeInstanceOf(TailscaleError);
    expect(error.needsConsent).toBe(true);
    expect(error.url).toBe('https://login.tailscale.com/f/serve?node=nABC123CNTRL');
    expect(serve.killed).toEqual([child]);
    // Further output or the exit after the kill changes nothing.
    child.stdout.emit('data', Buffer.from('more\n'));
    child.emit('close', 1);
    expect(serve.killed).toEqual([child]);
  });
});

describe('verifyServe', () => {
  const R1CORD_401 = { status: 401, contentType: 'application/json; charset=utf-8', body: '{"error":"unauthorized","message":"missing bearer token"}' };
  const NOT_FOUND = { status: 404, contentType: 'text/plain; charset=utf-8', body: 'not found' };

  function httpGetFrom(table) {
    const seen = [];
    const httpGet = async (host, rawPath) => {
      seen.push([host, rawPath]);
      const value = table[rawPath] || NOT_FOUND;
      if (value instanceof Error) throw value;
      return value;
    };
    return { httpGet, seen };
  }

  it('passes when /v1 answers with R1CORD 401 JSON and no admin path is served', async () => {
    const { httpGet, seen } = httpGetFrom({ '/v1/recordings': R1CORD_401 });
    const result = await createTailscale({ httpGet, exe: EXE }).verifyServe('office-pc.example-tailnet.ts.net.');
    expect(result.ok).toBe(true);
    // Traversal forms are sent verbatim, not normalised away before they reach Serve.
    expect(seen.map(([, p]) => p)).toEqual(expect.arrayContaining(['/admin', '/static/app.css', '/v1/../admin', '/v1/%2e%2e/admin']));
    expect(seen.every(([host]) => host === 'office-pc.example-tailnet.ts.net')).toBe(true);
  });

  it('fails when an encoded traversal reaches the admin', async () => {
    const { httpGet } = httpGetFrom({
      '/v1/recordings': R1CORD_401,
      '/v1/%2e%2e/admin': { status: 200, contentType: 'text/html; charset=utf-8', body: '<title>Recordings — R1CORD Server</title>' },
    });
    const result = await createTailscale({ httpGet, exe: EXE }).verifyServe('office-pc.example-tailnet.ts.net');
    expect(result.ok).toBe(false);
    expect(result.checks.filter((c) => !c.pass).map((c) => c.path)).toEqual(['/v1/%2e%2e/admin']);
  });

  it('fails when /v1 is not R1CORD (wrong status, not JSON, or unreachable)', async () => {
    for (const answer of [
      { status: 200, contentType: 'application/json', body: '[]' },
      { status: 401, contentType: 'text/html', body: '<html>login</html>' },
      new Error('ECONNREFUSED'),
    ]) {
      const { httpGet } = httpGetFrom({ '/v1/recordings': answer });
      const result = await createTailscale({ httpGet, exe: EXE }).verifyServe('office-pc.example-tailnet.ts.net');
      expect(result.ok).toBe(false);
      expect(result.checks[0]).toMatchObject({ path: '/v1/recordings', pass: false });
    }
  });

  it('refuses a host that is not a DNS name', async () => {
    const { httpGet, seen } = httpGetFrom({});
    await expect(createTailscale({ httpGet, exe: EXE }).verifyServe('evil.example/admin?')).rejects.toThrow(TailscaleError);
    expect(seen).toHaveLength(0);
  });

  it('counts any admin answer but 404 as published, including a 401 or 403 from the admin guard', async () => {
    for (const status of [401, 403, 302, 500]) {
      const { httpGet } = httpGetFrom({
        '/v1/recordings': R1CORD_401,
        '/admin': { status, contentType: 'application/json; charset=utf-8', body: '{"error":"forbidden"}' },
      });
      const result = await createTailscale({ httpGet, exe: EXE }).verifyServe('office-pc.example-tailnet.ts.net');
      expect(result.ok).toBe(false);
      expect(result.checks.filter((c) => !c.pass).map((c) => c.path)).toEqual(['/admin']);
    }
  });

  it('accepts a refused connection on an admin path but not a timeout', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 100.101.102.103:443'), { code: 'ECONNREFUSED' });
    const ok = await createTailscale({ httpGet: httpGetFrom({ '/v1/recordings': R1CORD_401, '/admin': refused }).httpGet, exe: EXE }).verifyServe(
      'office-pc.example-tailnet.ts.net',
    );
    expect(ok.ok).toBe(true);
    const timedOut = await createTailscale({ httpGet: httpGetFrom({ '/v1/recordings': R1CORD_401, '/admin': new Error('timed out') }).httpGet, exe: EXE }).verifyServe(
      'office-pc.example-tailnet.ts.net',
    );
    expect(timedOut.ok).toBe(false);
    expect(timedOut.checks.find((c) => c.path === '/admin').pass).toBe(false);
  });

  describe('with the API port', () => {
    const HOST = 'office-pc.example-tailnet.ts.net';
    const serveStatus = (handlers) => ({ code: 0, stdout: JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: handlers } } }), stderr: '' });

    it('passes only when /v1 proxies to the API-only listener on that port', async () => {
      const { httpGet } = httpGetFrom({ '/v1/recordings': R1CORD_401 });
      const { run, calls } = fakeRun(() => serveStatus({ '/v1': { Proxy: 'http://127.0.0.1:8766/v1' } }));
      const result = await createTailscale({ httpGet, run, exe: EXE }).verifyServe(`${HOST}.`, { apiPort: 8766 });
      expect(calls[0].argv).toEqual([EXE, 'serve', 'status', '--json']);
      expect(result.ok).toBe(true);
      expect(result).toMatchObject({ dnsName: HOST, apiPort: 8766 });
    });

    it('fails when /v1 goes to another port (the admin listener) or is not shared', async () => {
      const { httpGet } = httpGetFrom({ '/v1/recordings': R1CORD_401 });
      for (const handlers of [{ '/v1': { Proxy: 'http://127.0.0.1:8765/v1' } }, { '/': { Proxy: 'http://127.0.0.1:8766' } }, {}]) {
        const { run } = fakeRun(() => serveStatus(handlers));
        const result = await createTailscale({ httpGet, run, exe: EXE }).verifyServe(HOST, { apiPort: 8766 });
        expect(result.ok).toBe(false);
        expect(result.checks.filter((c) => !c.pass).map((c) => c.path)).toEqual(['tailscale serve /v1']);
      }
    });

    it('fails when the serve status cannot be read', async () => {
      const { httpGet } = httpGetFrom({ '/v1/recordings': R1CORD_401 });
      const { run } = fakeRun(() => ({ code: 1, stdout: '', stderr: 'failed to connect to local tailscaled' }));
      const result = await createTailscale({ httpGet, run, exe: EXE }).verifyServe(HOST, { apiPort: 8766 });
      expect(result.ok).toBe(false);
      expect(result.checks.at(-1).detail).toMatch(/failed to connect/);
    });
  });
});

describe('installMsi', () => {
  const MSI = 'tailscale-setup-1.90.4-amd64.msi';
  const BYTES = Buffer.from('fake msi bytes for the test');
  const SHA = crypto.createHash('sha256').update(BYTES).digest('hex');

  function response(body, { status = 200 } = {}) {
    const buf = Buffer.from(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(buf.length) : null) },
      body: (async function* chunks() {
        yield buf;
      })(),
      text: async () => buf.toString('utf8'),
    };
  }

  function fakeFetch({ sha = SHA, listing = { MSIs: { amd64: MSI, arm64: 'x.msi' }, MSIsVersion: '1.90.4' } } = {}) {
    const urls = [];
    const fetch = async (url) => {
      urls.push(url);
      if (url.endsWith('?mode=json')) return response(JSON.stringify(listing));
      if (url.endsWith('.sha256')) return response(`${sha}\n`);
      if (url.endsWith('.msi')) return response(BYTES);
      return response('', { status: 404 });
    };
    return { fetch, urls };
  }

  it('refuses without explicit consent and touches nothing', async () => {
    const { fetch, urls } = fakeFetch();
    const { run, calls } = fakeRun();
    const ts = createTailscale({ fetch, run, verifySignature: async () => TAILSCALE_SIGNER });
    await expect(ts.installMsi({ dir: tmpDir() })).rejects.toThrow(/consent/);
    expect(urls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('downloads the amd64 MSI, checks hash and signer, then runs msiexec elevated', async () => {
    const dir = tmpDir();
    const { fetch, urls } = fakeFetch();
    const signed = [];
    const { run, calls } = fakeRun(() => ({ code: 0, stdout: '', stderr: '' }));
    const ts = createTailscale({
      fetch,
      run,
      verifySignature: async (file) => {
        signed.push(file);
        expect(fs.readFileSync(file)).toEqual(BYTES);
        return TAILSCALE_SIGNER;
      },
    });
    await expect(ts.installMsi({ consent: true, dir })).resolves.toEqual({ ok: true, version: '1.90.4' });
    expect(urls).toEqual([
      'https://pkgs.tailscale.com/stable/?mode=json',
      `https://pkgs.tailscale.com/stable/${MSI}.sha256`,
      `https://pkgs.tailscale.com/stable/${MSI}`,
    ]);
    expect(signed).toEqual([path.join(dir, MSI)]);
    expect(calls).toHaveLength(1);
    const argv = calls[0].argv;
    expect(path.basename(argv[0]).toLowerCase()).toBe('powershell.exe');
    const script = Buffer.from(argv[argv.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    expect(script).toMatch(/Start-Process .*msiexec\.exe.*\/i .*\/passive.* -Verb RunAs -Wait/);
    expect(calls[0].options.env.R1CORD_TAILSCALE_MSI).toBe(path.join(dir, MSI));
    // Nothing left behind once installed.
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(ts.installSnapshot()).toMatchObject({ active: false, done: '1.90.4', error: '' });
  });

  it('refuses an MSI whose SHA-256 differs from the published one', async () => {
    const dir = tmpDir();
    const { fetch } = fakeFetch({ sha: 'f'.repeat(64) });
    const signed = [];
    const { run, calls } = fakeRun();
    const ts = createTailscale({ fetch, run, verifySignature: async (file) => signed.push(file) && TAILSCALE_SIGNER });
    await expect(ts.installMsi({ consent: true, dir })).rejects.toThrow(/does not match the published/);
    expect(signed).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(ts.installSnapshot().error).toMatch(/SHA-256/);
  });

  it.each([
    ['unsigned', { status: 'NotSigned', subject: '' }],
    ['signed by someone else', { status: 'Valid', subject: 'CN=Example Corp' }],
    ['a broken signature', { status: 'HashMismatch', subject: TAILSCALE_SIGNER.subject }],
  ])('refuses an MSI that is %s', async (_label, sig) => {
    const dir = tmpDir();
    const { fetch } = fakeFetch();
    const { run, calls } = fakeRun();
    const ts = createTailscale({ fetch, run, verifySignature: async () => sig });
    await expect(ts.installMsi({ consent: true, dir })).rejects.toThrow(/not validly signed by Tailscale Inc/);
    expect(calls).toHaveLength(0);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('refuses a listing without an amd64 MSI', async () => {
    const { fetch } = fakeFetch({ listing: { MSIs: { amd64: '../evil.msi' } } });
    const { run, calls } = fakeRun();
    const ts = createTailscale({ fetch, run, verifySignature: async () => TAILSCALE_SIGNER });
    await expect(ts.installMsi({ consent: true, dir: tmpDir() })).rejects.toThrow(/amd64/);
    expect(calls).toHaveLength(0);
  });

  it('reports a cancelled UAC prompt', async () => {
    const { fetch } = fakeFetch();
    const { run } = fakeRun(() => ({ code: 1, stdout: '', stderr: 'This command cannot be run due to the error: The operation was canceled by the user.' }));
    const ts = createTailscale({ fetch, run, verifySignature: async () => TAILSCALE_SIGNER });
    await expect(ts.installMsi({ consent: true, dir: tmpDir() })).rejects.toThrow(/cancelled/);
  });
});

describe('login', () => {
  it('returns the https sign-in URL the CLI prints', async () => {
    const child = fakeChild();
    const argvs = [];
    const ts = createTailscale({ exe: EXE, spawnLogin: (argv) => argvs.push(argv) && child });
    const pending = ts.login();
    child.stderr.emit('data', Buffer.from('\nTo authenticate, visit:\n\n\thttps://login.tailscale.com/a/1a2b3c4d\n\n'));
    await expect(pending).resolves.toEqual({ url: 'https://login.tailscale.com/a/1a2b3c4d' });
    expect(argvs).toEqual([[EXE, 'login']]);
    child.emit('close', 0);
  });

  it('resolves without a URL when the CLI finishes signed in', async () => {
    const child = fakeChild();
    const ts = createTailscale({ exe: EXE, spawnLogin: () => child });
    const pending = ts.login();
    child.emit('close', 0);
    await expect(pending).resolves.toEqual({ url: null });
  });
});

describe('policySnippet', () => {
  it('replaces broad ACLs with narrow grants and tests both allow and deny', () => {
    const { policy, json } = policySnippet();
    expect(JSON.parse(json)).toEqual(policy);
    expect(policy.acls).toEqual([]);
    expect(policy.tagOwners).toHaveProperty(['tag:r1cord']);
    expect(policy.tagOwners).toHaveProperty(['tag:r1cord-server']);
    expect(policy.grants).toContainEqual({ src: ['tag:r1cord'], dst: ['tag:r1cord-server'], ip: ['tcp:443'] });
    expect(policy.grants).toContainEqual({ src: ['autogroup:member'], dst: ['*'], ip: ['*'] });
    // No grant lets the R1 tag reach anything but the server on 443.
    const r1Grants = policy.grants.filter((g) => g.src.includes('tag:r1cord'));
    expect(r1Grants).toEqual([{ src: ['tag:r1cord'], dst: ['tag:r1cord-server'], ip: ['tcp:443'] }]);
    const test = policy.tests.find((t) => t.src === 'tag:r1cord');
    expect(test.accept).toEqual(['tag:r1cord-server:443']);
    expect(test.deny).toContain('tag:r1cord-server:22');
    expect(test.deny.some((d) => !d.startsWith('tag:r1cord-server') && d.endsWith(':443'))).toBe(true);
  });

  it('keeps the default SSH rule and Funnel node attribute, so replacing the policy drops neither', () => {
    const { policy } = policySnippet();
    expect(policy.ssh).toEqual([{ action: 'check', src: ['autogroup:member'], dst: ['autogroup:self'], users: ['autogroup:nonroot', 'root'] }]);
    expect(policy.nodeAttrs).toEqual([{ target: ['autogroup:member'], attr: ['funnel'] }]);
  });

  it('points the deny tests at a real other device when one is known', () => {
    expect(policySnippet({ otherHostIp: '100.64.0.6' }).policy.hosts['other-host']).toBe('100.64.0.6');
    expect(policySnippet().policy.hosts['other-host']).toBe('100.64.0.2');
  });
});

describe('probeListener', () => {
  it('publishes a real loopback listener for the callback, counts arrivals and always removes it', async () => {
    const { run, calls } = fakeRun();
    const ts = createTailscale({ run, exe: EXE });
    const out = await ts.probeListener(async (port) => {
      await new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.end();
          resolve();
        });
        socket.on('error', reject);
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'probed';
    });
    expect(out.result).toBe('probed');
    expect(out.connections).toBe(1);
    expect(calls.map((c) => c.argv)).toEqual([
      [EXE, 'serve', '--bg', '--yes', '--tcp', String(out.port), `tcp://127.0.0.1:${out.port}`],
      [EXE, 'serve', '--tcp', String(out.port), 'off'],
    ]);
    await expect(
      new Promise((resolve, reject) => {
        const socket = net.connect(out.port, '127.0.0.1', () => {
          socket.end();
          resolve('open');
        });
        socket.on('error', reject);
      }),
    ).rejects.toThrow();
  });

  it('removes the temporary share when the callback throws', async () => {
    const { run, calls } = fakeRun();
    const ts = createTailscale({ run, exe: EXE });
    await expect(
      ts.probeListener(async () => {
        throw new Error('probe failed');
      }),
    ).rejects.toThrow('probe failed');
    expect(calls.at(-1).argv.at(-1)).toBe('off');
  });
});
