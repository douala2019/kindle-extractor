// Kindle Cloud Reader — text extractor v2

let collectedPages = [];
let isCollecting   = false;
let lastPageNum    = -1;

// ── UI-noise patterns to strip ─────────────────────────────────────────────
const UI_PATTERNS = [
  /^Kindle Library$/i,
  /^Back to \d+/i,
  /Page \d+ of \d+/i,
  /Learning reading speed/i,
  /^\d+%$/,
  /^THE .{0,120}$/,           // title line at top (all-caps short line)
  /^·+$/,
  /^●/,
];

function isUIText(line) {
  return UI_PATTERNS.some(re => re.test(line.trim()));
}

// ── read page number from the UI ─────────────────────────────────────────

function getCurrentPageNum() {
  // "Page 6 of 119 ● 2%" or "6 / 119"
  const body = document.body.innerText || '';
  const m = body.match(/Page\s+(\d+)\s+of\s+(\d+)/i)
         || body.match(/(\d+)\s*\/\s*(\d+)\s*●/);
  if (m) return { current: parseInt(m[1]), total: parseInt(m[2]) };
  return null;
}

// ── extract book text from current view ───────────────────────────────────

function extractBookText() {
  // Walk ALL visible text nodes, keep only book-content ones.
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName.toLowerCase();
        if (['script','style','noscript','button','nav','header','footer'].includes(tag))
          return NodeFilter.FILTER_REJECT;
        const cs = window.getComputedStyle(p);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0')
          return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const lines = [];
  let node;
  while ((node = walker.nextNode())) {
    const txt = node.nodeValue.trim();
    if (!txt) continue;
    if (isUIText(txt)) continue;
    // Skip very short fragments that are likely buttons / labels
    if (txt.length < 4) continue;
    lines.push(txt);
  }

  // Merge into paragraphs: when a fragment ends with sentence-ending punctuation,
  // start a new paragraph; otherwise join with space.
  const paras = [];
  let current = '';
  for (const line of lines) {
    current = current ? current + ' ' + line : line;
    if (/[.!?…"»]$/.test(line) && current.length > 60) {
      paras.push(current);
      current = '';
    }
  }
  if (current) paras.push(current);
  return paras.join('\n\n');
}

// ── page navigation ────────────────────────────────────────────────────────

function goNextPage() {
  // 1. Click the right 70% of the viewport (Kindle advances on right-side click)
  const x = Math.round(window.innerWidth  * 0.75);
  const y = Math.round(window.innerHeight * 0.50);
  const el = document.elementFromPoint(x, y);
  if (el) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  }

  // 2. Also send ArrowRight key to the document (some Kindle versions use this)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', keyCode: 39, bubbles: true }));
  document.dispatchEvent(new KeyboardEvent('keyup',   { key: 'ArrowRight', keyCode: 39, bubbles: true }));
}

// ── auto-collect all pages ─────────────────────────────────────────────────

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function collectAllPages(delay = 2500) {
  if (isCollecting) return;
  isCollecting   = true;
  collectedPages = [];
  lastPageNum    = -1;

  const info0 = getCurrentPageNum();
  const total  = info0 ? info0.total : '?';
  sendStatus('collecting', 0, total, 'Начинаю сбор…');

  let stuckCount = 0;
  const MAX_STUCK = 4;

  while (isCollecting) {
    await sleep(delay);

    const info = getCurrentPageNum();
    const pageNum = info ? info.current : -1;

    if (pageNum === lastPageNum) {
      stuckCount++;
      if (stuckCount >= MAX_STUCK) break;   // last page reached
      goNextPage();
      continue;
    }

    // Page changed — extract text
    stuckCount  = 0;
    lastPageNum = pageNum;

    const text = extractBookText();
    if (text) {
      collectedPages.push(`[Страница ${pageNum}]\n${text}`);
    }

    sendStatus('collecting', pageNum, info ? info.total : total,
      `Страница ${pageNum}/${info ? info.total : total}`);

    if (info && info.current >= info.total) break;  // done!

    goNextPage();
  }

  isCollecting = false;
  const n = collectedPages.length;
  sendStatus('done', n, total, `Готово! Собрано ${n} страниц`);

  const fullText = collectedPages.join('\n\n─────────────────────\n\n');
  chrome.runtime.sendMessage({ type: 'COLLECTED_TEXT', text: fullText, pages: n });
}

function sendStatus(state, current, total, message) {
  chrome.runtime.sendMessage({ type: 'STATUS', state, current, total, message }).catch(() => {});
}

// ── message listener ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_PAGE_TEXT') {
    sendResponse({ text: extractBookText(), page: getCurrentPageNum() });
    return true;
  }
  if (msg.type === 'COLLECT_ALL') {
    collectAllPages(msg.delay || 2500);
    sendResponse({ started: true });
    return true;
  }
  if (msg.type === 'STOP') {
    isCollecting = false;
    sendResponse({ stopped: true, pages: collectedPages.length });
    return true;
  }
  if (msg.type === 'GET_STATUS') {
    sendResponse({ isCollecting, pages: collectedPages.length });
    return true;
  }
  return false;
});
