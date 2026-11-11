import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  getUserAgent,
  closeSharedBrowser,
} from './lib/browser-manager.js';
import { config, getSettings, saveSettings } from './lib/app-config.js';
import { generateCriticalCss } from './lib/critical-generator.js';
import { resolvePage } from './lib/page-resolver.js';
import { runExclusive } from './lib/hostname-lock.js';
import * as jobStore from './lib/job-store.js';
import {
  saveCapture,
  getCapture,
  deleteCapture,
  listCaptures,
} from './lib/manual-capture.js';
import { getDomainInfo } from './lib/domain-strategy.js';
import {
  validateCriticalBlock,
  BLOCK_POSITIONS,
} from './lib/visual-validator.js';
import {
  removeExcludedElements,
  buildCssIgnoreRules,
} from './lib/html-cleaner.js';
import { detectPageFixes, appendPageFixes } from './lib/page-fixes.js';
import {
  optimizeCriticalCSS,
  auditCssBudget,
  TCP_INITCWND_CEILING_BYTES,
  IDEAL_CRITICAL_GZIP_BYTES,
} from './lib/css-optimizer.js';

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 9001;

// Middleware
app.use(helmet());
app.use(cors());
// Manual captures carry the full rendered DOM plus every stylesheet.
app.use(express.json({ limit: '30mb' }));
// Express 5 leaves req.body undefined when no JSON body was sent; routes
// destructure it directly, so keep the Express 4 behavior of an empty object.
app.use((req, res, next) => {
  req.body ??= {};
  next();
});
app.use(express.static('dist'));

// Store active batch jobs (mirrored to disk via jobStore so history and
// in-flight progress survive a server restart)
const batchJobs = new Map();
await jobStore.loadInto(batchJobs);

// An empty result means the snapshot had no usable styles (e.g. a challenge
// or error page served with HTTP 200), never "this page needs no CSS".
function assertNonEmptyCss(css) {
  if (!css || !css.trim()) {
    throw new Error(
      'CSS crítico vazio: a página capturada não tinha estilos utilizáveis (possível página de bloqueio/erro servida com HTTP 200, ou todo o CSS estava em <style> do <head> ignorado).',
    );
  }
}

// Progress persistence is a convenience (history survives a restart); a disk
// hiccup there must never fail the URL or the batch being processed.
async function persistQuietly() {
  try {
    await jobStore.persist(batchJobs);
  } catch (error) {
    console.warn('  ⚠️ Failed to persist job progress:', error.message);
  }
}

