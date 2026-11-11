// Configuration presets — standardized on first-fold desktop + mobile only,
// so critical CSS output stays consistent and predictably sized across
// projects (more combined viewports means a larger unioned critical CSS).
const presetConfigs = {
  "desktop-1920": {
    width: 1920,
    height: 1080,
    device: "desktop",
    name: "Desktop 1920x1080",
  },
  "mobile-393": {
    width: 393,
    height: 852,
    device: "mobile",
    name: "iPhone 16 (393x852)",
  },
};

// Seletores excluídos por padrão: vêm da central de configurações
// (GET /api/settings) assim que ela carrega; esta lista é só o ponto de partida.
let defaultExcludedSelectors = [
  ".modal",
  "#onetrust-banner-sdk",
  ".dropdown-content",
];

const TAB_HASHES = { validate: "#validacao", settings: "#configuracoes" };

function tabFromHash() {
  const entry = Object.entries(TAB_HASHES).find(([, hash]) => hash === location.hash);
  return entry ? entry[0] : "generate";
}

// State management
const state = {
  urls: [""],
  results: [],
  optimizedCSS: null,
  isLoading: false,
  error: "",
  combineDimensions: false,
  aggressivePruning: true,
  isolateFirstFold: true,
  ignoreHeadInlineStyles: true,
  batchProgress: null,
  currentJobId: null,
  lastJobId: null,
  captures: [],
  excludedSelectors: [...defaultExcludedSelectors],
  showBatchPaste: false,
  tab: tabFromHash(),
  settings: {
    loaded: false,
    file: "",
    exists: false,
    form: null,
    defaults: null,
    isSaving: false,
    error: "",
    message: "",
  },
  validation: {
    url: "",
    blockHtml: "",
    position: "body-start",
    isRunning: false,
    step: "",
    report: null,
    error: "",
  },
};

// Minimalist OpenAI Toast Notification
function showToast(message, type = "success") {
  const existing = document.getElementById("openai-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "openai-toast";
  toast.className = `fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-full text-sm font-medium border shadow-sm transition-all duration-200 transform translate-y-0 ${
    type === "error"
      ? "bg-paper text-obsidian border-rose-300 shadow-rose-100"
      : type === "info"
        ? "bg-paper text-obsidian border-hairline"
        : "bg-obsidian text-paper border-obsidian"
  }`;

  const dot =
    type === "error"
      ? '<span class="w-2 h-2 rounded-full bg-rose-500 shrink-0"></span>'
      : type === "info"
        ? '<span class="w-2 h-2 rounded-full bg-graphite shrink-0"></span>'
        : '<span class="w-2 h-2 rounded-full bg-emerald-400 shrink-0"></span>';

  toast.innerHTML = `${dot}<span class="max-w-md truncate">${message}</span>`;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(8px)";
    setTimeout(() => toast.remove(), 250);
  }, 4000);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatFileSize(bytes) {
  if (bytes === undefined || bytes === null || isNaN(bytes)) return "0KB";
  return (bytes / 1024).toFixed(1) + "KB";
}

// Editorial Budget Badge with restrained indicator dots
function renderBudgetBadge(budget) {
  if (!budget) return "";
  const gzipKb = (budget.gzipBytes / 1024).toFixed(1);
  if (budget.status === "optimal") {
    return `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-ash border border-hairline text-obsidian" title="${budget.message}">
      <span class="w-1.5 h-1.5 rounded-full bg-black"></span>
      <span>${gzipKb}KB gzip</span>
      <span class="text-graphite">· 1º RTT Ideal (&le;10KB)</span>
    </span>`;
  }
  if (budget.status === "warning") {
    return `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-ash border border-hairline text-obsidian" title="${budget.message}">
      <span class="w-1.5 h-1.5 rounded-full bg-amber-500"></span>
      <span>${gzipKb}KB gzip</span>
      <span class="text-graphite">· No Limite (10-14.6KB)</span>
    </span>`;
  }
  return `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-ash border border-hairline text-obsidian" title="${budget.message}">
    <span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span>
    <span>${gzipKb}KB gzip</span>
    <span class="text-graphite">· Excedido (&gt;14.6KB)</span>
  </span>`;
}

function formatTime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

// URL management
function addUrl() {
  state.urls.push("");
  render();
  setTimeout(() => {
    const inputs = document.querySelectorAll(".url-input");
    if (inputs.length > 0) {
      inputs[inputs.length - 1].focus();
    }
  }, 50);
}

function removeUrl(index) {
  if (state.urls.length > 1) {
    state.urls.splice(index, 1);
    render();
  }
}

function updateUrl(index, value) {
  state.urls[index] = value;
  const validCount = state.urls.map((u) => u.trim()).filter((u) => u !== "").length;
  const countEl = document.getElementById("valid-urls-count");
  if (countEl) {
    countEl.textContent = `${validCount} URL${validCount === 1 ? "" : "s"} válida${validCount === 1 ? "" : "s"} para processamento`;
  }
}

function clearUrls() {
  state.urls = [""];
  state.results = [];
  render();
  showToast("Lista limpa", "info");
}

function toggleBatchPaste() {
  state.showBatchPaste = !state.showBatchPaste;
  render();
  if (state.showBatchPaste) {
    setTimeout(() => {
      const textarea = document.getElementById("batch-paste-textarea");
      if (textarea) textarea.focus();
    }, 50);
  }
}

function applyBatchUrls(text) {
  const lines = text
    .split(/[\r\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (lines.length > 0) {
    state.urls = lines;
    state.showBatchPaste = false;
    render();
    showToast(`${lines.length} URL${lines.length === 1 ? "" : "s"} carregada${lines.length === 1 ? "" : "s"} na lista.`);
  } else {
    showToast("Nenhuma URL identificada no texto.", "error");
  }
}

function handlePasteUrls(e, index) {
  const pasteData = (e.clipboardData || window.clipboardData)?.getData("text");
  if (pasteData && (pasteData.includes("\n") || pasteData.includes("\r"))) {
    e.preventDefault();
    const lines = pasteData
      .split(/[\r\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (lines.length > 0) {
      const before = state.urls.slice(0, index);
      const after = state.urls.slice(index + 1);
      state.urls = [...before, ...lines, ...after];
      render();
      showToast(`${lines.length} URLs adicionadas com sucesso.`);
    }
  }
}

// API helpers
const JOB_POLL_INTERVAL_MS = 2000;
const MAX_CONSECUTIVE_POLL_FAILURES = 15; // ~30s of backend unreachable

// The Vite dev proxy answers an empty 500 when the backend (port 9001) is
// down, which response.json() reports as "Unexpected end of JSON input".
async function fetchJson(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new Error(
      "Não foi possível falar com o servidor. Verifique se o backend (porta 9001) está rodando.",
    );
  }

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON body (proxy error page, HTML fallback)
  }

  if (!data) {
    throw new Error(
      `O servidor não respondeu corretamente (HTTP ${response.status}). Verifique se o backend (porta 9001) está rodando — veja o terminal do "npm run dev".`,
    );
  }
  if (!response.ok) {
    throw new Error(data.error || `Erro HTTP ${response.status}`);
  }
  return data;
}

// Polls a batch job until it finishes, updating the progress bar on the way.
// Tolerates short backend outages (e.g. nodemon restarting) instead of
// failing on the first missed poll.
async function waitForJob(jobId) {
  let failures = 0;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL_MS));
    let job;
    try {
      job = await fetchJson(`/api/critical/batch/${jobId}`);
      failures = 0;
    } catch (err) {
      failures++;
      if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) throw err;
      continue;
    }

    state.batchProgress = {
      completed: job.progress.completed,
      total: job.progress.total,
    };
    renderProgress();

    if (job.status === "completed") return job;
    if (job.status === "failed") {
      throw new Error(job.error || "Falha ao gerar o CSS crítico");
    }
    if (job.status === "interrupted") {
      throw new Error(
        "O servidor foi reiniciado durante o processamento. Gere novamente.",
      );
    }
  }
}

// Updates only the progress bar, so polling doesn't re-render the page (and
// wipe text the user may be selecting) every two seconds.
function renderProgress() {
  const { completed, total } = state.batchProgress || {};
  const label = document.getElementById("batch-progress-label");
  const bar = document.getElementById("batch-progress-bar");
  if (!label || !bar || !total) return render();
  label.textContent = `${completed} / ${total}`;
  bar.style.width = `${(completed / total) * 100}%`;
}

// Batch processing
async function handleBatchGenerate() {
  const validUrls = state.urls.map((u) => u.trim()).filter((u) => u !== "");

  if (validUrls.length === 0) {
    state.error = "Por favor, insira pelo menos uma URL válida.";
    render();
    return;
  }

  state.isLoading = true;
  state.error = "";
  state.results = [];
  state.optimizedCSS = [];
  state.batchProgress = { completed: 0, total: validUrls.length };
  render();

  try {
    const configs = Object.values(presetConfigs);
    const jobId = `batch_${Date.now()}_${Math.random()
      .toString(36)
      .substr(2, 9)}`;
    state.currentJobId = jobId;

    showToast(
      `Iniciando extração de CSS para ${validUrls.length} URLs...`,
      "info",
    );

    await fetchJson("/api/critical/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        urls: validUrls,
        configs,
        combineDimensions: state.combineDimensions,
        batchId: jobId,
        excludedSelectors: state.excludedSelectors,
        aggressivePruning: state.aggressivePruning,
        isolateFirstFold: state.isolateFirstFold,
        ignoreHeadInlineStyles: state.ignoreHeadInlineStyles,
        async: true,
      }),
    });

    const data = await waitForJob(jobId);

    // Results arrive in completion order; keep the order the URLs were typed.
    state.results = [...data.results].sort((a, b) => a.urlIndex - b.urlIndex);
    state.batchProgress = null;
    state.lastJobId = data.jobId;

    const { summary } = data;
    showToast(
      `Concluído! ${summary.successfulUrls}/${summary.totalUrls} URLs processadas com sucesso.`,
    );
  } catch (err) {
    state.error = err.message;
    state.batchProgress = null;
    showToast(err.message, "error");
  } finally {
    state.isLoading = false;
    state.currentJobId = null;
    render();
  }
}

