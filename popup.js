let collectedText = '';
let isCollecting  = false;

// ── helpers ────────────────────────────────────────────────────────────────

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function setStatus(text, progress = null) {
  const box = document.getElementById('status-box');
  box.style.display = 'block';
  document.getElementById('status-text').textContent = text;
  if (progress !== null)
    document.getElementById('progress-bar').style.width = Math.min(progress, 100) + '%';
}

function setCollecting(on) {
  isCollecting = on;
  document.getElementById('btn-collect').disabled     = on;
  document.getElementById('btn-screenshots').disabled = on;
  document.getElementById('btn-stop').disabled        = !on;
  document.getElementById('btn-test').disabled        = on;
  document.getElementById('btn-one-page').disabled    = on;
}

function enableDownload(text) {
  collectedText = text;
  document.getElementById('btn-download').disabled = !text;
}

// ── inject content.js into ALL frames (including cross-origin iframes) ─────

async function injectAll(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content.js'],
    });
  } catch (_) { /* already injected */ }
  await new Promise(r => setTimeout(r, 200));
}

// ── extract text from ALL frames and pick the richest ─────────────────────
// This runs inside each frame, so it can access cross-origin iframe DOM.

function _extractInFrame() {
  const UI = [
    /^Kindle Library$/i, /^Back to \d+/i, /Page \d+ of \d+/i,
    /^Page \d+$/i,
    /Learning reading speed/i, /^\d+%$/, /^●/, /^\s*·+\s*$/,
    /^Fullscreen$/i, /^Bookmark$/i, /^Settings$/i, /^Contents$/i,
    /^Table of Contents$/i, /^Notes$/i, /^Back$/i, /^Close$/i,
    /^Share$/i, /^Flashcards$/i,
  ];
  function bad(t) { return UI.some(r => r.test(t)); }
  const skip = new Set(['script','style','noscript','button','nav','header','footer']);

  function walkRoot(root, out) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (skip.has(p.tagName.toLowerCase())) return NodeFilter.FILTER_REJECT;
        const role = p.getAttribute('role');
        if (role === 'button' || role === 'menuitem') return NodeFilter.FILTER_REJECT;
        const cs = getComputedStyle(p);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0')
          return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    while ((node = walker.nextNode())) {
      const t = node.nodeValue.trim();
      if (t && t.length >= 3 && !bad(t)) out.push(t);
    }
    const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of all) {
      if (el.shadowRoot) walkRoot(el.shadowRoot, out);
    }
  }

  const chunks = [];
  if (document.body) walkRoot(document.body, chunks);

  const text = chunks.join('\n');
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  const canvasCount = document.querySelectorAll('canvas').length;

  return {
    text,
    len: text.length,
    url: location.href,
    isIframe: window !== window.top,
    hasCanvas: canvasCount > 0,
    wordCount,
  };
}

async function extractAllFrames() {
  const tab = await getActiveTab();
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: _extractInFrame,
  });

  let best = { text: '', len: 0 };
  let canvasDetected = false;
  let totalWords = 0;
  for (const r of results) {
    if (!r.result) continue;
    const { text, len, isIframe, hasCanvas, wordCount } = r.result;
    if (hasCanvas) canvasDetected = true;
    totalWords += (wordCount || 0);
    const weight = isIframe ? len * 1.5 : len;
    if (weight > best.len) best = { text, len: weight };
  }
  // Canvas mode: canvas element found but text is just UI labels (< 60 words)
  const isCanvasMode = canvasDetected && totalWords < 60;
  return { text: best.text || '', hasCanvas: canvasDetected, isCanvasMode };
}

// ── get current page number ────────────────────────────────────────────────

function _getPageInfoInFrame() {
  const text = document.body ? document.body.innerText : '';
  const m = text.match(/Page\s+(\d+)\s+of\s+(\d+)/i);
  return m ? { current: +m[1], total: +m[2] } : null;
}

async function getPageInfo() {
  const tab = await getActiveTab();
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: _getPageInfoInFrame,
  });
  for (const r of results) {
    if (r.result) return r.result;
  }
  return null;
}

// ── page navigation (click right side of reading area) ────────────────────

async function goNextPage() {
  const tab = await getActiveTab();
  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => {
      // Click right 75% of viewport
      const x = window.innerWidth  * 0.75;
      const y = window.innerHeight * 0.5;
      const el = document.elementFromPoint(x, y);
      if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
      // Also try arrow keys
      ['keydown','keyup'].forEach(t =>
        document.dispatchEvent(new KeyboardEvent(t, { key:'ArrowRight', keyCode:39, bubbles:true }))
      );
    },
  });
}

