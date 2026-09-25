const fs = require('fs');
const path = require('path');

const FILE_NAME = 'adopted-serials.json';

function adoptedSerialsPath(userData) {
  return path.join(userData, FILE_NAME);
}

function writeAdoptedSerials(userData, serials, writeFileSync = fs.writeFileSync) {
  const filePath = adoptedSerialsPath(userData);
  const list = Array.isArray(serials) ? serials.map(String) : [];
  writeFileSync(filePath, `${JSON.stringify({ serials: list })}\n`, 'utf8');
  return filePath;
}

function readAdoptedSerials(filePath, readFileSync = fs.readFileSync) {
  if (!filePath) return null;
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  if (!raw || !String(raw).trim()) return null;
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : parsed && parsed.serials;
  if (!Array.isArray(list) || list.length === 0) return null;
  return list.map(String);
}

module.exports = {
  FILE_NAME,
  adoptedSerialsPath,
  writeAdoptedSerials,
  readAdoptedSerials,
};