// Validates a batch request body and fills in defaults. Returns
// { error, details } instead of params when the body is unusable.
function parseBatchParams(body = {}) {
  const {
    urls,
    configs,
    combineDimensions = false,
    batchId,
    excludedSelectors = config.defaultExcludedSelectors,
    aggressivePruning = true,
    isolateFirstFold = true,
    ignoreHeadInlineStyles = false,
    targetLimit = TCP_INITCWND_CEILING_BYTES,
    idealLimit = IDEAL_CRITICAL_GZIP_BYTES,
  } = body;

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return { error: 'At least one URL is required' };
  }

  if (!configs || !Array.isArray(configs) || configs.length === 0) {
    return { error: 'At least one configuration is required' };
  }

  const invalidUrls = [];
  urls.forEach((url, index) => {
    try {
      new URL(url);
    } catch {
      invalidUrls.push({ index, url });
    }
  });

  if (invalidUrls.length > 0) {
    return { error: 'Invalid URL format', details: { invalidUrls } };
  }

  return {
    params: {
      urls,
      configs,
      combineDimensions,
      jobId:
        batchId ||
        `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      excludedSelectors,
      aggressivePruning,
      isolateFirstFold,
      ignoreHeadInlineStyles,
      targetLimit,
      idealLimit,
    },
  };
}

// Registers the job and returns a promise for the full batch response.
// The job entry is created synchronously, so a status poll right after this
// call already finds it.
function startBatch(params) {
  const { jobId, urls, configs } = params;
  batchJobs.set(jobId, {
    totalUrls: urls.length,
    totalConfigs: configs.length,
    completed: 0,
    results: [],
    status: 'processing',
    startTime: new Date(),
    configs,
    combineDimensions: params.combineDimensions,
    excludedSelectors: params.excludedSelectors,
    aggressivePruning: params.aggressivePruning,
    isolateFirstFold: params.isolateFirstFold,
    ignoreHeadInlineStyles: params.ignoreHeadInlineStyles,
    targetLimit: params.targetLimit,
    idealLimit: params.idealLimit,
  });

  return runBatch(params).catch(async (error) => {
    console.error('Batch critical CSS generation error:', error);
    const job = batchJobs.get(jobId);
    if (job) {
      job.status = 'failed';
      job.error = error.message || 'Failed to generate critical CSS';
      job.endTime = new Date();
      await jobStore.persist(batchJobs).catch(() => {});
    }
    throw error;
  });
}

// Sends the batch response, or — with `async: true` in the body — answers
// 202 right away and lets the client poll GET /api/critical/batch/:jobId.
// Async is what the UI uses: a single HTTP request held open for the whole
// batch (minutes for a few dozen URLs) is fragile behind the dev proxy, and
// any hiccup there surfaced as an empty, unparseable response.
async function respondWithBatch(res, params, isAsync) {
  const batchPromise = startBatch(params);

  if (isAsync) {
    batchPromise.catch(() => {}); // already recorded on the job
    return res
      .status(202)
      .json({ jobId: params.jobId, status: 'processing' });
  }

  try {
    res.json(await batchPromise);
  } catch (error) {
    res.status(500).json({
      error: error.message || 'Failed to generate critical CSS',
    });
  }
}

// Critical CSS generation endpoint for multiple URLs
app.post('/api/critical/batch', async (req, res) => {
  const { params, error, details } = parseBatchParams(req.body);
  if (error) {
    return res.status(400).json({ error, ...details });
  }
  return respondWithBatch(res, params, req.body.async === true);
});

async function runBatch({
  jobId,
  urls,
  configs,
  combineDimensions,
  excludedSelectors,
  aggressivePruning,
  isolateFirstFold,
  ignoreHeadInlineStyles,
  targetLimit,
  idealLimit,
}) {
  await jobStore.persist(batchJobs);

  // Process URLs in parallel with controlled concurrency
  const concurrencyLimit = 3; // Process 3 URLs simultaneously
  const results = [];

  console.log(
    `🚀 Starting batch job ${jobId} for ${urls.length} URLs with ${configs.length} configurations`,
  );

  // Process URLs in batches
  for (let i = 0; i < urls.length; i += concurrencyLimit) {
    const urlBatch = urls.slice(i, i + concurrencyLimit);

    const batchPromises = urlBatch.map(async (url, batchIndex) => {
      const urlIndex = i + batchIndex;
      console.log(`📄 Processing URL ${urlIndex + 1}/${urls.length}: ${url}`);

      const urlResults = {
        url,
        urlIndex,
        configs: [],
        success: true,
        error: null,
        blocked: false,
        strategy: null,
        processingTime: 0,
      };

      const urlStartTime = Date.now();
      const hostname = hostnameOf(url);

      try {
        console.log(`  🛡️  Visiting ${url} with real browser (block check + snapshot)...`);
        // Serialized per hostname: never hit the same WAF-protected domain
        // with two visits at once, even if other URLs in this batch do.
        const {
          blockResult,
          html: renderedHtml,
          css: rawCss,
          strategy,
        } = await runExclusive(hostname, () =>
          resolvePage(url, { isolateFirstFold, ignoreHeadInlineStyles }),
        );

        urlResults.strategy = strategy;

        if (blockResult.blocked) {
          console.warn(`  🚫 Blocked before generating CSS: ${blockResult.reason}`);
          urlResults.success = false;
          urlResults.blocked = true;
          urlResults.error = blockResult.reason;
          urlResults.blockDetails = blockResult;
          urlResults.processingTime = Date.now() - urlStartTime;

          const blockedJob = batchJobs.get(jobId);
          if (blockedJob) {
            blockedJob.completed++;
            blockedJob.results.push(urlResults);
            await persistQuietly();
          }

          return urlResults;
        }

        if (rawCss) {
          // Deliberately NOT running this through the cssnano pipeline used
          // for the critical CSS below: modern CSS-in-JS sites (e.g. GitHub)
          // can produce several MB of raw CSS, and cssnano's default preset
          // (mergeRules/discardDuplicates) can take minutes on input that
          // size — a bad trade for what's meant to be a quick reference
          // export, not a production-optimized bundle.
          urlResults.fullCss = {
            css: rawCss,
            size: Buffer.from(rawCss).length,
            originalSize: Buffer.from(rawCss).length,
          };
        }

        let cleanHtml = renderedHtml;
        if (Array.isArray(excludedSelectors) && excludedSelectors.length > 0) {
          const cleanResult = removeExcludedElements(
            renderedHtml,
            excludedSelectors,
          );
          cleanHtml = cleanResult.html;
          if (cleanResult.removedCount > 0) {
            console.log(
              `  🧹 Removed ${cleanResult.removedCount} excluded DOM element(s) matching: ${cleanResult.removedDetails
                .map((d) => `${d.selector} (${d.count})`)
                .join(', ')}`,
            );
          }
        }

        const ignoreRules = buildCssIgnoreRules(excludedSelectors);
        const userAgent = await getUserAgent();

        // Third-party scripts with a known layout effect (GPT top anchor,
        // OneTrust banner): their fix only goes into this page's critical CSS
        // when the captured page actually loads them.
        const pageFixes = detectPageFixes(renderedHtml);
        urlResults.pageFixes = pageFixes.map(({ id, label, css }) => ({
          id,
          label,
          applied: Boolean(css),
        }));
        for (const fix of pageFixes) {
          console.log(`  🩹 ${fix.css ? 'Page fix' : 'Page fix skipped'}: ${fix.label}`);
        }

        if (combineDimensions && configs.length > 1) {
          // Generate single CSS for multiple dimensions
          try {
            const dimensions = configs.map((config) => ({
              width: config.width,
              height: config.height,
            }));

            console.log(
              `  🔄 Generating combined critical CSS for ${dimensions.length} dimensions...`,
            );

            // Ignored stylesheets ("ignoredStylesheets" in the settings
            // center) are already dropped from the snapshot in visitUrl.
            const filteredCss = await generateCriticalCss({
              html: cleanHtml,
              pageUrl: url,
              dimensions,
              userAgent,
              ignoreRules,
            });

            const { css: finalCss, audit } = await optimizeCriticalCSS(
              appendPageFixes(filteredCss, pageFixes),
              {
                aggressivePruning,
                combineDuplicates: true,
                targetLimit,
                idealLimit,
              },
            );
            assertNonEmptyCss(finalCss);

            urlResults.configs.push({
              config: {
                name: `Combined (${configs
                  .map((c) => `${c.width}×${c.height}`)
                  .join(', ')})`,
                device: 'combined',
                width: Math.max(...configs.map((c) => c.width)),
                height: Math.max(...configs.map((c) => c.height)),
                dimensions: dimensions,
              },
              css: finalCss,
              rawSize: audit.rawBytes,
              gzipSize: audit.gzipBytes,
              budget: audit,
              success: true,
              combined: true,
            });

            console.log(
              `  ✅ Combined critical CSS generated successfully (${audit.rawFormatted} raw, ${audit.gzipFormatted} gzip - ${audit.status.toUpperCase()})`,
            );
          } catch (error) {
            console.error(
              `  ❌ Error generating combined critical CSS:`,
              error.message,
            );
            urlResults.configs.push({
              config: {
                name: 'Combined Generation',
                device: 'combined',
              },
              css: '',
              success: false,
              error: error.message,
              combined: true,
            });
          }
        } else {
          // Generate individual CSS for each configuration
          for (const config of configs) {
            try {
              console.log(
                `  🔄 Generating critical CSS for ${config.name} (${config.width}×${config.height})...`,
              );

              const filteredCss = await generateCriticalCss({
                html: cleanHtml,
                pageUrl: url,
                dimensions: [{ width: config.width, height: config.height }],
                userAgent,
                ignoreRules,
              });

              const { css: finalCss, audit } = await optimizeCriticalCSS(
                appendPageFixes(filteredCss, pageFixes),
                {
                  aggressivePruning,
                  combineDuplicates: true,
                  targetLimit,
                  idealLimit,
                },
              );
              assertNonEmptyCss(finalCss);

              urlResults.configs.push({
                config,
                css: finalCss,
                rawSize: audit.rawBytes,
                gzipSize: audit.gzipBytes,
                budget: audit,
                success: true,
                combined: false,
              });

              console.log(
                `  ✅ Critical CSS generated successfully for ${config.name} (${audit.rawFormatted} raw, ${audit.gzipFormatted} gzip - ${audit.status.toUpperCase()})`,
              );
            } catch (error) {
              console.error(
                `  ❌ Error generating critical CSS for ${config.name}:`,
                error.message,
              );
              urlResults.configs.push({
                config,
                css: '',
                success: false,
                error: error.message,
                combined: false,
              });
            }
          }
        }
      } catch (error) {
        console.error(`❌ Error processing URL ${url}:`, error.message);
        urlResults.success = false;
        urlResults.error = error.message;
      }

      // A URL only counts as processed if at least one viewport produced CSS;
      // otherwise the UI would show "Sucesso" next to an empty Drupal block.
      if (
        urlResults.success &&
        urlResults.configs.length > 0 &&
        !urlResults.configs.some((c) => c.success)
      ) {
        urlResults.success = false;
        urlResults.error = urlResults.configs[0].error;
      }

      urlResults.processingTime = Date.now() - urlStartTime;

      // Update batch job progress
      const job = batchJobs.get(jobId);
      if (job) {
        job.completed++;
        job.results.push(urlResults);
        await persistQuietly();

        console.log(
          `📊 Progress: ${job.completed}/${job.totalUrls} URLs completed`,
        );
      }

      return urlResults;
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
  }

  // Update final job status
  const job = batchJobs.get(jobId);
  if (job) {
    job.endTime = new Date();
    job.totalTime = job.endTime - new Date(job.startTime);
  }

  const successfulUrls = results.filter((r) => r.success).length;
  const totalConfigs = results.reduce(
    (sum, r) => sum + r.configs.filter((c) => c.success).length,
    0,
  );

  console.log(
    `🎉 Batch job ${jobId} completed: ${successfulUrls}/${urls.length} URLs processed successfully`,
  );
  console.log(`📈 Total configurations generated: ${totalConfigs}`);

  // Global budget statistics across all processed configurations
  let totalRawBytes = 0;
  let totalGzipBytes = 0;
  let budgetOptimalCount = 0;
  let budgetWarningCount = 0;
  let budgetExceededCount = 0;

  results.forEach((r) => {
    if (!r.success) return;
    r.configs.forEach((c) => {
      if (!c.success || !c.budget) return;
      totalRawBytes += c.budget.rawBytes;
      totalGzipBytes += c.budget.gzipBytes;
      if (c.budget.status === 'optimal') budgetOptimalCount++;
      else if (c.budget.status === 'warning') budgetWarningCount++;
      else if (c.budget.status === 'exceeded') budgetExceededCount++;
    });
  });

  const primaryUrlResult = results.find((r) => r.success);
  const primaryConfigResult = primaryUrlResult?.configs?.find((c) => c.success);
  const primaryCss = primaryConfigResult?.css || '';
  const primaryAudit = primaryConfigResult?.budget || auditCssBudget(primaryCss, targetLimit, idealLimit);

  const summary = {
      totalUrls: urls.length,
      successfulUrls,
      totalConfigs: configs.length,
      successfulConfigs: totalConfigs,
      combineDimensions,
      aggressivePruning,
      isolateFirstFold,
      ignoreHeadInlineStyles,
      processingTime: job?.totalTime || 0,
      budgetSummary: {
        totalRawBytes,
        totalGzipBytes,
        budgetOptimalCount,
        budgetWarningCount,
        budgetExceededCount,
        targetLimit,
        idealLimit,
      },
  };

  // Flip to "completed" only once the summary is attached, so a status poll
  // never sees a finished job without it.
  if (job) {
    job.summary = summary;
    job.status = 'completed';
    await persistQuietly();
  }

  return {
    jobId,
    results,
    summary,
    optimizedCSS: {
      success: !!primaryCss,
      css: primaryCss,
      totalUrls: urls.length,
      url: primaryUrlResult?.url || urls[0],
      size: primaryAudit.rawBytes,
      gzipSize: primaryAudit.gzipBytes,
      budget: primaryAudit,
      originalSize: primaryConfigResult?.rawSize || primaryAudit.rawBytes,
    },
  };
}

// Get batch job status
app.get('/api/critical/batch/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = batchJobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.json({
    jobId,
    status: job.status,
    progress: {
      completed: job.completed,
      total: job.totalUrls,
      percentage: Math.round((job.completed / job.totalUrls) * 100),
    },
    // The full page CSS can be several hundred KB per URL; leave it out of
    // the progress polls and send it once the job is done.
    results:
      job.status === 'processing'
        ? job.results.map(({ fullCss, ...rest }) => rest)
        : job.results,
    summary: job.summary || null,
    error: job.error || null,
    timing: {
      startTime: job.startTime,
      endTime: job.endTime,
      totalTime: job.totalTime,
    },
  });
});

// Reprocess only the URLs that failed in a previous batch job
app.post('/api/critical/batch/:jobId/retry', async (req, res) => {
  const { jobId } = req.params;
  const originalJob = batchJobs.get(jobId);

  if (!originalJob) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const failedUrls = (originalJob.results || [])
    .filter((result) => !result.success)
    .map((result) => result.url);

  if (failedUrls.length === 0) {
    return res.status(400).json({ error: 'No failed URLs to retry in this job' });
  }

  const { params } = parseBatchParams({
    urls: failedUrls,
    configs: originalJob.configs,
    combineDimensions: originalJob.combineDimensions,
    excludedSelectors: originalJob.excludedSelectors,
    aggressivePruning: originalJob.aggressivePruning !== false,
    isolateFirstFold: originalJob.isolateFirstFold !== false,
    ignoreHeadInlineStyles: originalJob.ignoreHeadInlineStyles === true,
    targetLimit: originalJob.targetLimit,
    idealLimit: originalJob.idealLimit,
  });

  return respondWithBatch(res, params, req.body?.async === true);
});

// Manual capture: a bookmarklet run from the user's own real browser posts
// the rendered page here so a domain that blocks every automated path can
// still be processed (used as the last fallback tier in resolvePage()).
app.post('/api/capture', async (req, res) => {
  const { url, html, sheets, skippedSheets, capturedAt } = req.body;

  if (!url || !html) {
    return res.status(400).json({ error: 'url and html are required' });
  }

  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  if (sheets !== undefined && !Array.isArray(sheets)) {
    return res.status(400).json({ error: 'sheets must be an array' });
  }

  await saveCapture(url, { html, sheets, skippedSheets, capturedAt });
  res.json({ success: true });
});

app.get('/api/capture', async (req, res) => {
  res.json({ captures: await listCaptures() });
});

app.delete('/api/capture', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }
  await deleteCapture(url);
  res.json({ success: true });
});

// Per-domain block history, so the UI can warn upfront about domains that
// have been blocking direct access
app.get('/api/domain-info', async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'url query param is required' });
  }
  res.json({ domain: await getDomainInfo(url) });
});

// Single URL endpoint (backward compatibility)
app.post('/api/critical', async (req, res) => {
  const { url, ...rest } = req.body;
  const { params, error, details } = parseBatchParams({ ...rest, urls: [url] });
  if (error) {
    return res.status(400).json({ error, ...details });
  }
  return respondWithBatch(res, params, req.body.async === true);
});

// Visual validation of a generated block (see lib/visual-validator.js).
// In-memory only: reports carry screenshots and are meant to be looked at
// right away, not kept as history.
const validationJobs = new Map();
const MAX_VALIDATION_JOBS = 20;

app.post('/api/validate', (req, res) => {
  const { url, blockHtml, position = 'body-start' } = req.body || {};

  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'URL inválida' });
  }
  if (!blockHtml || !/<style[\s>]/i.test(blockHtml)) {
    return res
      .status(400)
      .json({ error: 'Cole o bloco HTML gerado (com as tags <style media>)' });
  }
  if (!BLOCK_POSITIONS[position]) {
    return res.status(400).json({ error: `Posição inválida: ${position}` });
  }

  const jobId = `validate_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const job = { status: 'processing', step: 'Na fila', startTime: new Date(), url, position };
  validationJobs.set(jobId, job);
  while (validationJobs.size > MAX_VALIDATION_JOBS) {
    validationJobs.delete(validationJobs.keys().next().value);
  }

  console.log(`🔍 Visual validation ${jobId} for ${url} (block at ${position})`);
  runExclusive(hostnameOf(url), () =>
    validateCriticalBlock({
      url,
      blockHtml,
      position,
      onStep: (step) => {
        job.step = step;
      },
    }),
  )
    .then((report) => {
      job.report = report;
      job.status = 'completed';
      console.log(
        `🔍 Validation ${jobId}: ${report.results.map((r) => `${r.viewport.name}=${r.verdict}`).join(', ')}`,
      );
    })
    .catch((error) => {
      console.error(`❌ Validation ${jobId} failed:`, error.message);
      job.error = error.message;
      job.status = 'failed';
    });

  res.status(202).json({ jobId, status: 'processing' });
});