// ── auto-collect all pages ─────────────────────────────────────────────────

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function collectAllPages(delay) {
  isCollecting = true;
  const pages  = [];
  let lastPageNum = -1;
  let stuckCount  = 0;

  const info0 = await getPageInfo();
  const total  = info0 ? info0.total : '?';
  setStatus(`Начинаю… всего страниц: ${total}`, 0);

  while (isCollecting) {
    await sleep(delay);

    const info = await getPageInfo();
    const cur  = info ? info.current : -1;

    if (cur === lastPageNum) {
      stuckCount++;
      if (stuckCount >= 4) break;
      await goNextPage();
      continue;
    }

    stuckCount  = 0;
    lastPageNum = cur;

    const { text } = await extractAllFrames();
    if (text.trim()) {
      pages.push(`[Страница ${cur}]\n${text.trim()}`);
    }

    const pct = info ? Math.round(cur / info.total * 100) : null;
    setStatus(`Страница ${cur} / ${info ? info.total : total}`, pct);

    await chrome.storage.session.set({ lastStatus: { state:'collecting', current:cur, total, message:`Страница ${cur}/${total}` }});

    if (info && cur >= info.total) break;
    await goNextPage();
  }

  isCollecting = false;
  const fullText = pages.join('\n\n─────────────────────\n\n');
  enableDownload(fullText);
  await chrome.storage.session.set({ collectedText: fullText, collectedPages: pages.length });
  setStatus(`✅ Готово! Собрано ${pages.length} страниц`, 100);
  setCollecting(false);
}

// ── screenshot collection (canvas-mode fallback) ──────────────────────────

let _screenshots = []; // { page, dataUrl } — kept for PDF creation

async function capturePageScreenshot() {
  const tab = await getActiveTab();
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, dataUrl => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(dataUrl);
    });
  });
}

async function buildPDF(screenshots) {
  const { jsPDF } = window.jspdf;
  let pdf = null;
  for (const { dataUrl } of screenshots) {
    const img = new Image();
    img.src = dataUrl;
    await new Promise(r => { img.onload = r; });
    const W = 210; // A4 width mm
    const H = Math.round(W * img.height / img.width);
    if (!pdf) {
      pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: [W, H] });
    } else {
      pdf.addPage([W, H]);
    }
    pdf.addImage(dataUrl, 'PNG', 0, 0, W, H, '', 'FAST');
  }
  return pdf;
}

async function collectAllScreenshots(delay) {
  isCollecting = true;
  _screenshots  = [];
  let lastPageNum = -1;
  let stuckCount  = 0;

  const info0 = await getPageInfo();
  const total  = info0 ? info0.total : '?';
  setStatus(`Скриншоты… всего страниц: ${total}`, 0);

  while (isCollecting) {
    await sleep(delay);

    const info = await getPageInfo();
    const cur  = info ? info.current : -1;

    if (cur === lastPageNum) {
      stuckCount++;
      if (stuckCount >= 4) break;
      await goNextPage();
      continue;
    }
    stuckCount  = 0;
    lastPageNum = cur;

    try {
      const dataUrl = await capturePageScreenshot();
      _screenshots.push({ page: cur, dataUrl });
    } catch (e) { /* skip */ }

    const pct = info ? Math.round(cur / info.total * 100) : null;
    setStatus(`Скриншот ${cur} / ${info ? info.total : total} (${_screenshots.length} сохранено)`, pct);

    if (info && cur >= info.total) break;
    await goNextPage();
  }

  isCollecting = false;
  setCollecting(false);

  const n = _screenshots.length;
  setStatus(`✅ ${n} страниц собрано — создаю PDF…`, 100);

  // Build and download original PDF
  await downloadOriginalPDF();

  // Show PDF section
  document.getElementById('section-pdf').style.display = 'block';
  document.getElementById('pdf-folder-hint').textContent =
    `PNG также сохранены в ~/Downloads/kindle_book/`;
}

async function downloadOriginalPDF() {
  if (_screenshots.length === 0) { setStatus('⚠️ Нет скриншотов'); return; }
  const prog = document.getElementById('pdf-progress');
  prog.style.display = 'block';
  prog.textContent = 'Создаю PDF…';

  try {
    const pdf  = await buildPDF(_screenshots);
    const blob = pdf.output('blob');
    const url  = URL.createObjectURL(blob);
    await chrome.downloads.download({
      url,
      filename: `kindle_original_${Date.now()}.pdf`,
      saveAs: false,
    });
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    prog.textContent = `✅ PDF скачан (${_screenshots.length} стр.)`;
    setStatus(`✅ Готово: ${_screenshots.length} страниц`, 100);

    // Also save individual PNGs for translate_book.py
    for (const { page, dataUrl } of _screenshots) {
      const res  = await fetch(dataUrl);
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      await chrome.downloads.download({
        url: objUrl,
        filename: `kindle_book/page_${String(page).padStart(4, '0')}.png`,
        conflictAction: 'overwrite',
        saveAs: false,
      });
      setTimeout(() => URL.revokeObjectURL(objUrl), 30000);
    }
    prog.textContent += ` · PNG → ~/Downloads/kindle_book/`;
  } catch (e) {
    prog.textContent = '❌ ' + e.message;
  }
}

// ── button handlers ────────────────────────────────────────────────────────

