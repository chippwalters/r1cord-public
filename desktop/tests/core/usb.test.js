// Port of tests/test_usb.py. adb is faked; this file never spawns the real adb.
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { defaultConfig, withUpdates } = require('../../src/core/config');
const { JobStore } = require('../../src/core/store');
const {
  AdbError,
  UsbWatcher,
  parseDevices,
  parseListing,
  parseTrackFrames,
} = require('../../src/core/usb');

const SERIAL = 'R1DEVICESERIAL001';
const ROOT = '/sdcard/Download/R1CORD';

const cleanup = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()();
});

function tmpPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-usb-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

class FakeAdb {
  constructor(tree) {
    this.tree = tree;
    this.devices = [[SERIAL, 'device']];
    this.pulled = [];
    this.reversed = [];
    this.truncate = new Set();
    this.failPulls = new Set();
  }

  run(args, { timeout } = {}) {
    if (timeout === undefined) throw new Error('adb runner must receive a timeout');
    if (args[1] === 'devices' && args[2] === '-l' && args.length === 3) {
      const lines = ['List of devices attached'];
      for (const [serial, state] of this.devices) {
        lines.push(`${serial}          ${state} product:gsi_r1 model:R1 device:r1 transport_id:3`);
      }
      return `${lines.join('\n')}\n`;
    }
    if (args[1] !== '-s') throw new Error(`unexpected adb call ${args}`);
    const serial = args[2];
    if (!this.devices.some(([item]) => item === serial)) throw new AdbError(`device '${serial}' not found`);
    if (args[3] === 'shell') {
      if (!String(args[4]).includes(ROOT) || !String(args[4]).includes('stat -c')) {
        throw new Error(`unexpected shell ${args[4]}`);
      }
      const root = path.join(this.tree, serial);
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return '';
      const out = [];
      for (const file of walkFiles(root)) {
        const rel = path.relative(root, file).split(path.sep).join('/');
        const st = fs.statSync(file);
        out.push(`${st.size} ${Math.trunc(st.mtimeMs / 1000)} ./${rel}`);
      }
      return `${out.join('\n')}\n`;
    }
    if (args[3] === 'reverse') {
      this.reversed.push(`${serial} ${args[4]} ${args[5]}`);
      return '';
    }
    if (args[3] === 'pull') {
      const remote = args[5];
      const local = args[6];
      const rel = remote.slice(ROOT.length + 1);
      if (this.failPulls.has(rel)) throw new AdbError(`device '${serial}' detached`);
      const src = path.join(this.tree, serial, ...rel.split('/'));
      if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
        throw new AdbError(`remote object '${remote}' does not exist`);
      }
      this.pulled.push(rel);
      let data = fs.readFileSync(src);
      if (this.truncate.has(rel)) data = data.subarray(0, Math.floor(data.length / 2));
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, data);
      return `${remote}: 1 file pulled\n`;
    }
    throw new Error(`unexpected adb call ${args}`);
  }
}

function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) stack.push(full);
      else if (st.isFile()) out.push(full);
    }
  }
  out.sort();
  return out;
}

function cfg(tmp, overrides = {}) {
  return withUpdates(defaultConfig(), {
    datastore: path.join(tmp, 'ds'),
    webdav_folder: path.join(tmp, 'wd'),
    public_url_base: 'https://example.test/files',
    admin_password: 'test-admin-pass1',
    adb_cmd: path.join(tmp, 'adb.exe'),
    ...overrides,
  });
}

function deviceRecording(tree, recordingId, { status = 'SAVED', title = 'Site visit', audio = Buffer.from('m4a-bytes'), photos = {} } = {}) {
  const folder = path.join(tree, SERIAL, recordingId);
  fs.mkdirSync(folder, { recursive: true });
  const audioName = status === 'SAVED' ? 'audio.m4a' : 'audio.partial.m4a';
  fs.writeFileSync(path.join(folder, audioName), audio);
  for (const [name, data] of Object.entries(photos)) fs.writeFileSync(path.join(folder, name), data);
  fs.writeFileSync(
    path.join(folder, 'metadata.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: recordingId,
      title,
      createdAt: 1_758_400_000_000,
      status,
      audio: audioName,
      photos: Object.keys(photos).map((name) => ({ id: name.slice(6, -4), file: name, status: 'SAVED' })),
    }),
  );
  return folder;
}

