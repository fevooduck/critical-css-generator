import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function readJson(filename, fallback) {
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, filename), 'utf-8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

const writeQueues = new Map();

export function writeJson(filename, data) {
  // Snapshot now: callers keep mutating the same objects (job.results.push)
  // while an earlier write may still be pending.
  const json = JSON.stringify(data, null, 2);
  // Serialized per file: parallel URLs of one batch persist at the same
  // time, and two writers sharing one tmp path made the second rename()
  // fail with ENOENT, failing that URL (or the whole batch request).
  const previous = writeQueues.get(filename) || Promise.resolve();
  const next = previous.then(async () => {
    await ensureDataDir();
    const target = path.join(DATA_DIR, filename);
    const tmp = `${target}.${process.pid}.tmp`;
    // Write-then-rename so a crash mid-write can't leave a half-written,
    // unparseable jobs.json behind (rename is atomic on POSIX).
    await fs.writeFile(tmp, json);
    await fs.rename(tmp, target);
  });
  writeQueues.set(filename, next.catch(() => {}));
  return next;
}