document.getElementById('btn-test').addEventListener('click', async () => {
  setStatus('Сканирую все фреймы…');
  try {
    const tab = await getActiveTab();
    await injectAll(tab.id);
    const { text, isCanvasMode } = await extractAllFrames();
    const info    = await getPageInfo();
    const preview = document.getElementById('preview');
    preview.style.display = 'block';

    if (!isCanvasMode && text && text.trim().length > 20) {
      preview.textContent =
        `[Стр. ${info ? info.current : '?'} из ${info ? info.total : '?'}]\n` +
        text.slice(0, 500) + (text.length > 500 ? '…' : '');
      setStatus(`✅ Текст найден: ${text.length} символов`);
      enableDownload(text);
    } else if (isCanvasMode) {
      preview.textContent =
        'Kindle рендерит текст через Canvas — DOM-метод не работает.\n\n' +
        'Включи режим доступности:\n' +
        '1. Нажми кнопку «Aa» (шрифт) в верхней панели Kindle\n' +
        '2. Перейди в «Другие настройки»\n' +
        '3. Включи «Специальные возможности» (Accessibility)\n' +
        '4. Перезагрузи вкладку с книгой\n' +
        '5. Нажми «Сканировать» снова\n\n' +
        'В режиме доступности Kindle рендерит текст как обычный DOM, ' +
        'и расширение сможет его прочитать.';
      setStatus('Canvas-режим: нужны Специальные возможности в настройках Aa');
    } else {
      preview.textContent = 'Текст не найден — попробуй включить Специальные возможности в Aa.';
      setStatus('Текст не найден');
    }
  } catch (e) {
    setStatus('❌ ' + e.message);
  }
});

document.getElementById('btn-one-page').addEventListener('click', async () => {
  try {
    const tab = await getActiveTab();
    await injectAll(tab.id);
    const { text } = await extractAllFrames();
    if (text && text.trim()) {
      await navigator.clipboard.writeText(text);
      enableDownload(text);
      setStatus(`✅ Скопировано: ${text.length} символов`);
    } else {
      setStatus('⚠️ Текст не найден');
    }
  } catch (e) {
    setStatus('❌ ' + e.message);
  }
});

document.getElementById('btn-collect').addEventListener('click', async () => {
  const delay = parseInt(document.getElementById('speed').value);
  setCollecting(true);
  document.getElementById('btn-download').disabled = true;
  document.getElementById('preview').style.display = 'none';
  const tab = await getActiveTab();
  await injectAll(tab.id);
  collectAllPages(delay);
});

document.getElementById('btn-screenshots').addEventListener('click', async () => {
  const delay = parseInt(document.getElementById('speed').value);
  setCollecting(true);
  document.getElementById('preview').style.display = 'none';
  const tab = await getActiveTab();
  await injectAll(tab.id);
  collectAllScreenshots(delay);
});

document.getElementById('btn-stop').addEventListener('click', () => {
  isCollecting = false;
  setCollecting(false);
  setStatus('⏹ Остановлено');
});

document.getElementById('btn-download').addEventListener('click', async () => {
  let text = collectedText;
  if (!text) {
    const s = await chrome.storage.session.get('collectedText');
    text = s.collectedText || '';
  }
  if (!text) return;
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })),
    download: `kindle_${Date.now()}.txt`,
  });
  a.click();
});

// ── PDF section buttons ────────────────────────────────────────────────────

document.getElementById('btn-orig-pdf').addEventListener('click', async () => {
  if (_screenshots.length === 0) {
    setStatus('⚠️ Сначала собери скриншоты кнопкой «📸 Скриншоты + PDF»');
    return;
  }
  await downloadOriginalPDF();
});

document.getElementById('btn-gtranslate').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://translate.google.com/?sl=auto&tl=ru#documenttranslate' });
});

document.getElementById('btn-deepl-doc').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.deepl.com/translator#files' });
});

// ── Translate text buttons ─────────────────────────────────────────────────

function openTranslate(service) {
  const text = (collectedText || '').slice(0, 4000);
  if (!text) { setStatus('⚠️ Сначала собери текст'); return; }
  const enc = encodeURIComponent(text);
  const urls = {
    google:  `https://translate.google.com/?sl=auto&tl=ru&text=${enc}`,
    deepl:   `https://www.deepl.com/translator#auto/ru/${enc}`,
    yandex:  `https://translate.yandex.ru/?lang=en-ru&text=${enc}`,
    chatgpt: `https://chat.openai.com/?q=${encodeURIComponent('Переведи на русский:\n\n' + text.slice(0,2000))}`,
  };
  chrome.tabs.create({ url: urls[service] });
}
['google','deepl','yandex','chatgpt'].forEach(s =>
  document.getElementById('btn-' + s).addEventListener('click', () => openTranslate(s))
);

// ── init ───────────────────────────────────────────────────────────────────

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isKindle = tab && tab.url && tab.url.includes('read.amazon.com');
  document.getElementById('not-kindle').style.display = isKindle ? 'none' : 'block';
  document.getElementById('main-ui').style.display    = isKindle ? 'block' : 'none';

  const s = await chrome.storage.session.get(['collectedText','lastStatus']);
  if (s.collectedText) enableDownload(s.collectedText);
  if (s.lastStatus && s.lastStatus.state !== 'done') {
    setStatus(s.lastStatus.message || '');
  }
}

init();