// Export functions
function buildHtmlMediaBlock(urlResult) {
  if (!urlResult || !urlResult.configs) return "";

  const mobileConfig = urlResult.configs.find(
    (c) =>
      c.success &&
      (c.config?.device === "mobile" ||
        (c.config?.width && c.config.width < 768)),
  );
  const desktopConfig = urlResult.configs.find(
    (c) =>
      c.success &&
      (c.config?.device === "desktop" ||
        (c.config?.width && c.config.width >= 768)),
  );

  if (mobileConfig && desktopConfig) {
    return `<!-- ======================================================== -->\n<!-- 1. CSS Crítico Mobile (≤991.98px) • ${formatFileSize(
      mobileConfig.gzipSize,
    )} gzip -->\n<!-- ======================================================== -->\n<style media="(max-width: 991.98px)">\n${
      mobileConfig.css
    }\n</style>\n\n<!-- ======================================================== -->\n<!-- 2. CSS Crítico Desktop (≥992px) • ${formatFileSize(
      desktopConfig.gzipSize,
    )} gzip -->\n<!-- ======================================================== -->\n<style media="(min-width: 992px)">\n${
      desktopConfig.css
    }\n</style>`;
  }

  const single = urlResult.configs.find((c) => c.success);
  if (single) {
    return `<style>\n${single.css}\n</style>`;
  }
  return "";
}

async function handleCopyHtmlBlock(urlResult, btn) {
  const block = buildHtmlMediaBlock(urlResult);
  if (!block) return;
  try {
    await navigator.clipboard.writeText(block);
    showToast("Bloco Drupal copiado para a área de transferência.");
    if (btn) {
      const origHtml = btn.innerHTML;
      btn.innerHTML =
        '<i class="fas fa-check text-xs"></i> <span>Copiado!</span>';
      setTimeout(() => {
        btn.innerHTML = origHtml;
      }, 2000);
    }
  } catch (err) {
    showToast("Falha ao copiar bloco HTML", "error");
  }
}

function handleDownloadHtmlBlock(urlResult) {
  const block = buildHtmlMediaBlock(urlResult);
  if (!block) return;
  const parsedUrl = new URL(urlResult.url);
  const hostname = parsedUrl.hostname.replace(/\./g, "-");
  const pathname = parsedUrl.pathname
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/^-+|-+$/g, "");
  const suffix = pathname ? `-${pathname}` : "";
  const filename = `critical-block-${hostname}${suffix}.html`;

  const blob = new Blob([block], { type: "text/html" });
  const downloadUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = downloadUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(downloadUrl);
  showToast(`Bloco HTML baixado: ${filename}`);
}

function handleDownloadAll() {
  let downloadCount = 0;
  state.results.forEach((urlResult) => {
    if (urlResult.success) {
      handleDownloadHtmlBlock(urlResult);
      downloadCount++;
    }
  });

  if (downloadCount > 0) {
    showToast(`Baixados ${downloadCount} arquivos de bloco Drupal (.html)`);
  }
}

function exportBatchResults() {
  const exportData = {
    timestamp: new Date().toISOString(),
    summary: {
      totalUrls: state.results.length,
      successfulUrls: state.results.filter((r) => r.success).length,
      totalConfigs: state.results.reduce((sum, r) => sum + r.configs.length, 0),
      successfulConfigs: state.results.reduce(
        (sum, r) => sum + r.configs.filter((c) => c.success).length,
        0,
      ),
    },
    results: state.results.map((urlResult) => ({
      url: urlResult.url,
      success: urlResult.success,
      error: urlResult.error,
      processingTime: urlResult.processingTime,
      configs: urlResult.configs.map((configResult) => ({
        name: configResult.config.name,
        device: configResult.config.device,
        width: configResult.config.width,
        height: configResult.config.height,
        success: configResult.success,
        error: configResult.error,
        cssSize: configResult.css.length,
        css: configResult.css,
      })),
    })),
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `critical-css-batch-${
    new Date().toISOString().split("T")[0]
  }.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast("Resultados exportados em JSON");
}

async function handleRetryFailed() {
  if (!state.lastJobId) return;

  state.isLoading = true;
  render();

  try {
    const { jobId } = await fetchJson(
      `/api/critical/batch/${state.lastJobId}/retry`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ async: true }),
      },
    );
    const data = await waitForJob(jobId);
    state.batchProgress = null;

    const retriedByUrl = new Map(data.results.map((r) => [r.url, r]));
    state.results = state.results.map((r) => retriedByUrl.get(r.url) || r);
    state.lastJobId = data.jobId;

    showToast(
      `Reprocessamento: ${data.summary.successfulUrls}/${data.summary.totalUrls} executadas.`,
    );
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    state.isLoading = false;
    render();
  }
}

// Manual capture bookmarklet
// Runs in the user's own browser on the blocked page. Sends the rendered DOM
// plus every stylesheet as a separate entry (so the "ignore <head> <style>"
// option can still be applied server-side), skipping the critical blocks a
// previous run of this tool generated. Tries to POST straight to the local
// backend; when the page's CSP or Chrome's local-network protection blocks
// that, it downloads the capture as a .json file to import in this UI.
function buildBookmarklet() {
  const apiOrigin = `${location.protocol}//${location.hostname}:9001`;
  const code = `
    (function(){
      try {
        var sheets=[]; var skipped=0;
        var generatedMedia={'(max-width:991.98px)':1,'(min-width:992px)':1};
        var rebase=function(css, base){
          if(!base) return css;
          return css.replace(/url\\(\\s*(['"]?)([^'")]+?)\\1\\s*\\)/gi,function(m,q,ref){
            if(/^(data:|blob:|#|[a-z][a-z0-9+.-]*:)/i.test(ref)) return m;
            try{ var r=new URL(ref,base); return 'url('+q+(r.origin===location.origin?r.pathname+r.search+r.hash:r.href)+q+')'; }catch(e){ return m; }
          });
        };
        for (var i=0;i<document.styleSheets.length;i++){
          var sheet=document.styleSheets[i]; var owner=sheet.ownerNode;
          if (owner && owner.tagName==='STYLE' && generatedMedia[(owner.getAttribute('media')||'').replace(/\\s+/g,'').toLowerCase()]) continue;
          try{
            var rules=sheet.cssRules; var t='';
            for (var j=0;j<rules.length;j++) t+=rules[j].cssText+'\\n';
            var media=sheet.media&&sheet.media.mediaText;
            if (media && media!=='all') t='@media '+media+'{'+t+'}';
            sheets.push({css:rebase(t,sheet.href),href:sheet.href||null,inHead:!!(owner&&owner.tagName==='STYLE'&&owner.closest('head'))});
          }catch(e){ skipped++; }
        }
        var clone=document.documentElement.cloneNode(true);
        clone.querySelectorAll('link[rel=stylesheet], style, script').forEach(function(el){el.remove();});
        var capture={url:location.href.split('#')[0],html:'<!DOCTYPE html>'+clone.outerHTML,sheets:sheets,skippedSheets:skipped,capturedAt:new Date().toISOString()};
        var note=skipped?' Atencao: '+skipped+' folha(s) de CSS de outro dominio nao puderam ser lidas.':'';
        var download=function(){
          var a=document.createElement('a');
          a.href=URL.createObjectURL(new Blob([JSON.stringify(capture)],{type:'application/json'}));
          a.download='captura-'+location.hostname+(location.pathname.replace(/[^a-z0-9]+/gi,'-').replace(/-+$/,''))+'.json';
          document.body.appendChild(a); a.click(); a.remove();
          alert('O site bloqueou o envio direto, entao a captura foi BAIXADA como arquivo .json. No Critical CSS Generator, use "Importar captura (.json)".'+note);
        };
        fetch('${apiOrigin}/api/capture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(capture)})
          .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); alert('Pagina capturada e enviada! Volte ao Critical CSS Generator e gere/reprocesse esta URL.'+note); })
          .catch(download);
      } catch(e) { alert('Erro ao capturar: '+e.message); }
    })();
  `;
  return "javascript:" + encodeURIComponent(code.replace(/\s+/g, " ").trim());
}

// Imports capture files downloaded by the bookmarklet (fallback path).
async function handleImportCaptures(input) {
  const files = [...(input.files || [])];
  input.value = "";
  let imported = 0;
  for (const file of files) {
    try {
      const capture = JSON.parse(await file.text());
      await fetchJson("/api/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(capture),
      });
      imported++;
    } catch (err) {
      showToast(`Falha ao importar ${file.name}: ${err.message}`, "error");
    }
  }
  if (imported > 0) {
    showToast(`${imported} captura${imported === 1 ? "" : "s"} importada${imported === 1 ? "" : "s"}.`);
    await loadCaptures();
  }
}

async function loadCaptures() {
  try {
    const res = await fetch("/api/capture");
    const data = await res.json();
    state.captures = data.captures || [];
    render();
  } catch (err) {
    console.error("Failed to load captures", err);
  }
}

