// whisper.cpp model files: which ggml file a config model name maps to, and getting it onto disk.
//
// The names the Python server accepts (`tiny` ... `large-v3-turbo`, faster-whisper's list) map to the
// ggml builds in the official whisper.cpp Hugging Face repo, pinned to one revision. `quant` picks the
// build: q8_0 (default, the closest analogue to faster-whisper's CPU int8), f16, or the 5-bit one.
//
// ensureModel() downloads to `<dir>/<file>.part`, resumes an interrupted download with an HTTP Range
// request, checks the sha256 against the pinned Git LFS id and only then renames the file into place,
// so a file under its final name is always a verified one.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { ValueError } = require('../errors');

const HF_REPO = 'ggerganov/whisper.cpp';
const HF_REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1';
const DEFAULT_QUANT = 'q8_0';
const MODELS_SUBDIR = 'models';

// Git LFS size and sha256 of every ggml file used below, from the repo tree at HF_REVISION.
const FILES = {
  'ggml-tiny.bin': [77691713, 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21'],
  'ggml-tiny-q5_1.bin': [32152673, '818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7'],
  'ggml-tiny-q8_0.bin': [43537433, 'c2085835d3f50733e2ff6e4b41ae8a2b8d8110461e18821b09a15c40c42d1cca'],
  'ggml-tiny.en.bin': [77704715, '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f'],
  'ggml-tiny.en-q5_1.bin': [32166155, 'c77c5766f1cef09b6b7d47f21b546cbddd4157886b3b5d6d4f709e91e66c7c2b'],
  'ggml-tiny.en-q8_0.bin': [43550795, '5bc2b3860aa151a4c6e7bb095e1fcce7cf12c7b020ca08dcec0c6d018bb7dd94'],
  'ggml-base.bin': [147951465, '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'],
  'ggml-base-q5_1.bin': [59707625, '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898'],
  'ggml-base-q8_0.bin': [81768585, 'c577b9a86e7e048a0b7eada054f4dd79a56bbfa911fbdacf900ac5b567cbb7d9'],
  'ggml-base.en.bin': [147964211, 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002'],
  'ggml-base.en-q5_1.bin': [59721011, '4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f'],
  'ggml-base.en-q8_0.bin': [81781811, 'a4d4a0768075e13cfd7e19df3ae2dbc4a68d37d36a7dad45e8410c9a34f8c87e'],
  'ggml-small.bin': [487601967, '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b'],
  'ggml-small-q5_1.bin': [190085487, 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb'],
  'ggml-small-q8_0.bin': [264464607, '49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f'],
  'ggml-small.en.bin': [487614201, 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d'],
  'ggml-small.en-q5_1.bin': [190098681, 'bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30'],
  'ggml-small.en-q8_0.bin': [264477561, '67a179f608ea6114bd3fdb9060e762b588a3fb3bd00c4387971be4d177958067'],
  'ggml-medium.bin': [1533763059, '6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208'],
  'ggml-medium-q5_0.bin': [539212467, '19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f'],
  'ggml-medium-q8_0.bin': [823369779, '42a1ffcbe4167d224232443396968db4d02d4e8e87e213d3ee2e03095dea6502'],
  'ggml-medium.en.bin': [1533774781, 'cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356'],
  'ggml-medium.en-q5_0.bin': [539225533, '76733e26ad8fe1c7a5bf7531a9d41917b2adc0f20f2e4f5531688a8c6cd88eb0'],
  'ggml-medium.en-q8_0.bin': [823382461, '43fa2cd084de5a04399a896a9a7a786064e221365c01700cea4666005218f11c'],
  'ggml-large-v1.bin': [3094623691, '7d99f41a10525d0206bddadd86760181fa920438b6b33237e3118ff6c83bb53d'],
  'ggml-large-v2.bin': [3094623691, '9a423fe4d40c82774b6af34115b8b935f34152246eb19e80e376071d3f999487'],
  'ggml-large-v2-q5_0.bin': [1080732091, '3a214837221e4530dbc1fe8d734f302af393eb30bd0ed046042ebf4baf70f6f2'],
  'ggml-large-v2-q8_0.bin': [1656129691, 'fef54e6d898246a65c8285bfa83bd1807e27fadf54d5d4e81754c47634737e8c'],
  'ggml-large-v3.bin': [3095033483, '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2'],
  'ggml-large-v3-q5_0.bin': [1081140203, 'd75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1'],
  'ggml-large-v3-turbo.bin': [1624555275, '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69'],
  'ggml-large-v3-turbo-q5_0.bin': [574041195, '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'],
  'ggml-large-v3-turbo-q8_0.bin': [874188075, '317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1'],
};

// Config model name -> ggml base name. `large` and `turbo` are faster-whisper's aliases.
const MODEL_NAMES = {
  tiny: 'tiny', 'tiny.en': 'tiny.en', base: 'base', 'base.en': 'base.en', small: 'small', 'small.en': 'small.en',
  medium: 'medium', 'medium.en': 'medium.en', 'large-v1': 'large-v1', 'large-v2': 'large-v2', 'large-v3': 'large-v3',
  large: 'large-v3', 'large-v3-turbo': 'large-v3-turbo', turbo: 'large-v3-turbo',
};

function ggmlFile(base, quant) {
  return quant === 'f16' ? `ggml-${base}.bin` : `ggml-${base}-${quant}.bin`;
}

/**
 * @typedef {{model: string, quant: string, file: string, size: number, sha256: string, url: string}} ModelSpec
 */

/**
 * The ggml file for a config model name and quantization.
 * @param {string} model  e.g. `large-v3-turbo`
 * @param {string} [quant]  `q8_0` (default), `f16`, `q5_0` or `q5_1` (whichever the repo has)
 * @returns {ModelSpec}
 */
function resolveModel(model, quant = DEFAULT_QUANT) {
  const base = MODEL_NAMES[model];
  if (!base) {
    throw new ValueError(`unknown asr model for whisper.cpp: '${model}' (expected ${Object.keys(MODEL_NAMES).join('|')})`);
  }
  const file = ggmlFile(base, quant);
  if (!FILES[file]) {
    const have = ['f16', 'q8_0', 'q5_0', 'q5_1'].filter((q) => FILES[ggmlFile(base, q)]);
    throw new ValueError(`no ${quant} build of '${model}' for whisper.cpp (available: ${have.join('|')})`);
  }
  const [size, sha256] = FILES[file];
  return { model, quant, file, size, sha256, url: `https://huggingface.co/${HF_REPO}/resolve/${HF_REVISION}/${file}` };
}

/** `<datastore>/models`, where downloaded models live. */
function modelsDir(datastore) {
  return path.join(datastore, MODELS_SUBDIR);
}

function fileSize(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat.size : -1;
  } catch (_error) {
    return -1;
  }
}

/** Is the verified model file already in `dir`? Only verified downloads get the final name. */
function isModelPresent(dir, spec) {
  return fileSize(path.join(dir, spec.file)) === spec.size;
}

/**
 * On-disk state of a ggml file: present (verified), missing, or a leftover/in-progress `.part`.
 * Progress is the .part size so a reload of the System page needs no polling.
 * @returns {{state: 'present'|'missing'|'partial', path: string, file: string, size: number,
 *   received: number, percent: number, part: string|null}}
 */
function modelStatus(dir, spec) {
  const target = path.join(dir, spec.file);
  const part = `${target}.part`;
  if (isModelPresent(dir, spec)) {
    return { state: 'present', path: target, file: spec.file, size: spec.size, received: spec.size, percent: 100, part: null };
  }
  const received = Math.max(0, fileSize(part));
  if (received > 0) {
    const percent = spec.size > 0 ? Math.min(99, Math.floor((received * 100) / spec.size)) : 0;
    return { state: 'partial', path: target, file: spec.file, size: spec.size, received, percent, part };
  }
  return { state: 'missing', path: target, file: spec.file, size: spec.size, received: 0, percent: 0, part: null };
}

async function sha256File(file, streamOptions) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash, streamOptions);
  return hash.digest('hex');
}

function megabytes(bytes) {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/**
 * Make sure the model file is in `dir`, downloading (or resuming) it when it is not.
 * @param {ModelSpec} spec
 * @param {{dir: string, fetch?: typeof fetch, signal?: AbortSignal|null, log?: (line: string) => void,
 *   onProgress?: (progress: {file: string, received: number, total: number}) => void}} options
 *   onProgress: called whenever the whole-percent value changes, ending with received === total
 * @returns {Promise<string>} the model file path
 */
async function ensureModel(spec, { dir, fetch = globalThis.fetch, signal = null, log = () => {}, onProgress = () => {} }) {
  const target = path.join(dir, spec.file);
  if (isModelPresent(dir, spec)) return target;
  fs.mkdirSync(dir, { recursive: true });
  const streamOptions = signal ? { signal } : {};
  const part = `${target}.part`;
  let have = Math.max(0, fileSize(part));
  if (have > spec.size) {
    fs.rmSync(part, { force: true });
    have = 0;
  }
  log(`asr: model '${spec.model}' is not downloaded yet; downloading ${spec.file} (${megabytes(spec.size)}) from Hugging Face`
    + `${have ? `, resuming at ${megabytes(have)}` : ''} (first run, may take minutes)`);

  let lastPercent = -1;
  const report = (received) => {
    const percent = Math.floor((received * 100) / spec.size);
    if (percent !== lastPercent) {
      lastPercent = percent;
      onProgress({ file: spec.file, received, total: spec.size });
    }
  };

  if (have < spec.size) {
    const headers = have ? { Range: `bytes=${have}-` } : {};
    const response = await fetch(spec.url, { headers, redirect: 'follow', signal });
    let append = false;
    if (response.status === 206 && have) {
      append = true;
    } else if (response.status === 416 && have) {
      // Nothing left to send: the part file may already be complete; the hash check decides.
      append = true;
    } else if (!response.ok) {
      throw new Error(`model download failed: HTTP ${response.status} for ${spec.url}`);
    } else {
      have = 0; // the server ignored the Range request and sent the whole file
    }
    if (response.status !== 416) {
      // Every chunk goes to disk as it arrives, so an interrupted download keeps all it received.
      let received = have;
      report(received);
      const fd = fs.openSync(part, append ? 'a' : 'w');
      try {
        for await (const chunk of response.body) {
          received += chunk.length;
          if (received > spec.size) throw new Error(`model download of ${spec.file} is larger than the expected ${spec.size} bytes`);
          fs.writeSync(fd, chunk);
          report(received);
        }
      } finally {
        fs.closeSync(fd);
      }
    } else if (response.body) {
      await response.body.cancel();
    }
  }

  const size = fileSize(part);
  if (size !== spec.size) {
    throw new Error(`model download of ${spec.file} ended at ${size} of ${spec.size} bytes; it resumes on the next try`);
  }
  const digest = await sha256File(part, streamOptions);
  if (digest !== spec.sha256) {
    fs.rmSync(part, { force: true });
    throw new Error(`model ${spec.file} failed its sha256 check (expected ${spec.sha256}, got ${digest}); the download was deleted`);
  }
  fs.renameSync(part, target);
  report(spec.size);
  log(`asr: model ${spec.file} downloaded and verified`);
  return target;
}

module.exports = {
  DEFAULT_QUANT,
  HF_REVISION,
  MODEL_NAMES,
  ensureModel,
  fileSize,
  isModelPresent,
  megabytes,
  modelStatus,
  modelsDir,
  resolveModel,
};