function setup() {
  const tmp = tmpPath();
  const tree = path.join(tmp, 'device');
  const fake = new FakeAdb(tree);
  fs.writeFileSync(path.join(tmp, 'adb.exe'), Buffer.alloc(0));
  const holder = { cfg: cfg(tmp) };
  const store = new JobStore(holder.cfg);
  cleanup.push(() => store.close());
  store.adoptDevice(SERIAL);
  const watcher = new UsbWatcher(store, () => holder.cfg);
  watcher._run = fake.run.bind(fake);
  return { tree, fake, store, watcher, holder, tmp };
}

describe('usb', () => {
  it('parse_devices_states_and_model', () => {
    const text =
      'List of devices attached\n' +
      'R1DEVICESERIAL001   device product:gsi_r1 model:R1 device:r1 transport_id:3\n' +
      'emulator-5572          offline transport_id:31540\n' +
      'ABCD                   unauthorized usb:1-2\n';
    const devices = parseDevices(text);
    expect(devices.map((d) => [d.serial, d.state, d.model])).toEqual([
      ['R1DEVICESERIAL001', 'device', 'R1'],
      ['emulator-5572', 'offline', ''],
      ['ABCD', 'unauthorized', ''],
    ]);
  });

  it('parse_listing_only_one_level_deep_and_safe_names', () => {
    const text =
      '65123456 1758400100 ./20260920-2000-ab12/audio.m4a\n' +
      '812345 1758400200 ./20260920-2000-ab12/photo-abc.jpg\n' +
      '1500 1758400300 ./20260920-2000-ab12/metadata.json\n' +
      '12 1758400400 ./stray.txt\n' +
      '12 1758400400 ./deep/er/file.bin\n' +
      '12 1758400400 ./bad id/audio.m4a\n' +
      'garbage line\n';
    const listing = parseListing(text);
    expect(Object.keys(listing)).toEqual(['20260920-2000-ab12']);
    expect(listing['20260920-2000-ab12']['audio.m4a']).toEqual([65123456, 1758400100]);
    expect(Object.keys(listing['20260920-2000-ab12']).length).toBe(3);
  });

  it('first_sync_pulls_everything_and_queues_configured_action', () => {
    const { tree, fake, store, watcher, holder } = setup();
    holder.cfg = withUpdates(holder.cfg, { usb_auto_action: 'review' });
    deviceRecording(tree, 'rec-1', { photos: { 'photo-p1.jpg': Buffer.from('jpeg') } });

    watcher.pollOnce();

    const inbox = store.inboxDir('rec-1');
    expect(fs.readFileSync(path.join(inbox, 'audio.m4a'))).toEqual(Buffer.from('m4a-bytes'));
    expect(fs.readFileSync(path.join(inbox, 'photo-p1.jpg'))).toEqual(Buffer.from('jpeg'));
    expect(fs.existsSync(path.join(inbox, '.upload', 'audio.m4a.partial'))).toBe(false);
    const job = store.latestFor('rec-1');
    expect(job).not.toBeNull();
    expect(job.status).toBe('queued');
    expect(job.reviews).toEqual(['summary']);
    expect(job.publish).toBe(false);
    expect(job.title).toBe('Site visit');
    const rows = store.deviceRecordings(SERIAL);
    expect(rows[0].autoJobId).toBe(job.jobId);
    expect(rows[0].pulledAt).toBeTruthy();

    const before = [...fake.pulled];
    watcher.pollOnce();
    expect(fake.pulled).toEqual(before);
    expect(store.latestFor('rec-1').jobId).toBe(job.jobId);
    expect(fake.reversed).toEqual([`${SERIAL} tcp:8765 tcp:8765`]);
  });

  it('archive_action_pulls_without_job', () => {
    const { tree, store, watcher, holder } = setup();
    holder.cfg = withUpdates(holder.cfg, { usb_auto_action: 'archive' });
    deviceRecording(tree, 'rec-a');

    watcher.pollOnce();

    expect(fs.existsSync(path.join(store.inboxDir('rec-a'), 'audio.m4a'))).toBe(true);
    expect(store.latestFor('rec-a')).toBeNull();
    const rec = store.processInbox('rec-a', { action: 'transcribe' });
    expect(rec.reviews).toEqual([]);
    expect(rec.publish).toBe(false);
    expect(rec.status).toBe('queued');
  });

  it('new_photo_after_job_is_pulled_and_flagged', () => {
    const { tree, fake, store, watcher } = setup();
    const folder = deviceRecording(tree, 'rec-2');
    watcher.pollOnce();
    const firstJob = store.latestFor('rec-2');
    store.setStatus(firstJob.jobId, 'complete');

    fs.writeFileSync(path.join(folder, 'photo-p9.jpg'), Buffer.from('late-jpeg'));
    const meta = JSON.parse(fs.readFileSync(path.join(folder, 'metadata.json'), 'utf8'));
    meta.photos = [{ id: 'p9', file: 'photo-p9.jpg', status: 'SAVED' }];
    fs.writeFileSync(path.join(folder, 'metadata.json'), JSON.stringify(meta, null, 2));
    fake.pulled = [];

    watcher.pollOnce();

    expect([...fake.pulled].sort()).toEqual(['rec-2/metadata.json', 'rec-2/photo-p9.jpg']);
    expect(fs.existsSync(path.join(store.inboxDir('rec-2'), 'photo-p9.jpg'))).toBe(true);
    expect(store.latestFor('rec-2').jobId).toBe(firstJob.jobId);
    const row = store.deviceRecordings(SERIAL)[0];
    expect(row.changedSinceJob).toBe(true);
  });

  it('recording_in_progress_is_skipped_until_saved', () => {
    const { tree, fake, store, watcher } = setup();
    const folder = deviceRecording(tree, 'rec-3', { status: 'RECORDING' });

    watcher.pollOnce();
    expect(fake.pulled).toEqual(['rec-3/metadata.json']);
    expect(fs.existsSync(path.join(store.inboxDir('rec-3'), 'audio.partial.m4a'))).toBe(false);
    expect(store.latestFor('rec-3')).toBeNull();
    expect(store.deviceRecordings(SERIAL)[0].deviceStatus).toBe('RECORDING');

    fs.rmSync(folder, { recursive: true, force: true });
    deviceRecording(tree, 'rec-3', { status: 'SAVED' });
    watcher.pollOnce();
    expect(fs.existsSync(path.join(store.inboxDir('rec-3'), 'audio.m4a'))).toBe(true);
    expect(store.latestFor('rec-3').status).toBe('queued');
  });

  it('short_pull_promotes_nothing_and_records_device_error', () => {
    const { tree, fake, store, watcher } = setup();
    deviceRecording(tree, 'rec-4', { audio: Buffer.from('0123456789') });
    fake.truncate.add('rec-4/audio.m4a');

    watcher.pollOnce();

    const inbox = store.inboxDir('rec-4');
    expect(fs.existsSync(path.join(inbox, 'audio.m4a'))).toBe(false);
    expect(fs.existsSync(path.join(inbox, '.upload', 'audio.m4a.partial'))).toBe(false);
    expect(store.latestFor('rec-4')).toBeNull();
    const device = store.devices().find((row) => row.serial === SERIAL);
    expect(device.lastError).toBeTruthy();
    expect(device.lastError).toContain('audio.m4a');
    expect(watcher.status().lastError).toBeTruthy();

    fake.truncate.clear();
    watcher.pollOnce();
    expect(fs.readFileSync(path.join(inbox, 'audio.m4a'))).toEqual(Buffer.from('0123456789'));
    expect(watcher.status().lastError).toBeNull();
  });

  it('audio_mismatch_keeps_inbox_copy', () => {
    const { tree, store, watcher } = setup();
    const inbox = store.inboxDir('rec-5');
    fs.writeFileSync(path.join(inbox, 'audio.m4a'), Buffer.from('wifi-copy'));
    deviceRecording(tree, 'rec-5', { audio: Buffer.from('different-bytes') });

    watcher.pollOnce();

    expect(fs.readFileSync(path.join(inbox, 'audio.m4a'))).toEqual(Buffer.from('wifi-copy'));
    const row = store.deviceRecordings(SERIAL)[0];
    expect(row.flag).toBe('audio_mismatch');
    expect(store.latestFor('rec-5').status).toBe('queued');
  });

  it('unadopted_device_is_seen_but_not_pulled', () => {
    const { tree, fake, store, watcher } = setup();
    fake.devices = [['OTHER-PHONE', 'device']];
    fs.mkdirSync(path.join(tree, 'OTHER-PHONE', 'rec-9'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'OTHER-PHONE', 'rec-9', 'audio.m4a'), Buffer.from('x'));

    watcher.pollOnce();

    expect(fake.pulled).toEqual([]);
    const seen = Object.fromEntries(store.devices().map((row) => [row.serial, row]));
    expect(seen['OTHER-PHONE']).toBeTruthy();
    expect(seen['OTHER-PHONE'].adopted).toBe(false);
    expect(watcher.status().connected).toEqual([['OTHER-PHONE', 'R1', false]]);
  });

  it('recordings_index_hides_url_for_transcribe_only_jobs', () => {
    const { tree, store, watcher, holder } = setup();
    holder.cfg = withUpdates(holder.cfg, { usb_auto_action: 'transcribe' });
    deviceRecording(tree, 'rec-6');
    watcher.pollOnce();

    const entry = store.recordingsIndex().find((row) => row.recordingId === 'rec-6');
    expect(entry.webdavUrl).toBeNull();
    const job = store.latestFor('rec-6');
    expect(store.resultJson(job.jobId).webdavUrl).toBeNull();
  });

  it('wifi_delivered_file_is_adopted_without_transfer', () => {
    const { tree, fake, store, watcher } = setup();
    const inbox = store.inboxDir('rec-7');
    fs.writeFileSync(path.join(inbox, 'audio.m4a'), Buffer.from('m4a-bytes'));
    deviceRecording(tree, 'rec-7', { audio: Buffer.from('m4a-bytes') });

    watcher.pollOnce();

    expect(fake.pulled).not.toContain('rec-7/audio.m4a');
    const state = store.deviceFileState(SERIAL, 'rec-7');
    expect(state['audio.m4a'][0]).toBe(Buffer.from('m4a-bytes').length);
    expect(crypto.createHash('sha256').update(Buffer.from('m4a-bytes')).digest('hex')).toBe(
      crypto.createHash('sha256').update(fs.readFileSync(path.join(inbox, 'audio.m4a'))).digest('hex'),
    );
  });

  it('parse_track_frames_handles_windows_crlf_and_partial_frames', () => {
    const payload =
      'R1DEVICESERIAL001   device product:gsi_r1 model:Rabbit_R1 transport_id:3\n' +
      'emulator-5572          offline transport_id:4\n';
    const frame = Buffer.from(
      Buffer.from(`${payload.length.toString(16).padStart(4, '0')}${payload}`).toString('binary').replace(/\n/g, '\r\n'),
      'binary',
    );
    const empty = Buffer.from('0000');
    const [frames, rest] = parseTrackFrames(Buffer.concat([frame, empty, frame.subarray(0, 10)]));
    expect(frames.length).toBe(2);
    expect(parseDevices(frames[0]).filter((d) => d.state === 'device').map((d) => d.serial)).toEqual(['R1DEVICESERIAL001']);
    expect(frames[1]).toBe('');
    const expectedRest = Buffer.from(frame.subarray(0, 10).toString('binary').replace(/\r\n/g, '\n'), 'binary');
    expect(Buffer.compare(rest, expectedRest)).toBe(0);
    expect(() => parseTrackFrames(Buffer.from('zzzz'))).toThrow(AdbError);
  });

  it('parse_track_frames_reassembles_frames_from_incremental_chunks', () => {
    const payload = 'R1DEVICESERIAL001   device product:gsi_r1 model:Rabbit_R1 transport_id:3\n';
    const frame = Buffer.from(
      Buffer.from(`${payload.length.toString(16).padStart(4, '0')}${payload}`).toString('binary').replace(/\n/g, '\r\n'),
      'binary',
    );
    const stream = Buffer.concat([frame, frame]);
    const frames = [];
    let rest = Buffer.alloc(0);
    for (let i = 0; i < stream.length; i += 1) {
      rest = Buffer.concat([rest, stream.subarray(i, i + 1)]);
      const [got, next] = parseTrackFrames(rest);
      rest = next;
      frames.push(...got);
    }
    expect(frames).toEqual([payload, payload]);
    expect(rest.length).toBe(0);
  });

  it('parse_devices_ignores_daemon_banners_and_tolerates_crlf_and_tabs', () => {
    const text =
      '* daemon not running; starting now at tcp:5037\r\n' +
      '* daemon started successfully\r\n' +
      'List of devices attached\r\n' +
      'SER1\t\tdevice product:gsi_r1 model:Rabbit_R1 transport_id:1\r\n' +
      'SER2         offline transport_id:2\r\n' +
      'SER3         unauthorized usb:1-1\r\n' +
      'garbage-without-state\r\n' +
      '\r\n';
    const devices = parseDevices(text);
    expect(devices.map((d) => [d.serial, d.state, d.model])).toEqual([
      ['SER1', 'device', 'Rabbit_R1'],
      ['SER2', 'offline', ''],
      ['SER3', 'unauthorized', ''],
    ]);
  });

  it('parse_listing_tolerates_crlf_and_rejects_names_with_spaces', () => {
    const text =
      '10 20 ./rec-crlf/metadata.json\r\n' +
      '30 40 ./rec-crlf/audio.m4a\r\n' +
      '50 60 ./rec-crlf/my photo.jpg\r\n' +
      'error: device offline\r\n' +
      'not-a-number junk ./rec-crlf/x.bin\r\n';
    const listing = parseListing(text);
    expect(listing).toEqual({ 'rec-crlf': { 'metadata.json': [10, 20], 'audio.m4a': [30, 40] } });
  });

  it('paused_recording_is_skipped', () => {
    const { tree, fake, store, watcher } = setup();
    deviceRecording(tree, 'rec-paused', { status: 'PAUSED' });

    watcher.pollOnce();

    expect(fake.pulled).toEqual(['rec-paused/metadata.json']);
    expect(fs.existsSync(path.join(store.inboxDir('rec-paused'), 'audio.partial.m4a'))).toBe(false);
    expect(store.latestFor('rec-paused')).toBeNull();
    expect(store.deviceRecordings(SERIAL)[0].deviceStatus).toBe('PAUSED');
  });

  it('interrupted_recording_is_archive_only', () => {
    const { tree, store, watcher, holder } = setup();
    holder.cfg = withUpdates(holder.cfg, { usb_auto_action: 'review' });
    deviceRecording(tree, 'rec-int', { status: 'INTERRUPTED' });

    watcher.pollOnce();

    expect(fs.readFileSync(path.join(store.inboxDir('rec-int'), 'audio.partial.m4a'))).toEqual(Buffer.from('m4a-bytes'));
    expect(store.latestFor('rec-int')).toBeNull();
    const row = store.deviceRecordings(SERIAL)[0];
    expect(row.deviceStatus).toBe('INTERRUPTED');
    expect(row.autoJobId).toBeNull();
  });

  it('unreadable_metadata_flags_pull_failed_and_recovers', () => {
    const { tree, store, watcher, holder } = setup();
    const folder = path.join(tree, SERIAL, 'rec-bad');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'metadata.json'), '{ this is not json');
    fs.writeFileSync(path.join(folder, 'audio.m4a'), Buffer.from('m4a-bytes'));

    watcher.pollOnce();

    let row = store.deviceRecordings(SERIAL)[0];
    expect(row.flag).toBe('pull_failed');
    expect(row.deviceStatus).toBe('UNKNOWN');
    expect(fs.existsSync(path.join(store.inboxDir('rec-bad'), 'audio.m4a'))).toBe(false);
    expect(store.latestFor('rec-bad')).toBeNull();

    holder.cfg = withUpdates(holder.cfg, { usb_auto_action: 'review' });
    fs.writeFileSync(
      path.join(folder, 'metadata.json'),
      JSON.stringify({ id: 'rec-bad', title: 'Recovered', createdAt: 1_758_400_000_000, status: 'SAVED' }),
    );
    watcher.pollOnce();

    row = store.deviceRecordings(SERIAL)[0];
    expect(row.flag).toBeNull();
    expect(fs.existsSync(path.join(store.inboxDir('rec-bad'), 'audio.m4a'))).toBe(true);
    const job = store.latestFor('rec-bad');
    expect(job).not.toBeNull();
    expect(job.status).toBe('queued');
    expect(job.title).toBe('Recovered');
  });

  it('pull_error_aborts_sync_without_half_files_and_retries_next_pass', () => {
    const { tree, fake, store, watcher, holder } = setup();
    holder.cfg = withUpdates(holder.cfg, { usb_auto_action: 'review' });
    deviceRecording(tree, 'rec-detach');
    fake.failPulls.add('rec-detach/audio.m4a');

    watcher.pollOnce();

    const inbox = store.inboxDir('rec-detach');
    expect(fs.existsSync(path.join(inbox, 'metadata.json'))).toBe(true);
    expect(fs.existsSync(path.join(inbox, 'audio.m4a'))).toBe(false);
    expect(fs.existsSync(path.join(inbox, '.upload', 'audio.m4a.partial'))).toBe(false);
    expect(store.latestFor('rec-detach')).toBeNull();
    const device = store.devices().find((row) => row.serial === SERIAL);
    expect(device.lastError).toBeTruthy();
    expect(device.lastError).toContain('detached');
    expect(watcher.status().lastError).toBeTruthy();

    fake.failPulls.clear();
    watcher.pollOnce();

    expect(fs.readFileSync(path.join(inbox, 'audio.m4a'))).toEqual(Buffer.from('m4a-bytes'));
    expect(store.latestFor('rec-detach').status).toBe('queued');
    expect(watcher.status().lastError).toBeNull();
  });

  it('reverse_is_reapplied_after_reconnect', () => {
    const { tree, fake, watcher } = setup();
    deviceRecording(tree, 'rec-rv');
    watcher.pollOnce();
    expect(fake.reversed).toEqual([`${SERIAL} tcp:8765 tcp:8765`]);

    fake.devices = [];
    watcher.pollOnce();
    fake.devices = [[SERIAL, 'device']];
    watcher.pollOnce();

    expect(fake.reversed).toEqual([`${SERIAL} tcp:8765 tcp:8765`, `${SERIAL} tcp:8765 tcp:8765`]);
  });

  it('missing_adb_sets_error_and_clears_connections', () => {
    const { watcher, holder, tmp } = setup();
    const saved = process.env.LOCALAPPDATA;
    delete process.env.LOCALAPPDATA;
    try {
      holder.cfg = withUpdates(holder.cfg, { adb_cmd: path.join(tmp, 'nope', 'adb.exe') });
      watcher.pollOnce();
      const status = watcher.status();
      expect(status.lastError).toBeTruthy();
      expect(status.lastError.startsWith('adb not found:')).toBe(true);
      expect(status.connected).toEqual([]);
      expect(status.adb).toBe('not found');
    } finally {
      if (saved === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = saved;
    }
  });

  it('adb_path_order_config_then_path_then_downloaded_then_sdk_never_the_app_folder', () => {
    const tmp = tmpPath();
    const touch = (...parts) => {
      const file = path.join(tmp, ...parts);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.alloc(0));
      return file;
    };
    const explicit = touch('explicit', 'adb.exe');
    const onPath = touch('bin', 'r1cord-test-adb.exe');
    const configFolder = path.join(tmp, 'config');
    const downloaded = touch('config', 'platform-tools', 'adb.exe');
    const sdk = touch('local', 'Android', 'Sdk', 'platform-tools', 'adb.exe');
    // The old candidate inside the app folder (app.asar when packaged) must never be used.
    const appTools = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools');
    const createdAppTools = !fs.existsSync(appTools);
    if (createdAppTools) {
      fs.mkdirSync(path.join(appTools, 'platform-tools'), { recursive: true });
      fs.writeFileSync(path.join(appTools, 'platform-tools', 'adb.exe'), Buffer.alloc(0));
    }
    const savedLocal = process.env.LOCALAPPDATA;
    const savedPath = process.env.PATH;
    process.env.LOCALAPPDATA = path.join(tmp, 'local');
    process.env.PATH = `${path.join(tmp, 'bin')}${path.delimiter}${savedPath}`;
    try {
      const base = cfg(tmp);
      const lower = (value) => (value === null ? null : value.toLowerCase());
      expect(UsbWatcher.adbPath(withUpdates(base, { adb_cmd: explicit }), configFolder)).toBe(explicit);
      expect(lower(UsbWatcher.adbPath(withUpdates(base, { adb_cmd: 'r1cord-test-adb' }), configFolder))).toBe(lower(onPath));
      const absent = withUpdates(base, { adb_cmd: 'r1cord-absent-adb' });
      expect(UsbWatcher.adbPath(absent, configFolder)).toBe(downloaded);
      expect(UsbWatcher.adbPath(absent)).toBe(sdk);
      fs.rmSync(downloaded);
      expect(UsbWatcher.adbPath(absent, configFolder)).toBe(sdk);
      fs.rmSync(sdk);
      expect(UsbWatcher.adbPath(absent, configFolder)).toBe(null);
    } finally {
      if (savedLocal === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = savedLocal;
      process.env.PATH = savedPath;
      if (createdAppTools) fs.rmSync(appTools, { recursive: true, force: true });
    }
  });

  it('watcher_uses_the_platform_tools_downloaded_beside_config', () => {
    const tmp = tmpPath();
    const tree = path.join(tmp, 'device');
    const fake = new FakeAdb(tree);
    const configFolder = path.join(tmp, 'config');
    const downloaded = path.join(configFolder, 'platform-tools', 'adb.exe');
    const holder = { cfg: cfg(tmp, { adb_cmd: path.join(tmp, 'nope', 'adb.exe') }) };
    const store = new JobStore(holder.cfg);
    cleanup.push(() => store.close());
    const watcher = new UsbWatcher(store, () => holder.cfg, { configDir: configFolder });
    const programs = [];
    watcher._run = (args, options) => {
      programs.push(args[0]);
      return fake.run(args, options);
    };
    const saved = process.env.LOCALAPPDATA;
    delete process.env.LOCALAPPDATA;
    try {
      watcher.pollOnce();
      expect(watcher.status().adb).toBe('not found');
      expect(programs).toEqual([]);

      fs.mkdirSync(path.dirname(downloaded), { recursive: true });
      fs.writeFileSync(downloaded, Buffer.alloc(0));
      watcher.pollOnce();
      expect(watcher.status().adb).toBe(downloaded);
      expect(watcher.status().lastError).toBe(null);
      expect(programs).toEqual([downloaded]);
    } finally {
      if (saved === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = saved;
    }
  });

  it('status_reports_usb_disabled', () => {
    const { watcher, holder } = setup();
    holder.cfg = withUpdates(holder.cfg, { usb_enabled: false });
    expect(watcher.status().enabled).toBe(false);
    holder.cfg = withUpdates(holder.cfg, { usb_enabled: true });
    expect(watcher.status().enabled).toBe(true);
  });

  it('idle_exit_only_in_plug_mode_when_nothing_needs_the_server', () => {
    const { tree, fake, store, watcher, holder } = setup();
    const exits = [];
    const activity = [null];
    watcher._requestExit = () => exits.push(1);
    watcher._lastActivity = () => activity[0];
    const start = watcher._lastAdoptedSeen;
    const plug = withUpdates(holder.cfg, { run_mode: 'plug', idle_exit_min: 1 });

    expect(watcher._idleCheck(plug, start + 30)).toBe(false);
    expect(watcher._idleCheck(withUpdates(plug, { run_mode: 'always' }), start + 3600)).toBe(false);

    activity[0] = start + 50;
    expect(watcher._idleCheck(plug, start + 100)).toBe(false);
    expect(watcher._idleCheck(plug, start + 111)).toBe(true);
    expect(exits).toEqual([1]);

    deviceRecording(tree, 'rec-idle');
    holder.cfg = withUpdates(plug, { usb_auto_action: 'archive' });
    watcher.pollOnce();
    expect(watcher._idleCheck(plug, start + 10_000)).toBe(false);

    fake.devices = [];
    watcher.pollOnce();
    const rec = store.processInbox('rec-idle', { action: 'transcribe' });
    expect(rec.status).toBe('queued');
    expect(watcher._idleCheck(plug, start + 20_000)).toBe(false);
    store.setStatus(rec.jobId, 'complete');
    expect(watcher._idleCheck(plug, start + 20_000)).toBe(true);
  });

  it('dashboard_opens_when_an_adopted_device_is_plugged_in', () => {
    const { fake, store, watcher, holder } = setup();
    const opened = [];
    watcher._openDashboard = () => opened.push(1);
    holder.cfg = withUpdates(holder.cfg, { usb_auto_action: 'archive' });

    watcher.pollOnce();
    watcher.pollOnce();
    expect(opened).toEqual([]);

    fake.devices = [];
    watcher.pollOnce();
    fake.devices = [[SERIAL, 'device']];
    watcher.pollOnce();
    expect(opened).toEqual([1]);

    const other = 'OTHERPHONE0001';
    fake.devices = [
      [SERIAL, 'device'],
      [other, 'device'],
    ];
    watcher.pollOnce();
    expect(opened).toEqual([1]);
    store.adoptDevice(other);
    watcher.pollOnce();
    expect(opened).toEqual([1]);
  });

  it('a_recording_deleted_on_this_pc_is_not_pulled_back', () => {
    const { tree, fake, store, watcher } = setup();
    deviceRecording(tree, 'rec-gone');
    store.deleteRecording('rec-gone');
    watcher.pollOnce();
    expect(fake.pulled).toEqual([]);
    expect(store.latestFor('rec-gone')).toBeNull();
  });

  it('onImported_runs_after_an_auto_queue', () => {
    const { tree, watcher, holder } = setup();
    const imported = [];
    watcher._onImported = (rec) => imported.push(rec.jobId);
    holder.cfg = withUpdates(holder.cfg, { usb_auto_action: 'transcribe' });
    deviceRecording(tree, 'rec-wake');
    watcher.pollOnce();
    expect(imported.length).toBe(1);
    expect(imported[0]).toBe(watcher.store.latestFor('rec-wake').jobId);
  });
});