async function handleDeleteCapture(url) {
  try {
    await fetch("/api/capture", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    await loadCaptures();
    showToast("Captura manual removida");
  } catch (err) {
    showToast("Falha ao remover captura", "error");
  }
}

// -------------------------------------------------------------
// Visual validation (#validacao)
// -------------------------------------------------------------

const BLOCK_POSITIONS = {
  "body-start": "Início do <body> (região de bloco do Drupal)",
  "head-start": "Início do <head>",
  "head-end": "Fim do <head>",
};

const VERDICTS = {
  breaks: {
    label: "Quebra em produção",
    dot: "bg-rose-500",
    text: "Com o bloco nesta posição, a página final fica diferente da original mesmo depois do CSS completo carregar.",
  },
  shift: {
    label: "Layout shift na 1ª pintura",
    dot: "bg-amber-500",
    text: "A página final fica igual, mas antes do CSS completo chegar há elementos com tamanho/posição diferentes (CLS).",
  },
  visual: {
    label: "Diferenças visuais na 1ª pintura",
    dot: "bg-amber-300",
    text: "A página final fica igual e o layout não se mexe; só cores/detalhes mudam até o CSS completo chegar.",
  },
  ok: {
    label: "OK",
    dot: "bg-emerald-500",
    text: "Nenhuma diferença na página final nem na primeira dobra.",
  },
  error: { label: "Erro", dot: "bg-rose-500", text: "" },
};

function setTab(tab) {
  state.tab = tab;
  const hash = TAB_HASHES[tab] || "";
  if (location.hash !== hash) {
    history.replaceState(null, "", hash || location.pathname);
  }
  render();
  window.scrollTo(0, 0);
}

function openValidation(urlResult) {
  if (!urlResult) return;
  state.validation.url = urlResult.url;
  state.validation.blockHtml = buildHtmlMediaBlock(urlResult);
  state.validation.report = null;
  state.validation.error = "";
  setTab("validate");
  runValidation();
}

async function runValidation() {
  const v = state.validation;
  if (v.isRunning) return;
  v.url = v.url.trim();
  v.isRunning = true;
  v.error = "";
  v.report = null;
  v.step = "Iniciando...";
  render();

  try {
    const { jobId } = await fetchJson("/api/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: v.url,
        blockHtml: v.blockHtml,
        position: v.position,
      }),
    });

    let failures = 0;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL_MS));
      let job;
      try {
        job = await fetchJson(`/api/validate/${jobId}`);
        failures = 0;
      } catch (err) {
        if (++failures >= MAX_CONSECUTIVE_POLL_FAILURES) throw err;
        continue;
      }
      if (job.status === "completed") {
        v.report = job.report;
        break;
      }
      if (job.status === "failed") throw new Error(job.error);
      v.step = job.step;
      const stepEl = document.getElementById("validation-step");
      if (stepEl) stepEl.textContent = job.step;
    }
    showToast("Validação visual concluída.");
  } catch (err) {
    v.error = err.message;
    showToast(err.message, "error");
  } finally {
    v.isRunning = false;
    render();
  }
}

