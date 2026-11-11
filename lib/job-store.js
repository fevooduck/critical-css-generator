import { readJson, writeJson } from './json-store.js';

const JOBS_FILE = 'jobs.json';
const MAX_PERSISTED_JOBS = 200;

// The full (non-critical) page CSS can run several MB on CSS-in-JS-heavy
// sites; keeping that in every persisted job would make jobs.json balloon
// fast for no real benefit (it's a live-response convenience, not something
// worth resurrecting from disk after a restart). Sizes are kept, the text
// isn't.
function stripHeavyFullCss(job) {
  if (!job.results?.some((r) => r.fullCss?.css)) return job;
  return {
    ...job,
    results: job.results.map((result) =>
      result.fullCss?.css
        ? { ...result, fullCss: { ...result.fullCss, css: null, persisted: false } }
        : result,
    ),
  };
}

function serialize(batchJobs) {
  const entries = [...batchJobs.entries()]
    .slice(-MAX_PERSISTED_JOBS)
    .map(([jobId, job]) => [jobId, stripHeavyFullCss(job)]);
  return Object.fromEntries(entries);
}

// Batch jobs live in the in-memory Map (same ergonomics as before: job.completed++,
// job.results.push(...) work directly on the object), this just mirrors that Map
// to disk after each meaningful update so a server restart doesn't lose history.
export async function persist(batchJobs) {
  await writeJson(JOBS_FILE, serialize(batchJobs));
}

// Restores previously persisted jobs into `batchJobs` at startup. Any job that
// was still "processing" when the server stopped can't be resumed (we don't
// keep enough state to pick a batch back up mid-flight), so it's marked
// "interrupted" instead of appearing stuck forever.
export async function loadInto(batchJobs) {
  const stored = await readJson(JOBS_FILE, {});
  for (const [jobId, job] of Object.entries(stored)) {
    if (job.status === 'processing') {
      job.status = 'interrupted';
    }
    batchJobs.set(jobId, job);
  }
}
