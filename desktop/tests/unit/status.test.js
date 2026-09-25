import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  NOTIFY_MESSAGE_MAX,
  TOOLTIP_MAX,
  deviceLine,
  finishedSince,
  notificationsFromStatus,
  tooltip,
  workLine,
} = require('../../src/core/status');
const { buildTrayTemplate } = require('../../src/main/services/tray/trayMenu');

function job(jobId, status, extra = {}) {
  return {
    job_id: jobId,
    recording_id: `rec-${jobId}`,
    status,
    title: extra.title === undefined ? 'Site visit' : extra.title,
    reviews: extra.reviews === undefined ? ['summary'] : extra.reviews,
    error: extra.error,
  };
}

describe('status lines', () => {
  it('prefers an adopted device and respects USB off', () => {
    expect(deviceLine([], false)).toBe('USB mode off');
    expect(deviceLine([['S1', 'Rabbit_R1', true]], false)).toBe('USB mode off');
    expect(deviceLine([], true)).toBe('No device connected');
    expect(deviceLine([['PHONE', 'Pixel', false]], true)).toBe('Device connected, not adopted');
    expect(deviceLine([['PHONE', 'Pixel', false], ['S1', 'Rabbit_R1', true]], true)).toBe('Rabbit R1 connected');
    expect(deviceLine([['S1', 'Rabbit_R1', true], ['S2', 'Pixel_9', true]], true)).toBe('Rabbit R1 connected (+1)');
    expect(deviceLine([['S3', '', true]], true)).toBe('S3 connected');
  });

  it('names the running job and counts the queue', () => {
    expect(workLine([job('a', 'complete')])).toBe('Idle');
    expect(workLine([job('a', 'queued'), job('b', 'queued')])).toBe('2 queued');
    expect(workLine([job('a', 'queued'), job('b', 'transcribing', { title: 'Kickoff' })])).toBe(
      'Transcribing: Kickoff (+1 queued)',
    );
    expect(workLine([job('b', 'writing', { title: null })])).toBe('Writing: rec-b');
  });

  it('fits the Windows tooltip limit', () => {
    expect(tooltip('No device connected', 'Idle')).toBe('R1CORD Server · No device connected · Idle');
    const long = tooltip('No device connected', `Writing: ${'x'.repeat(300)}`);
    expect(long).toHaveLength(TOOLTIP_MAX);
    expect(long.endsWith('…')).toBe(true);
  });

  it('announces only transitions into a final state', () => {
    const seen = {};
    expect(finishedSince(seen, [job('old', 'complete'), job('new', 'writing')])).toEqual([]);
    expect(finishedSince(seen, [job('old', 'complete'), job('new', 'writing')])).toEqual([]);
    expect(finishedSince(seen, [job('old', 'complete'), job('new', 'complete')])).toEqual([
      { title: 'Summary ready', message: 'Site visit' },
    ]);
    expect(finishedSince(seen, [job('t', 'queued', { reviews: [] })])).toEqual([]);
    expect(finishedSince(seen, [job('t', 'complete', { reviews: [] })])).toEqual([
      { title: 'Transcript ready', message: 'Site visit' },
    ]);
    expect(finishedSince(seen, [job('o', 'writing', { reviews: ['organized'] })])).toEqual([]);
    expect(finishedSince(seen, [job('o', 'complete', { reviews: ['organized'] })])).toEqual([
      { title: 'Cleaned up & organized ready', message: 'Site visit' },
    ]);
    expect(finishedSince(seen, [job('m', 'writing', { reviews: ['summary', 'outline'] })])).toEqual([]);
    expect(finishedSince(seen, [job('m', 'complete', { reviews: ['summary', 'outline'] })])).toEqual([
      { title: 'AI reviews ready', message: 'Site visit' },
    ]);
    expect(finishedSince(seen, [job('e', 'writing')])).toEqual([]);
    expect(finishedSince(seen, [job('e', 'error', { error: 'writer: timeout' })])).toEqual([
      { title: 'Job failed', message: 'Site visit: writer: timeout' },
    ]);
  });

  it('clips failure notifications to the Windows balloon limit', () => {
    const error = `writer claude_code exited 1\nargv: [${'x'.repeat(400)}]\nFailed to authenticate: OAuth session expired`;
    const seen = { e: 'writing' };
    const notes = finishedSince(seen, [job('e', 'error', { error, title: 'T'.repeat(300) })]);
    expect(notes[0].title).toBe('Job failed');
    expect(notes[0].message.length).toBeLessThanOrEqual(NOTIFY_MESSAGE_MAX);
    expect(notes[0].message.endsWith('…')).toBe(true);
  });
});

describe('tray notifications and menu', () => {
  it('maps status.finished into notification payloads', () => {
    expect(
      notificationsFromStatus({
        finished: [{ title: 'Summary ready', message: 'Site visit' }],
      }),
    ).toEqual([{ title: 'Summary ready', body: 'Site visit' }]);
  });

  it('builds the tray items a user can click, including USB and email toggles', () => {
    const clicks = [];
    const template = buildTrayTemplate(
      {
        device_line: 'Rabbit R1 connected',
        work_line: 'Idle',
        usb_enabled: true,
        email_enabled: false,
        email_to: 'ops@example.test',
      },
      {
        openDashboard: () => clicks.push('dash'),
        openDevices: () => clicks.push('devices'),
        openSettings: () => clicks.push('settings'),
        toggleUsb: () => clicks.push('usb'),
        toggleEmail: () => clicks.push('email'),
        openRecordings: () => clicks.push('rec'),
        openLogs: () => clicks.push('logs'),
        setStartupMode: (mode) => clicks.push(mode),
        openPreferences: () => clicks.push('prefs'),
        quit: () => clicks.push('quit'),
      },
      { startupMode: 'manual' },
    );
    const labels = template.map((item) => item.label);
    expect(labels).toContain('Open dashboard');
    expect(labels).toContain('Devices');
    expect(labels).toContain('Settings');
    expect(labels).toContain('USB mode');
    expect(labels).toContain('Email finished jobs');
    expect(labels).toContain('Open recordings folder');
    expect(labels).toContain('Open logs folder');
    expect(labels).toContain('Quit R1CORD Desktop');
    const usb = template.find((item) => item.label === 'USB mode');
    const email = template.find((item) => item.label === 'Email finished jobs');
    expect(usb.checked).toBe(true);
    expect(email.enabled).toBe(true);
    usb.click();
    email.click();
    const title = template[0];
    expect(title.label).toBe('R1CORD Desktop');
    expect(title.enabled).not.toBe(false);
    title.click();
    expect(clicks).toEqual(['usb', 'email', 'dash']);
  });

  it('shows a dry-run note instead of pretending registration succeeded', () => {
    const template = buildTrayTemplate(
      { device_line: 'Idle', work_line: 'Idle' },
      {},
      { startupMode: 'login', startupNote: 'dry run: not registered' },
    );
    expect(template.some((item) => item.label === 'dry run: not registered' && item.enabled === false)).toBe(true);
  });

  it('disables the email toggle when no recipient is configured', () => {
    const template = buildTrayTemplate(
      { email_enabled: true, email_to: '  ' },
      {},
      { startupMode: 'plug' },
    );
    const email = template.find((item) => item.label === 'Email finished jobs');
    expect(email.enabled).toBe(false);
  });
});