app.get('/api/validate/:jobId', (req, res) => {
  const job = validationJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json({ jobId: req.params.jobId, ...job });
});

// Settings center: reads/writes critical.config.json (never committed).
app.get('/api/settings', (req, res) => {
  res.json(getSettings());
});

app.put('/api/settings', async (req, res) => {
  const busy =
    [...batchJobs.values()].some((job) => job.status === 'processing') ||
    [...validationJobs.values()].some((job) => job.status === 'processing');
  if (busy) {
    return res.status(409).json({
      error: 'Há processamentos em andamento. Aguarde terminarem para salvar as configurações.',
    });
  }
  try {
    const { browserChanged } = await saveSettings(req.body?.values || {});
    // Browser settings (channel, flags, hooks, Accept-Language) only apply to
    // a new browser: the next visit relaunches it.
    if (browserChanged) await closeSharedBrowser();
    console.log(`⚙️  Configurações salvas${browserChanged ? ' (navegador reiniciado)' : ''}`);
    res.json({ ...getSettings(), browserRestarted: browserChanged });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    activeBatchJobs: batchJobs.size,
  });
});

// Cleanup old batch jobs (run every hour)
setInterval(async () => {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  let removed = false;
  for (const [jobId, job] of batchJobs.entries()) {
    // startTime is a Date for jobs created this run, but an ISO string for
    // jobs restored from disk at startup — new Date(...) handles both.
    if (
      job.status !== 'processing' &&
      new Date(job.startTime).getTime() < oneHourAgo
    ) {
      batchJobs.delete(jobId);
      removed = true;
      console.log(`🧹 Cleaned up old batch job: ${jobId}`);
    }
  }
  if (removed) await persistQuietly();
}, 60 * 60 * 1000);

// Serve the frontend
app.get('/{*splat}', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(
    `🚀 Critical CSS Generator server running on http://localhost:${PORT}`,
  );
  console.log(
    `📊 Batch API endpoint: http://localhost:${PORT}/api/critical/batch`,
  );
  console.log(`🔍 Single API endpoint: http://localhost:${PORT}/api/critical`);
});

async function shutdown(signal) {
  console.log(`\n${signal} received, closing shared browser...`);
  await closeSharedBrowser();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Node exits on an unhandled rejection by default, and under nodemon a dead
// server just sits at "app crashed" while every API call through the Vite
// proxy fails with ECONNREFUSED. Stray errors from puppeteer/playwright
// internals (a page closing mid-render, a detached CDP session) are scoped to
// one render, so log them loudly and keep serving instead.
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled promise rejection (server kept alive):', reason);
});
process.on('uncaughtException', (error) => {
  console.error('⚠️ Uncaught exception (server kept alive):', error);
});