function downloadValidationReport() {
  const report = state.validation.report;
  if (!report) return;
  const blob = new Blob([JSON.stringify(report, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `validacao-${new URL(report.url).hostname}-${new Date()
    .toISOString()
    .slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

function renderVerdictBadge(verdict) {
  const v = VERDICTS[verdict] || VERDICTS.error;
  return `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-ash border border-hairline text-obsidian">
    <span class="w-1.5 h-1.5 rounded-full ${v.dot}"></span>${v.label}
  </span>`;
}

function renderDiffGroups(groups, emptyText) {
  if (!groups || groups.length === 0) {
    return `<p class="text-xs text-graphite">${emptyText}</p>`;
  }
  return `
    <div class="overflow-x-auto border border-hairline rounded-[6px]">
      <table class="w-full text-xs">
        <thead class="bg-ash/50 text-graphite text-left">
          <tr>
            <th class="px-3 py-2 font-medium">Qtd.</th>
            <th class="px-3 py-2 font-medium">Elemento</th>
            <th class="px-3 py-2 font-medium">Propriedade</th>
            <th class="px-3 py-2 font-medium">Original</th>
            <th class="px-3 py-2 font-medium">Com o bloco</th>
          </tr>
        </thead>
        <tbody class="font-mono">
          ${groups
            .map(
              (g) => `
            <tr class="border-t border-hairline align-top">
              <td class="px-3 py-1.5 text-graphite">${g.count}×</td>
              <td class="px-3 py-1.5 text-obsidian break-all" title="${escapeHtml(g.path)}">${escapeHtml(g.element)}</td>
              <td class="px-3 py-1.5 whitespace-nowrap">${escapeHtml(g.prop)}${
                g.kind === "layout"
                  ? ' <span class="text-amber-700 font-sans">(layout)</span>'
                  : ""
              }</td>
              <td class="px-3 py-1.5 text-graphite break-all">${escapeHtml(g.before)}</td>
              <td class="px-3 py-1.5 text-rose-700 break-all">${escapeHtml(g.after)}</td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
}

function renderViewportReport(result, productionPosition) {
  const { viewport } = result;
  const header = `
    <div class="flex items-center justify-between flex-wrap gap-3">
      <div class="flex items-center gap-2">
        <i class="fas ${viewport.name === "mobile" ? "fa-mobile-screen" : "fa-desktop"} text-sm text-obsidian"></i>
        <span class="text-sm font-medium text-obsidian capitalize">${viewport.name}</span>
        <span class="text-xs text-graphite font-mono">${viewport.width}×${viewport.height}</span>
      </div>
      ${renderVerdictBadge(result.verdict)}
    </div>`;

  if (result.verdict === "error") {
    return `<div class="border border-hairline rounded-[6px] p-5 space-y-3">${header}
      <div class="p-3 bg-rose-50/50 border border-rose-200 rounded-[6px] text-xs text-rose-800">${escapeHtml(result.error)}</div></div>`;
  }

  const fc = result.finalCascade;
  const fp = result.firstPaint;
  const safePositions = Object.keys(BLOCK_POSITIONS).filter((p) => fc[p]?.diffCount === 0);
  const prodBreaks = fc[productionPosition].diffCount > 0;

  return `
    <div class="border border-hairline rounded-[6px] p-5 space-y-6">
      ${header}
      <p class="text-xs text-graphite -mt-3">${VERDICTS[result.verdict].text}${
        result.removedOldBlocks
          ? ` · ${result.removedOldBlocks} bloco(s) crítico(s) antigo(s) já presente(s) na página foram removidos para o teste.`
          : ""
      }</p>

      <!-- Test B -->
      <div class="space-y-3">
        <div>
          <div class="text-sm font-medium text-obsidian">Teste B · Página final (depois que todo o CSS carrega)</div>
          <div class="text-xs text-graphite mt-0.5">O bloco continua no HTML para sempre. Se ele vier depois das folhas completas no cascade, pode sobrescrever regras e quebrar a página.</div>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
          ${Object.entries(BLOCK_POSITIONS)
            .map(([pos, label]) => {
              const n = fc[pos].diffCount;
              return `
            <div class="p-3 border rounded-[6px] text-xs ${
              pos === productionPosition ? "border-obsidian" : "border-hairline"
            }">
              <div class="flex items-center gap-1.5">
                <span class="w-1.5 h-1.5 rounded-full ${n === 0 ? "bg-emerald-500" : "bg-rose-500"}"></span>
                <span class="font-medium text-obsidian">${n === 0 ? "Seguro" : `${n} diferença${n === 1 ? "" : "s"}`}</span>
                ${pos === productionPosition ? '<span class="text-graphite">· posição escolhida</span>' : ""}
              </div>
              <div class="text-graphite mt-1">${escapeHtml(label)}</div>
            </div>`;
            })
            .join("")}
        </div>
        ${
          prodBreaks && safePositions.length > 0
            ? `<div class="p-3 bg-amber-50/60 border border-amber-200 rounded-[6px] text-xs text-amber-900">
                Na posição escolhida o bloco quebra a página, mas em <strong>${safePositions
                  .map((p) => escapeHtml(BLOCK_POSITIONS[p]))
                  .join(" / ")}</strong> não. Mude onde o bloco é impresso no Drupal, ou remova o bloco depois que o CSS completo carregar.
              </div>`
            : prodBreaks
              ? `<div class="p-3 bg-rose-50/50 border border-rose-200 rounded-[6px] text-xs text-rose-800">
                  O bloco altera a página final em qualquer posição: alguma regra do CSS crítico tem prioridade (especificidade ou <code>!important</code>) sobre a original. Ajuste os seletores excluídos ou remova o bloco depois que o CSS completo carregar.
                </div>`
              : ""
        }
        ${prodBreaks ? renderDiffGroups(fc[productionPosition].groups, "") : ""}
      </div>

      <!-- Test A -->
      <div class="space-y-3 pt-4 border-t border-hairline">
        <div>
          <div class="text-sm font-medium text-obsidian">Teste A · Primeira pintura (só o CSS crítico, primeira dobra)</div>
          <div class="text-xs text-graphite mt-0.5">O que o visitante vê antes das folhas completas chegarem.</div>
        </div>
        <div class="flex flex-wrap gap-2 text-xs">
          <span class="px-2.5 py-1 rounded-full border border-hairline"><strong class="font-medium">${fp.counts.layout}</strong> <span class="text-graphite">de layout</span></span>
          <span class="px-2.5 py-1 rounded-full border border-hairline"><strong class="font-medium">${fp.movedCount}</strong> <span class="text-graphite">elementos mudam de posição/tamanho</span></span>
          <span class="px-2.5 py-1 rounded-full border border-hairline"><strong class="font-medium">${fp.counts.visual}</strong> <span class="text-graphite">visuais</span></span>
          <span class="px-2.5 py-1 rounded-full border border-hairline" title="Fundos SVG/data URI removidos de propósito pelo gerador; chegam com o CSS completo"><strong class="font-medium">${fp.counts.expected}</strong> <span class="text-graphite">esperadas (fundos removidos de propósito)</span></span>
          <span class="px-2.5 py-1 rounded-full border border-hairline"><strong class="font-medium">${fp.pixelDiff.percent}%</strong> <span class="text-graphite">dos pixels diferentes</span></span>
        </div>
        ${renderDiffGroups(fp.groups, "Nenhuma diferença de estilo na primeira dobra.")}
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          ${[
            ["Original (CSS completo)", result.screenshots.original],
            ["1ª pintura (só CSS crítico)", result.screenshots.firstPaint],
            [`Diferença · ${fp.pixelDiff.percent}%`, result.screenshots.diff],
          ]
            .map(
              ([label, b64]) => `
            <figure class="space-y-1.5">
              <figcaption class="text-xs text-graphite">${label}</figcaption>
              <img src="data:image/jpeg;base64,${b64}" alt="${label}"
                class="w-full max-h-[520px] object-contain object-top border border-hairline rounded-[6px] bg-ash" />
            </figure>`,
            )
            .join("")}
        </div>
        <p class="text-[11px] text-graphite">Fontes web também chegam com o CSS completo, então diferenças de texto nas imagens são normais. A tabela compara os estilos computados e é a referência mais precisa.</p>
      </div>
    </div>`;
}

function renderValidationTab() {
  const v = state.validation;
  return `
    <section class="pt-12 pb-2 space-y-3">
      <div class="text-xs uppercase tracking-wider font-medium text-graphite">Garantia de qualidade</div>
      <h1 class="text-[34px] sm:text-[44px] font-medium text-obsidian tracking-[-1.44px] leading-[1.12]">Validação Visual</h1>
      <p class="text-graphite text-[17px] leading-[1.65] max-w-2xl">
        Injeta o bloco gerado na página real e compara o estilo computado de cada elemento com a página original, em mobile e desktop. Use antes de publicar: se a página final mudar, o bloco vai quebrar o site.
      </p>
    </section>

    <div class="card-editorial p-6 sm:p-8 space-y-5">
      <div class="space-y-2">
        <label class="text-sm font-medium text-obsidian">URL da página</label>
        <input type="url" value="${escapeHtml(v.url)}" oninput="state.validation.url = this.value"
          placeholder="${escapeHtml(urlPlaceholder())}"
          class="input-prompt w-full px-4 text-sm text-obsidian placeholder:text-smoke bg-paper" />
        <p class="text-xs text-graphite">Para domínios atrás de WAF/anti-bot, valide pelo ambiente de homologação/staging sem WAF.</p>
      </div>
      <div class="space-y-2">
        <label class="text-sm font-medium text-obsidian">Bloco HTML do CSS crítico</label>
        <textarea rows="8" oninput="state.validation.blockHtml = this.value" spellcheck="false"
          placeholder='<style media="(max-width: 991.98px)">...</style>'
          class="w-full font-mono text-xs p-3 bg-paper text-obsidian rounded-[6px] border border-hairline focus:outline-none focus:border-obsidian resize-y">${escapeHtml(v.blockHtml)}</textarea>
        <p class="text-xs text-graphite">Preenchido automaticamente pelo botão "Validar visual" de cada resultado, ou cole um bloco já publicado.</p>
      </div>
      <div class="space-y-2">
        <label class="text-sm font-medium text-obsidian">Onde o bloco fica em produção</label>
        <select onchange="state.validation.position = this.value"
          class="w-full sm:w-auto px-4 py-2.5 text-sm rounded-full border border-hairline bg-paper text-obsidian">
          ${Object.entries(BLOCK_POSITIONS)
            .map(
              ([pos, label]) =>
                `<option value="${pos}" ${v.position === pos ? "selected" : ""}>${escapeHtml(label)}</option>`,
            )
            .join("")}
        </select>
        <p class="text-xs text-graphite">As três posições são testadas; esta define o veredito e o Teste A.</p>
      </div>
      <button onclick="runValidation()" ${v.isRunning ? "disabled" : ""} class="btn-filled w-full !py-3.5 text-sm">
        ${
          v.isRunning
            ? `<i class="fas fa-spinner fa-spin text-xs"></i> <span id="validation-step">${escapeHtml(v.step)}</span>`
            : '<span>Validar bloco</span> <i class="fas fa-arrow-right text-xs"></i>'
        }
      </button>
      ${
        v.error
          ? `<div class="p-4 border border-rose-200 bg-rose-50/50 rounded-[6px] text-xs text-rose-800 flex items-start gap-2">
              <i class="fas fa-circle-exclamation mt-0.5"></i><span>${escapeHtml(v.error)}</span></div>`
          : ""
      }
    </div>

    ${
      v.report
        ? `
      <div class="card-editorial p-6 sm:p-8 space-y-6">
        <div class="flex items-center justify-between flex-wrap gap-3 pb-2 border-b border-hairline">
          <div>
            <h2 class="text-[22px] font-medium text-obsidian">Resultado</h2>
            <p class="text-xs text-graphite font-mono mt-1">${escapeHtml(v.report.url)}</p>
          </div>
          <button onclick="downloadValidationReport()" class="btn-outline text-xs !py-1.5 !px-3">
            <i class="fas fa-download text-xs"></i> Relatório (.json)
          </button>
        </div>
        ${v.report.results.map((r) => renderViewportReport(r, v.report.position)).join("")}
      </div>`
        : ""
    }
  `;
}

// -------------------------------------------------------------
// Central de configurações (critical.config.json via /api/settings)
// -------------------------------------------------------------

const BROWSER_CHANNELS = [
  ["", "Headless shell do Playwright (padrão, um download só)"],
  ["chromium", "Chromium completo (npx playwright install chromium)"],
  ["chrome", "Google Chrome instalado no sistema"],
  ["msedge", "Microsoft Edge instalado no sistema"],
];

const lines = (list) => (list || []).join("\n");
const fromLines = (text) =>
  String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

function urlPlaceholder() {
  return state.settings.form?.urlPlaceholder || "https://www.example.com/";
}

// Settings values (arrays/objects) -> plain strings the form edits.
function toSettingsForm(values) {
  return {
    ignoredStylesheets: lines(values.ignoredStylesheets),
    ignoredSelectorPatterns: lines(values.ignoredSelectorPatterns),
    defaultExcludedSelectors: lines(values.defaultExcludedSelectors),
    acceptLanguage: values.acceptLanguage || "",
    urlPlaceholder: values.urlPlaceholder || "",
    proxies: Object.entries(values.proxies || {})
      .map(([host, url]) => `${host} = ${url}`)
      .join("\n"),
    browserChannel: values.browser?.channel || "",
    browserLaunchArgs: lines(values.browser?.launchArgs),
    hooksFile: values.hooksFile || "",
  };
}

function fromSettingsForm(form) {
  const proxies = {};
  for (const line of fromLines(form.proxies)) {
    const at = line.indexOf("=");
    if (at === -1) throw new Error(`Proxy sem "=": ${line}`);
    proxies[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return {
    ignoredStylesheets: fromLines(form.ignoredStylesheets),
    ignoredSelectorPatterns: fromLines(form.ignoredSelectorPatterns),
    defaultExcludedSelectors: fromLines(form.defaultExcludedSelectors),
    acceptLanguage: form.acceptLanguage.trim(),
    urlPlaceholder: form.urlPlaceholder.trim(),
    proxies,
    browser: {
      channel: form.browserChannel,
      launchArgs: fromLines(form.browserLaunchArgs),
    },
    hooksFile: form.hooksFile.trim(),
  };
}

function applySettings(data) {
  const previousDefaults = [...defaultExcludedSelectors];
  defaultExcludedSelectors = [...data.values.defaultExcludedSelectors];
  // Only follow the new defaults if the user hasn't edited the list yet.
  if (lines(state.excludedSelectors) === lines(previousDefaults)) {
    state.excludedSelectors = [...defaultExcludedSelectors];
  }
  Object.assign(state.settings, {
    loaded: true,
    file: data.file,
    exists: data.exists,
    defaults: data.defaults,
    form: toSettingsForm(data.values),
  });
}

async function loadSettings() {
  try {
    applySettings(await fetchJson("/api/settings"));
  } catch (error) {
    state.settings.error = `Não foi possível carregar as configurações: ${error.message}`;
  }
  render();
}

function updateSettingsField(field, value) {
  state.settings.form[field] = value;
  state.settings.message = "";
}

function resetSettingsForm() {
  if (!state.settings.defaults) return;
  state.settings.form = toSettingsForm(state.settings.defaults);
  state.settings.message = "Padrões carregados no formulário. Salve para aplicar.";
  state.settings.error = "";
  render();
}

async function saveSettings() {
  const st = state.settings;
  if (st.isSaving || !st.form) return;
  st.isSaving = true;
  st.error = "";
  st.message = "";
  render();
  try {
    const values = fromSettingsForm(st.form);
    const data = await fetchJson("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    });
    applySettings(data);
    st.message = data.browserRestarted
      ? "Configurações salvas. O navegador será reaberto na próxima captura."
      : "Configurações salvas.";
    showToast("Configurações salvas.");
  } catch (error) {
    st.error = error.message;
  } finally {
    st.isSaving = false;
    render();
  }
}

function renderSettingsField({ field, label, help, rows = 0, placeholder = "", mono = true }) {
  const value = escapeHtml(state.settings.form[field]);
  const common = `oninput="updateSettingsField('${field}', this.value)" spellcheck="false" placeholder="${escapeHtml(placeholder)}"`;
  const input = rows
    ? `<textarea rows="${rows}" ${common}
        class="w-full ${mono ? "font-mono" : ""} text-xs p-3 bg-paper text-obsidian rounded-[6px] border border-hairline focus:outline-none focus:border-obsidian resize-y">${value}</textarea>`
    : `<input type="text" value="${value}" ${common}
        class="input-prompt w-full px-4 text-sm ${mono ? "font-mono" : ""} text-obsidian placeholder:text-smoke bg-paper" />`;
  return `
    <div class="space-y-2">
      <label class="text-sm font-medium text-obsidian">${label}</label>
      ${input}
      <p class="text-xs text-graphite leading-relaxed">${help}</p>
    </div>`;
}

function renderSettingsGroup(title, description, fields) {
  return `
    <div class="card-editorial p-6 sm:p-8 space-y-5">
      <div>
        <h2 class="text-[22px] font-medium text-obsidian tracking-[-0.22px]">${title}</h2>
        <p class="text-graphite text-sm mt-1 leading-relaxed">${description}</p>
      </div>
      ${fields}
    </div>`;
}

function renderSettingsTab() {
  const st = state.settings;
  const header = `
    <section class="pt-12 pb-2 space-y-3">
      <div class="text-xs uppercase tracking-wider font-medium text-graphite">Central de configurações</div>
      <h1 class="text-[34px] sm:text-[44px] font-medium text-obsidian tracking-[-1.44px] leading-[1.12]">Configurações</h1>
      <p class="text-graphite text-[17px] leading-[1.65] max-w-2xl">
        Ajustes específicos dos seus projetos. Ficam em <code>${escapeHtml(st.file || "critical.config.json")}</code>, que não vai para o git, e valem a partir da próxima geração.
        ${st.loaded && !st.exists ? "<br><span class=\"text-sm\">Nenhum arquivo salvo ainda: os valores abaixo são os padrões.</span>" : ""}
      </p>
    </section>`;

  if (!st.form) {
    return `${header}
      <div class="card-editorial p-6 sm:p-8 text-sm text-graphite">
        ${st.error ? escapeHtml(st.error) : '<i class="fas fa-spinner fa-spin text-xs"></i> Carregando...'}
      </div>`;
  }

  const channelOptions = BROWSER_CHANNELS.map(
    ([value, label]) =>
      `<option value="${value}" ${st.form.browserChannel === value ? "selected" : ""}>${escapeHtml(label)}</option>`,
  ).join("");

  return `
    ${header}

    ${renderSettingsGroup(
      "Filtros do CSS crítico",
      "O que nunca deve entrar no bloco gerado.",
      [
        renderSettingsField({
          field: "ignoredStylesheets",
          label: "Folhas de estilo ignoradas",
          help: "Um trecho de URL por linha. Toda folha cuja URL contém o trecho fica fora do CSS crítico (bibliotecas de ícones, print, widgets de terceiros).",
          rows: 5,
          placeholder: "print.css\nicon-library.css",
        }),
        renderSettingsField({
          field: "ignoredSelectorPatterns",
          label: "Padrões de seletores ignorados (RegExp)",
          help: "Uma expressão regular por linha, sem diferenciar maiúsculas. Todo seletor do resultado que casar é removido.",
          rows: 4,
          placeholder: "^\\.social-feed\n#chat-widget",
        }),
        renderSettingsField({
          field: "defaultExcludedSelectors",
          label: "Seletores excluídos por padrão",
          help: "Um seletor por linha. Pré-preenchem o campo de exclusões na aba Gerar: os elementos saem do snapshot e as regras deles saem do resultado.",
          rows: 4,
          placeholder: ".modal\n#cookie-banner",
        }),
      ].join(""),
    )}

    ${renderSettingsGroup(
      "Acesso às páginas",
      "Como o navegador visita os sites.",
      [
        renderSettingsField({
          field: "acceptLanguage",
          label: "Accept-Language",
          help: "Enviado em todas as visitas. Use o idioma do mercado do site para receber o conteúdo certo. Vazio usa o padrão do navegador.",
          placeholder: "pt-BR,pt;q=0.9,en;q=0.8",
        }),
        renderSettingsField({
          field: "proxies",
          label: "Proxies por domínio",
          help: "Uma linha por domínio: <code>hostname = http://usuario:senha@host:porta</code>. Usados quando o acesso direto é bloqueado. Senhas aparecem mascaradas; mantenha <code>********</code> para não alterar.",
          rows: 3,
          placeholder: "www.example.com = http://user:pass@proxy-host:8080",
        }),
        renderSettingsField({
          field: "urlPlaceholder",
          label: "URL de exemplo",
          help: "Texto de exemplo dos campos de URL.",
          placeholder: "https://www.example.com/",
        }),
      ].join(""),
    )}

    ${renderSettingsGroup(
      "Navegador",
      "Mudanças aqui reabrem o navegador na próxima captura.",
      `
        <div class="space-y-2">
          <label class="text-sm font-medium text-obsidian">Navegador das capturas</label>
          <select onchange="updateSettingsField('browserChannel', this.value)"
            class="w-full sm:w-auto px-4 py-2.5 text-sm rounded-full border border-hairline bg-paper text-obsidian">
            ${channelOptions}
          </select>
          <p class="text-xs text-graphite leading-relaxed">O padrão é o mesmo navegador que o critical usa para renderizar, então só um download é necessário.</p>
        </div>
        ${renderSettingsField({
          field: "browserLaunchArgs",
          label: "Flags extras do Chromium",
          help: "Uma flag por linha, ex.: <code>--lang=pt-BR</code>.",
          rows: 3,
        })}
        ${renderSettingsField({
          field: "hooksFile",
          label: "Arquivo de hooks do navegador",
          help: "Módulo ES opcional, relativo à raiz do projeto, para customizar contexto e páginas (ver README). Arquivo ausente = sem hooks. A pasta <code>local/</code> é ignorada pelo git.",
          placeholder: "local/browser-hooks.js",
        })}
      `,
    )}

    <div class="flex flex-wrap items-center gap-3">
      <button onclick="saveSettings()" ${st.isSaving ? "disabled" : ""} class="btn-filled text-sm !py-3 !px-6">
        ${st.isSaving ? '<i class="fas fa-spinner fa-spin text-xs"></i> Salvando...' : "Salvar configurações"}
      </button>
      <button onclick="resetSettingsForm()" class="btn-outline text-sm !py-3 !px-6">Restaurar padrões</button>
      ${st.message ? `<span class="text-xs text-emerald-700">${escapeHtml(st.message)}</span>` : ""}
    </div>
    ${
      st.error
        ? `<div class="p-4 border border-rose-200 bg-rose-50/50 rounded-[6px] text-xs text-rose-800 flex items-start gap-2">
            <i class="fas fa-circle-exclamation mt-0.5"></i><span>${escapeHtml(st.error)}</span></div>`
        : ""
    }
  `;
}

// -------------------------------------------------------------
// Component Renderers (OpenAI Style Guide)
// -------------------------------------------------------------

function renderTopNav() {
  return `
    <header class="sticky top-0 z-40 bg-paper/90 backdrop-blur-md border-b border-hairline">
      <div class="max-w-[1200px] mx-auto px-6 h-16 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <span class="text-sm font-medium tracking-tight text-obsidian">Critical CSS</span>
          <span class="text-[11px] font-medium tracking-normal text-graphite px-2 py-0.5 rounded-full border border-hairline bg-ash/50">
            Drupal 1st Fold
          </span>
        </div>

        <nav class="flex items-center gap-2 sm:gap-4">
          <div class="inline-flex p-1 bg-ash rounded-full border border-hairline">
            ${[
              ["generate", "Gerar"],
              ["validate", "Validação Visual"],
              ["settings", "Configurações"],
            ]
              .map(
                ([tab, label]) => `
              <button
                type="button"
                onclick="setTab('${tab}')"
                class="px-3.5 py-1 rounded-full text-xs font-medium transition-all ${
                  state.tab === tab
                    ? "bg-paper text-obsidian shadow-sm border border-hairline"
                    : "text-graphite hover:text-obsidian"
                }"
              >${label}${
                  tab === "validate" && state.validation.isRunning
                    ? ' <i class="fas fa-spinner fa-spin text-[10px] ml-1"></i>'
                    : ""
                }</button>`,
              )
              .join("")}
          </div>
          <a href="#capture-section" onclick="setTab('generate')" class="btn-ghost text-xs hidden md:inline-flex text-graphite hover:text-obsidian">Captura Manual</a>
          
          <button
            onclick="handleBatchGenerate()"
            ${state.isLoading ? "disabled" : ""}
            class="btn-filled text-xs !py-1.5 !px-4"
          >
            ${state.isLoading ? '<i class="fas fa-spinner fa-spin text-xs"></i> Gerando...' : "Gerar CSS"}
          </button>
        </nav>
      </div>
    </header>
  `;
}

function renderHero() {
  const hasUrls = state.urls.some((u) => u.trim() !== "");

  return `
    <section class="pt-12 pb-8 sm:pt-16 sm:pb-12 text-left space-y-5">
      <div class="space-y-3">
        <div class="text-xs uppercase tracking-wider font-medium text-graphite">Research &amp; Performance Lab</div>
        <h1 class="text-[34px] sm:text-[44px] md:text-[48px] font-medium text-obsidian tracking-[-1.44px] leading-[1.12]">
          Critical CSS Generator
        </h1>
        <p class="text-graphite text-[17px] leading-[1.65] tracking-[-0.18px] max-w-2xl font-normal">
          Extração padronizada de CSS da primeira dobra para blocos Drupal. Segregação limpa entre Mobile (&le;991.98px) e Desktop (&ge;992px), com isolamento estrito para respeitar o orçamento TCP de 14.6KB gzip.
        </p>
      </div>

      <!-- Quick action chip row (Bases prontas) -->
      <div class="flex flex-wrap items-center gap-2 pt-1">
        <button
          onclick="addUrl()"
          class="btn-outline text-xs !py-1.5 !px-3.5"
        >
          + Adicionar URL
        </button>
        <button
          onclick="toggleBatchPaste()"
          class="btn-outline text-xs !py-1.5 !px-3.5"
        >
          <i class="fas fa-list-ul text-xs text-graphite mr-1"></i>
          <span>${state.showBatchPaste ? "Fechar Colar em Lote" : "Colar em Lote"}</span>
        </button>
        ${
          hasUrls || state.urls.length > 1
            ? `
          <button
            onclick="clearUrls()"
            class="btn-ghost text-xs text-graphite hover:text-obsidian !py-1.5 !px-3"
          >
            Limpar lista
          </button>
        `
            : ""
        }
      </div>
    </section>
  `;
}

function renderUrlsSection() {
  const validCount = state.urls.filter((u) => u.trim() !== "").length;

  return `
    <div class="space-y-4">
      <div class="flex items-center justify-between pb-1 flex-wrap gap-2">
        <div>
          <label class="text-sm font-medium text-obsidian">URLs de Destino</label>
          <p class="text-xs text-graphite mt-0.5">Páginas que terão o CSS crítico extraído para primeira dobra</p>
        </div>
        <div class="flex items-center gap-2">
          <button
            onclick="toggleBatchPaste()"
            class="btn-outline text-xs !py-1.5 !px-3"
          >
            <i class="fas fa-list-ul text-xs text-graphite mr-1"></i>
            <span>${state.showBatchPaste ? "Modo Individual" : "Colar em Lote"}</span>
          </button>
          <button
            onclick="addUrl()"
            class="btn-outline text-xs !py-1.5 !px-3"
          >
            + Adicionar URL
          </button>
        </div>
      </div>

      ${
        state.showBatchPaste
          ? `
        <div class="p-4 border border-hairline rounded-[6px] bg-ash/30 space-y-3">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-obsidian">Cole uma lista de URLs (uma por linha):</span>
            <span class="text-[11px] text-graphite">Linhas vazias serão ignoradas</span>
          </div>
          <textarea
            id="batch-paste-textarea"
            rows="6"
            class="w-full font-mono text-xs p-3 bg-paper text-obsidian rounded-[6px] border border-hairline focus:outline-none focus:border-obsidian selection:bg-ash resize-y"
            placeholder="https://example.com/pagina-1&#10;https://example.com/pagina-2&#10;https://example.com/pagina-3"
          ></textarea>
          <div class="flex items-center justify-end gap-2">
            <button
              onclick="toggleBatchPaste()"
              class="btn-ghost text-xs !py-1.5 !px-3"
            >
              Cancelar
            </button>
            <button
              onclick="applyBatchUrls(document.getElementById('batch-paste-textarea').value)"
              class="btn-filled text-xs !py-1.5 !px-4"
            >
              Aplicar URLs
            </button>
          </div>
        </div>
      `
          : `
        <div class="space-y-2.5">
          ${state.urls
            .map(
              (url, index) => `
            <div class="relative flex items-center group">
              <span class="absolute left-4 font-mono text-xs text-smoke select-none pointer-events-none">
                ${(index + 1).toString().padStart(2, "0")}
              </span>
              <input
                type="url"
                placeholder="https://example.com/pagina"
                value="${url}"
                oninput="updateUrl(${index}, this.value)"
                onkeydown="if(event.key === 'Enter'){ event.preventDefault(); addUrl(); }"
                onpaste="handlePasteUrls(event, ${index})"
                class="url-input input-prompt w-full pl-12 pr-12 text-sm text-obsidian placeholder:text-smoke bg-paper hover:border-black/30 transition-colors"
              />
              ${
                state.urls.length > 1
                  ? `
                <button
                  onclick="removeUrl(${index})"
                  class="absolute right-3 p-1.5 text-smoke hover:text-obsidian rounded-full hover:bg-ash transition-colors"
                  title="Remover URL"
                >
                  <i class="fas fa-times text-xs"></i>
                </button>
              `
                  : ""
              }
            </div>
          `,
            )
            .join("")}
        </div>
      `
      }

      <div class="flex items-center justify-between pt-1 text-xs text-graphite">
        <span id="valid-urls-count">${validCount} URL${validCount === 1 ? "" : "s"} válida${validCount === 1 ? "" : "s"} para processamento</span>
        ${
          !state.showBatchPaste
            ? `
          <button
            onclick="addUrl()"
            class="text-obsidian font-medium hover:underline cursor-pointer"
          >
            + Adicionar mais uma URL
          </button>
        `
            : ""
        }
      </div>
    </div>
  `;
}

function renderConfigurationCard() {
  const validUrls = state.urls.filter((url) => url.trim() !== "");

  return `
    <div id="config-section" class="card-editorial p-6 sm:p-8 space-y-8">
      <div>
        <h2 class="text-[22px] font-medium text-obsidian tracking-[-0.22px]">Configuração do Motor</h2>
        <p class="text-graphite text-sm mt-1">Defina as regras de extração e otimização para o bloco Drupal</p>
      </div>

      ${renderUrlsSection()}

      <!-- CSS Separation Mode -->
      <div class="space-y-3 pt-4 border-t border-hairline">
        <label class="text-sm font-medium text-obsidian">Modo de Separação de CSS</label>
        
        <div class="inline-flex p-1 bg-ash rounded-full border border-hairline">
          <button
            type="button"
            onclick="state.combineDimensions = false; render();"
            class="px-4 py-1.5 rounded-full text-xs font-medium transition-all ${
              !state.combineDimensions
                ? "bg-paper text-obsidian shadow-sm border border-hairline"
                : "text-graphite hover:text-obsidian"
            }"
          >
            Separar Mobile e Desktop (Recomendado Drupal)
          </button>
          <button
            type="button"
            onclick="state.combineDimensions = true; render();"
            class="px-4 py-1.5 rounded-full text-xs font-medium transition-all ${
              state.combineDimensions
                ? "bg-paper text-obsidian shadow-sm border border-hairline"
                : "text-graphite hover:text-obsidian"
            }"
          >
            Combinar em arquivo único
          </button>
        </div>
      </div>

      <!-- Viewports preset chips -->
      <div class="space-y-3 pt-4 border-t border-hairline">
        <div class="flex items-center justify-between">
          <label class="text-sm font-medium text-obsidian">Viewports de Primeira Dobra</label>
          <span class="text-xs text-graphite">Padronizado · 2 resoluções</span>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          ${Object.values(presetConfigs)
            .map(
              (config) => `
            <div class="p-3.5 border border-hairline rounded-[6px] bg-paper flex items-center justify-between">
              <div class="flex items-center gap-3">
                <i class="fas ${
                  config.device === "mobile"
                    ? "fa-mobile-screen text-obsidian"
                    : "fa-desktop text-obsidian"
                } text-sm"></i>
                <div>
                  <div class="text-sm font-medium text-obsidian">${config.name}</div>
                  <div class="text-xs text-graphite">${config.width} &times; ${config.height}px</div>
                </div>
              </div>
              <span class="text-[11px] font-mono text-graphite px-2 py-0.5 rounded-full bg-ash border border-hairline">
                ${config.device === "mobile" ? "&le;991.98px" : "&ge;992px"}
              </span>
            </div>
          `,
            )
            .join("")}
        </div>
        <p class="text-xs text-graphite">
          Configuração fixa para manter o CSS cirúrgico e evitar inchaço do pacote com viewports intermediários.
        </p>
      </div>

      <!-- Performance & TCP Budget Controls -->
      <div class="space-y-4 pt-4 border-t border-hairline">
        <label class="text-sm font-medium text-obsidian flex items-center gap-2">
          <span>Otimizações Avançadas de Performance</span>
        </label>
        
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label class="flex items-start p-4 border border-hairline rounded-[6px] bg-paper hover:bg-ash/40 cursor-pointer transition">
            <input
              type="checkbox"
              ${state.aggressivePruning ? "checked" : ""}
              onchange="state.aggressivePruning = this.checked; render();"
              class="mt-0.5 mr-3 h-4 w-4 rounded accent-black cursor-pointer"
            />
            <div class="space-y-1">
              <div class="text-sm font-medium text-obsidian">Poda Agressiva de Regras</div>
              <div class="text-xs text-graphite leading-relaxed">
                Remove pseudo-classes (:hover, :active), regras @media print e variáveis CSS :root não referenciadas na primeira dobra. Reduz em até 60% o peso final.
              </div>
            </div>
          </label>

          <label class="flex items-start p-4 border border-hairline rounded-[6px] bg-paper hover:bg-ash/40 cursor-pointer transition">
            <input
              type="checkbox"
              ${state.isolateFirstFold ? "checked" : ""}
              onchange="state.isolateFirstFold = this.checked; render();"
              class="mt-0.5 mr-3 h-4 w-4 rounded accent-black cursor-pointer"
            />
            <div class="space-y-1">
              <div class="text-sm font-medium text-obsidian">Isolar Estritamente a 1ª Dobra</div>
              <div class="text-xs text-graphite leading-relaxed">
                Desativa o scroll prévio pelo navegador sem cabeça, impedindo que carrosséis inferiores, modais e scripts lazy injetem regras no CSS crítico.
              </div>
            </div>
          </label>

          <label class="flex items-start p-4 border border-hairline rounded-[6px] bg-paper hover:bg-ash/40 cursor-pointer transition">
            <input
              type="checkbox"
              ${state.ignoreHeadInlineStyles ? "checked" : ""}
              onchange="state.ignoreHeadInlineStyles = this.checked; render();"
              class="mt-0.5 mr-3 h-4 w-4 rounded accent-black cursor-pointer"
            />
            <div class="space-y-1">
              <div class="text-sm font-medium text-obsidian">Ignorar &lt;style&gt; do &lt;head&gt;</div>
              <div class="text-xs text-graphite leading-relaxed">
                Monta o CSS crítico só a partir das folhas externas (e de &lt;style&gt; no &lt;body&gt;), descartando as tags &lt;style&gt; inline do &lt;head&gt; — ex.: um CSS crítico antigo já aplicado. Desative em sites que injetam CSS via JS (CSS-in-JS) no &lt;head&gt;.
              </div>
            </div>
          </label>
        </div>

        <!-- TCP 14.6KB Guidance note -->
        <div class="p-4 bg-ash/60 border border-hairline rounded-[6px] text-xs text-graphite flex flex-wrap items-center justify-between gap-3">
          <div class="flex items-center gap-2.5">
            <span class="w-2 h-2 rounded-full bg-obsidian shrink-0"></span>
            <span>
              <strong class="text-obsidian font-medium">Janela Inicial TCP (initcwnd):</strong> 
              Teto estrito de 14.6KB gzip por viewport. Meta ideal &le; 10KB para ser entregue com o HTML inicial no primeiro RTT.
            </span>
          </div>
          <span class="font-mono text-[11px] px-2.5 py-0.5 rounded-full bg-paper border border-hairline text-obsidian font-medium">
            Teto: 14.6KB Gzip
          </span>
        </div>
      </div>

      <!-- Processing indicator / progress bar -->
      ${
        state.batchProgress
          ? `
        <div class="space-y-2 pt-2">
          <div class="flex items-center justify-between text-xs text-graphite">
            <span class="font-medium text-obsidian">Processando URLs com navegador automatizado...</span>
            <span id="batch-progress-label" class="font-mono">${state.batchProgress.completed} / ${state.batchProgress.total}</span>
          </div>
          <div class="w-full bg-ash rounded-full h-1.5 overflow-hidden">
            <div
              id="batch-progress-bar"
              class="bg-obsidian h-full transition-all duration-300 rounded-full" 
              style="width: ${
                (state.batchProgress.completed / state.batchProgress.total) *
                100
              }%"
            ></div>
          </div>
        </div>
      `
          : ""
      }

      <!-- Primary Action CTA: Sole filled button in the page -->
      <div class="pt-2">
        <button
          onclick="handleBatchGenerate()"
          ${state.isLoading || validUrls.length === 0 ? "disabled" : ""}
          class="btn-filled w-full !py-3.5 text-sm"
        >
          ${
            state.isLoading
              ? `
            <i class="fas fa-spinner fa-spin text-xs"></i>
            <span>Processando ${validUrls.length} URL${validUrls.length === 1 ? "" : "s"}...</span>
          `
              : `
            <span>Gerar CSS Crítico para ${validUrls.length} URL${validUrls.length === 1 ? "" : "s"}</span>
            <i class="fas fa-arrow-right text-xs"></i>
          `
          }
        </button>
      </div>

      ${
        state.error
          ? `
        <div class="p-4 border border-rose-200 bg-rose-50/50 rounded-[6px] text-xs text-rose-800 flex items-start gap-2">
          <i class="fas fa-circle-exclamation mt-0.5"></i>
          <span>${escapeHtml(state.error)}</span>
        </div>
      `
          : ""
      }
    </div>
  `;
}

function renderResults() {
  if (state.results.length === 0) return "";

  const successfulUrls = state.results.filter((r) => r.success).length;

  return `
    <div id="results-section" class="card-editorial p-6 sm:p-8 space-y-6">
      <div class="flex items-center justify-between flex-wrap gap-4 pb-2 border-b border-hairline">
        <div>
          <h2 class="text-[24px] font-semibold text-obsidian tracking-[0.31px]">CSS Crítico para Bloco Drupal</h2>
          <p class="text-graphite text-xs mt-1">
            ${successfulUrls} de ${state.results.length} URLs processadas com sucesso · Pronto para produção
          </p>
        </div>

        <div class="flex items-center gap-2 flex-wrap">
          ${
            state.results.some((r) => !r.success) && state.lastJobId
              ? `
            <button
              onclick="handleRetryFailed()"
              ${state.isLoading ? "disabled" : ""}
              class="btn-outline text-xs !py-1.5 !px-3"
            >
              <i class="fas fa-redo text-xs"></i> Reprocessar falhas
            </button>
          `
              : ""
          }
          <button
            onclick="exportBatchResults()"
            class="btn-outline text-xs !py-1.5 !px-3"
          >
            Exportar JSON
          </button>
          <button
            onclick="handleDownloadAll()"
            ${successfulUrls === 0 ? "disabled" : ""}
            class="btn-outline text-xs !py-1.5 !px-3 font-medium !bg-ash/70 hover:!bg-ash"
          >
            <i class="fas fa-download text-xs"></i> Baixar Todos (.html)
          </button>
        </div>
      </div>

      <!-- Results list -->
      <div class="space-y-5">
        ${state.results
          .map((urlResult, urlIndex) => {
            const mobileConfig = urlResult.configs?.find(
              (c) =>
                c.success &&
                (c.config?.device === "mobile" ||
                  (c.config?.width && c.config.width < 768)),
            );
            const desktopConfig = urlResult.configs?.find(
              (c) =>
                c.success &&
                (c.config?.device === "desktop" ||
                  (c.config?.width && c.config.width >= 768)),
            );

            return `
          <div class="border border-hairline rounded-[6px] overflow-hidden bg-paper">
            <!-- URL Header -->
            <div class="p-4 bg-ash/30 border-b border-hairline flex items-center justify-between flex-wrap gap-3">
              <div class="flex items-center gap-3 min-w-0">
                <span class="w-2.5 h-2.5 rounded-full shrink-0 ${
                  urlResult.success
                    ? "bg-emerald-500"
                    : urlResult.blocked
                      ? "bg-amber-500"
                      : "bg-rose-500"
                }"></span>
                <div class="min-w-0">
                  <div class="font-medium text-sm text-obsidian truncate">
                    ${new URL(urlResult.url).hostname}
                  </div>
                  <div class="text-xs text-graphite truncate font-mono mt-0.5" title="${urlResult.url}">
                    ${urlResult.url} ${
                      urlResult.processingTime
                        ? `· ${formatTime(urlResult.processingTime)}`
                        : ""
                    }${
                      urlResult.strategy === "manual-capture"
                        ? ' · <span class="text-amber-700">via captura manual</span>'
                        : ""
                    }
                  </div>
                </div>
              </div>

              <!-- Viewport budget badges -->
              <div class="flex items-center gap-2 flex-wrap">
                ${(urlResult.pageFixes || [])
                  .map(
                    (fix) => `
                  <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border ${
                    fix.applied
                      ? "bg-paper border-hairline text-obsidian"
                      : "bg-amber-50 border-amber-200 text-amber-800"
                  }" title="${fix.label}">
                    <i class="fas fa-${fix.applied ? "bandage" : "triangle-exclamation"} text-xs"></i>
                    ${fix.id}
                  </span>`,
                  )
                  .join("")}
                ${
                  mobileConfig
                    ? `
                  <div class="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-paper border border-hairline text-xs">
                    <i class="fas fa-mobile-screen text-xs text-graphite"></i>
                    <span class="text-graphite">Mobile:</span>
                    <strong class="text-obsidian font-medium font-mono">${formatFileSize(
                      mobileConfig.gzipSize,
                    )}</strong>
                    ${
                      mobileConfig.budget
                        ? renderBudgetBadge(mobileConfig.budget)
                        : ""
                    }
                  </div>
                `
                    : ""
                }
                ${
                  desktopConfig
                    ? `
                  <div class="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-paper border border-hairline text-xs">
                    <i class="fas fa-desktop text-xs text-graphite"></i>
                    <span class="text-graphite">Desktop:</span>
                    <strong class="text-obsidian font-medium font-mono">${formatFileSize(
                      desktopConfig.gzipSize,
                    )}</strong>
                    ${
                      desktopConfig.budget
                        ? renderBudgetBadge(desktopConfig.budget)
                        : ""
                    }
                  </div>
                `
                    : ""
                }
                <span class="px-2.5 py-1 text-xs font-medium rounded-full border border-hairline ${
                  urlResult.success
                    ? "bg-paper text-obsidian"
                    : "bg-rose-50 text-rose-800 border-rose-200"
                }">
                  ${
                    urlResult.success
                      ? "Sucesso"
                      : urlResult.blocked
                        ? "Bloqueado"
                        : "Falhou"
                  }
                </span>
              </div>
            </div>

            ${
              urlResult.error
                ? `
              <div class="p-4 bg-rose-50/50 border-t border-rose-200 text-xs text-rose-800">
                <strong>Erro:</strong> ${escapeHtml(urlResult.error)}
              </div>
            `
                : ""
            }

            ${
              urlResult.success
                ? `
              <div class="p-4 space-y-3">
                <!-- Drupal Block HTML Snippet Container -->
                <div class="border border-hairline rounded-[6px] overflow-hidden bg-[#0d0d0f] text-[#f4f4f5]">
                  <div class="px-4 py-2.5 bg-[#17171a] border-b border-white/10 flex items-center justify-between flex-wrap gap-2">
                    <div class="flex items-center gap-2">
                      <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
                      <span class="font-medium text-xs text-white">Código HTML para Bloco Drupal (&lt;style media&gt;)</span>
                    </div>
                    <div class="flex items-center gap-2">
                      <button
                        class="copy-html-block-btn px-3 py-1 text-xs rounded-full bg-white/10 hover:bg-white/20 text-white border border-white/20 transition-all flex items-center gap-1.5 cursor-pointer active:scale-95"
                        data-url-index="${urlIndex}"
                        title="Copiar snippet completo para o Drupal"
                      >
                        <i class="fas fa-copy text-xs"></i>
                        <span>Copiar Bloco</span>
                      </button>
                      <button
                        class="download-html-block-btn px-3 py-1 text-xs rounded-full bg-transparent hover:bg-white/10 text-white/80 border border-white/10 transition-all flex items-center gap-1.5 cursor-pointer"
                        data-url-index="${urlIndex}"
                        title="Baixar arquivo .html com o bloco"
                      >
                        <i class="fas fa-download text-xs"></i>
                        <span>Baixar .html</span>
                      </button>
                      <button
                        class="validate-block-btn px-3 py-1 text-xs rounded-full bg-transparent hover:bg-white/10 text-white/80 border border-white/10 transition-all flex items-center gap-1.5 cursor-pointer"
                        data-url-index="${urlIndex}"
                        title="Conferir se o bloco quebra algo visualmente"
                      >
                        <i class="fas fa-eye text-xs"></i>
                        <span>Validar visual</span>
                      </button>
                    </div>
                  </div>
                  <div class="p-3">
                    <textarea
                      readonly
                      rows="10"
                      class="w-full font-mono text-xs p-3 bg-transparent text-[#e4e4e7] border-0 focus:outline-none selection:bg-white/20 resize-y leading-relaxed"
                      spellcheck="false"
                    >${escapeHtml(buildHtmlMediaBlock(urlResult))}</textarea>
                  </div>
                  <div class="px-4 py-2 bg-[#121214] border-t border-white/5 flex items-center justify-between text-[11px] text-[#a1a1aa] flex-wrap gap-2">
                    <span>Separação Mobile (&le;991.98px) e Desktop (&ge;992px) via <code>&lt;style media&gt;</code>. Render instantâneo sem FOUC.</span>
                    <span class="font-mono text-white/70">Target: &le; 14.6KB gzip</span>
                  </div>
                </div>
              </div>
            `
                : ""
            }
          </div>
        `;
          })
          .join("")}
      </div>

      <!-- Drupal Deployment Guide Card -->
      <div class="p-5 border border-hairline rounded-[6px] bg-ash/40 space-y-2">
        <div class="text-xs font-semibold text-obsidian uppercase tracking-wider">Como aplicar no Drupal</div>
        <ol class="list-decimal list-inside space-y-1 text-xs text-graphite leading-relaxed">
          <li>Crie ou edite um bloco personalizado no Drupal (ex: <em>Bloco de CSS Crítico</em>).</li>
          <li>Configure o Formato de Texto como <strong class="text-obsidian font-medium">Full HTML</strong> (para habilitar tags <code>&lt;style&gt;</code>).</li>
          <li>Cole o código copiado acima no corpo do bloco e posicione na região de Topo (Header).</li>
          <li>Ao carregar a folha completa de estilos assincronamente com <code>rel="preload"</code> e <code>onload</code>, este bloco evita Layout Shifts (CLS) e elimina bloqueio de renderização (FCP).</li>
        </ol>
      </div>
    </div>
  `;
}

function renderManualCaptureSection() {
  const bookmarkletHref = buildBookmarklet();

  return `
    <div id="capture-section" class="card-editorial p-6 sm:p-8 space-y-5">
      <div>
        <h2 class="text-[22px] font-medium text-obsidian tracking-[-0.22px]">Captura Manual (Domínios com WAF / Anti-bot)</h2>
        <p class="text-graphite text-sm mt-1 leading-relaxed">
          Para páginas que barram o navegador automatizado (Akamai, Cloudflare, Datadome): arraste o botão abaixo para a barra de favoritos, abra a URL no seu navegador comum e clique nele. A captura é enviada direto para cá; se o site bloquear o envio, ela é baixada como arquivo <code>.json</code> para você importar aqui. Na próxima geração, se o acesso automático àquela URL for bloqueado, a captura é usada no lugar.
        </p>
        <p class="text-graphite text-xs mt-2 leading-relaxed">
          Alternativa melhor quando existir: gere a partir de um ambiente sem WAF (homologação/staging). Os caminhos de imagens do próprio site saem relativos (<code>/themes/...</code>), então o bloco funciona em produção.
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <a
          href="${bookmarkletHref}"
          onclick="return false;"
          class="btn-outline text-xs !py-2 !px-4 cursor-move inline-flex items-center gap-2"
          title="Arraste para a barra de favoritos do navegador"
        >
          <i class="fas fa-bookmark text-xs text-graphite"></i>
          <span>Capturar Página Crítica (arraste para os Favoritos)</span>
        </a>
        <label class="btn-outline text-xs !py-2 !px-4 cursor-pointer inline-flex items-center gap-2">
          <i class="fas fa-file-import text-xs text-graphite"></i>
          <span>Importar captura (.json)</span>
          <input type="file" accept=".json,application/json" multiple class="hidden" onchange="handleImportCaptures(this)" />
        </label>
      </div>

      ${
        state.captures.length > 0
          ? `
        <div class="space-y-3 pt-3 border-t border-hairline">
          <div class="text-xs font-medium text-obsidian uppercase tracking-wider">
            Páginas Capturadas Manualmente (${state.captures.length})
          </div>
          <div class="space-y-2">
            ${state.captures
              .map(
                (capture) => `
              <div class="flex items-center justify-between p-3 border border-hairline rounded-[6px] bg-paper text-xs">
                <span class="truncate flex-1 mr-3 font-mono text-obsidian" title="${capture.url}">${capture.url}</span>
                <span class="text-graphite mr-3 whitespace-nowrap">${capture.capturedAt ? new Date(capture.capturedAt).toLocaleString("pt-BR") : ""}</span>
                <span class="text-graphite font-mono mr-3 whitespace-nowrap">${formatFileSize(capture.size)}</span>
                <button
                  class="delete-capture-btn p-1.5 text-smoke hover:text-rose-600 rounded hover:bg-ash transition-colors"
                  data-url="${capture.url}"
                  title="Excluir captura"
                >
                  <i class="fas fa-trash text-xs"></i>
                </button>
              </div>
            `,
              )
              .join("")}
          </div>
        </div>
      `
          : ""
      }
    </div>
  `;
}

function renderFooter() {
  return `
    <footer class="mt-16 border-t border-hairline py-12 text-center text-xs text-graphite">
      <div class="max-w-[1200px] mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div>
          <span>Critical CSS Generator</span>
          <span class="mx-2">·</span>
          <span>OpenAI Design System Reference</span>
        </div>
        <div class="text-smoke">
          Foco em Performance Web &amp; Core Web Vitals (LCP, CLS, FCP)
        </div>
      </div>
    </footer>
  `;
}

function render() {
  const app = document.getElementById("app");
  if (!app) return;

  app.innerHTML = `
    ${renderTopNav()}
    <main class="max-w-[1200px] w-full mx-auto px-6 py-6 space-y-10 flex-1">
      ${
        state.tab === "validate"
          ? renderValidationTab()
          : state.tab === "settings"
            ? renderSettingsTab()
            : `
        ${renderHero()}
        ${renderConfigurationCard()}
        ${renderResults()}
        ${renderManualCaptureSection()}
      `
      }
    </main>
    ${renderFooter()}
  `;

  attachEventListeners();
}

function attachEventListeners() {
  document.querySelectorAll(".copy-html-block-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const urlResult = state.results[btn.dataset.urlIndex];
      handleCopyHtmlBlock(urlResult, btn);
    });
  });

  document.querySelectorAll(".download-html-block-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const urlResult = state.results[btn.dataset.urlIndex];
      handleDownloadHtmlBlock(urlResult);
    });
  });

  document.querySelectorAll(".validate-block-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      openValidation(state.results[btn.dataset.urlIndex]);
    });
  });

  document.querySelectorAll(".delete-capture-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      handleDeleteCapture(btn.dataset.url);
    });
  });
}

// Initialization
render();
loadCaptures();
loadSettings();

// Global assignments for inline event handlers
window.addUrl = addUrl;
window.removeUrl = removeUrl;
window.clearUrls = clearUrls;
window.updateUrl = updateUrl;
window.toggleBatchPaste = toggleBatchPaste;
window.applyBatchUrls = applyBatchUrls;
window.handlePasteUrls = handlePasteUrls;
window.handleBatchGenerate = handleBatchGenerate;
window.handleCopyHtmlBlock = handleCopyHtmlBlock;
window.handleDownloadHtmlBlock = handleDownloadHtmlBlock;
window.handleDownloadAll = handleDownloadAll;
window.exportBatchResults = exportBatchResults;
window.handleRetryFailed = handleRetryFailed;
window.handleImportCaptures = handleImportCaptures;
window.setTab = setTab;
window.runValidation = runValidation;
window.downloadValidationReport = downloadValidationReport;
window.saveSettings = saveSettings;
window.resetSettingsForm = resetSettingsForm;
window.updateSettingsField = updateSettingsField;

window.addEventListener("hashchange", () => {
  const tab = tabFromHash();
  if (tab !== state.tab) {
    state.tab = tab;
    render();
  }
});
window.state = state;
window.render = render;
