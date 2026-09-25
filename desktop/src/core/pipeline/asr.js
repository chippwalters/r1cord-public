// Speech recognition behind one engine-agnostic boundary, and the transcript files it produces.
//
// An engine is `{ name, transcribe(audioPath, { model, device, language, signal, log }) }` resolving
// to an AsrResult; it writes no files. writeTranscript() then writes `transcript.txt` and
// `transcript.json` exactly as r1cord_server/pipeline/asr.py does, so the on-disk files match the
// Python server's layout.
//
// The engine is whisper.cpp (asr-whispercpp.js).

const fs = require('node:fs');
const path = require('node:path');
const { isFile, pyFloatRepr, pyStrRepr, writeText } = require('./compat');

/**
 * @typedef {{id: number, start: number, end: number, text: string}} Segment
 * @typedef {{engine: string, model: string, device: string, language: string|null, durationMs: number,
 *   duration: number, segments: Segment[], text: string}} AsrResult
 *   duration in seconds; text = the segment texts joined by blank lines
 */

// The ASR step failed for a reason of its own (model missing, crashed, timed out).
class AsrError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AsrError';
  }
}

// json.dumps(value, ensure_ascii=False) of a str.
function jsonText(value) {
  const escaped = String(value).replace(/[\x00-\x1f\\"]/g, (ch) => {
    const named = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' }[ch];
    return named || `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
  return `"${escaped}"`;
}

function jsonInt(value) {
  return String(Math.trunc(Number(value)));
}

// transcript.json as asr.py writes it: json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
// segment times as Python floats.
function transcriptJson(result) {
  const segment = (seg) =>
    [
      '    {',
      `      "id": ${jsonInt(seg.id)},`,
      `      "start": ${pyFloatRepr(Number(seg.start))},`,
      `      "end": ${pyFloatRepr(Number(seg.end))},`,
      `      "text": ${jsonText(seg.text)}`,
      '    }',
    ].join('\n');
  const segments = result.segments.length ? `[\n${result.segments.map(segment).join(',\n')}\n  ]` : '[]';
  return [
    '{',
    `  "model": ${jsonText(result.model)},`,
    `  "device": ${jsonText(result.device)},`,
    `  "language": ${result.language === null || result.language === undefined ? 'null' : jsonText(result.language)},`,
    `  "durationMs": ${jsonInt(result.durationMs)},`,
    `  "segments": ${segments}`,
    '}',
  ].join('\n');
}

/**
 * Write `outDir`/transcript.txt and transcript.json from an engine's result, as asr.py does.
 * @param {string} outDir
 * @param {AsrResult} result
 * @param {(line: string) => void} [log]
 */
function writeTranscript(outDir, result, log = () => {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const paragraphs = result.segments.map((seg) => seg.text);
  writeText(path.join(outDir, 'transcript.txt'), paragraphs.join('\n\n') + (paragraphs.length ? '\n' : ''));
  writeText(path.join(outDir, 'transcript.json'), `${transcriptJson(result)}\n`);
  const language = result.language === null || result.language === undefined ? 'None' : pyStrRepr(result.language);
  log(`asr: wrote ${result.segments.length} segments on ${result.device} language=${language} duration_ms=${result.durationMs}`);
}

/**
 * The whisper.cpp engine. Models live in `<datastore>/models`; `asr_quant` (default q8_0) selects the ggml build.
 * @param {{config: {datastore: string, asr_quant?: string}, env?: object}} options
 *   further options go to createWhisperCppEngine
 */
function createAsrEngine({ config, env = process.env, ...options }) {
  // Required here, not at the top: asr-whispercpp.js itself requires this module.
  const { createWhisperCppEngine } = require('./asr-whispercpp');
  const { DEFAULT_QUANT, modelsDir } = require('./models');
  return createWhisperCppEngine({
    modelsDir: modelsDir(config.datastore),
    quant: config.asr_quant || DEFAULT_QUANT,
    env,
    ...options,
  });
}

module.exports = {
  AsrError,
  createAsrEngine,
  transcriptJson,
  writeTranscript,
};
