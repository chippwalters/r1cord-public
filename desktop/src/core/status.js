const TOOLTIP_MAX = 127;
const NOTIFY_MESSAGE_MAX = 255;
const PROCESSING = new Set(['transcribing', 'transcribed', 'writing', 'written', 'publishing', 'published']);
const PAGE_LABELS = {
  transcript: 'Transcript',
  summary: 'Summary',
  outline: 'Outline',
  organized: 'Cleaned up & organized',
};

function clip(text, limit) {
  const value = String(text ?? '');
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function deviceLine(connected, usbEnabled) {
  if (!usbEnabled) return 'USB mode off';
  const rows = Array.from(connected || []);
  const adopted = rows.filter((row) => row[2]).map((row) => row[1] || row[0]);
  const others = rows.filter((row) => !row[2]).map((row) => row[0]);
  if (adopted.length) {
    const extra = adopted.length > 1 ? ` (+${adopted.length - 1})` : '';
    return `${String(adopted[0]).replace(/_/g, ' ')} connected${extra}`;
  }
  if (others.length) return 'Device connected, not adopted';
  return 'No device connected';
}

function workLine(jobs) {
  let running = null;
  let queued = 0;
  for (const job of jobs || []) {
    if (job.status === 'queued') queued += 1;
    else if (PROCESSING.has(job.status) && running == null) running = job;
  }
  if (running) {
    const text = `${capitalize(running.status)}: ${running.title || running.recording_id}`;
    return queued ? `${text} (+${queued} queued)` : text;
  }
  if (queued) return `${queued} queued`;
  return 'Idle';
}

function capitalize(value) {
  const text = String(value || '');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

function tooltip(device, work) {
  return clip(`R1CORD Server · ${device} · ${work}`, TOOLTIP_MAX);
}

function finishedSince(seen, jobs) {
  const notes = [];
  for (const job of jobs || []) {
    const before = Object.prototype.hasOwnProperty.call(seen, job.job_id) ? seen[job.job_id] : undefined;
    seen[job.job_id] = job.status;
    if (before === undefined || before === job.status) continue;
    const name = job.title || job.recording_id;
    if (job.status === 'complete') {
      let what = 'AI reviews ready';
      if (!job.reviews || job.reviews.length === 0) what = 'Transcript ready';
      else if (job.reviews.length === 1) what = `${PAGE_LABELS[job.reviews[0]] || job.reviews[0]} ready`;
      notes.push({ title: what, message: clip(name, NOTIFY_MESSAGE_MAX) });
    } else if (job.status === 'error') {
      const reason = String(job.error || 'see the job log').trim().split(/\r?\n/)[0];
      notes.push({ title: 'Job failed', message: clip(`${name}: ${reason}`, NOTIFY_MESSAGE_MAX) });
    }
  }
  return notes;
}

function notificationsFromStatus(status) {
  return (status && status.finished ? status.finished : []).map((row) => ({
    title: row.title,
    body: row.message,
  }));
}

function statusUrl(port, cursor) {
  const url = new URL(`http://127.0.0.1:${port}/admin/api/status`);
  if (cursor && Object.keys(cursor).length) url.searchParams.set('cursor', JSON.stringify(cursor));
  return url.toString();
}

async function fetchStatus({ fetchImpl, port, cursor }) {
  const res = await fetchImpl(statusUrl(port, cursor));
  if (!res.ok) {
    throw new Error(`status HTTP ${res.status}`);
  }
  return res.json();
}

module.exports = {
  TOOLTIP_MAX,
  NOTIFY_MESSAGE_MAX,
  PROCESSING,
  PAGE_LABELS,
  clip,
  deviceLine,
  workLine,
  tooltip,
  finishedSince,
  notificationsFromStatus,
  statusUrl,
  fetchStatus,
};
