// ============================================================
// Mounjaro 腹部注射追蹤器 - Main Application
// ============================================================

// ---- Configuration ----
const CONFIG = {
  belly: {
    cx: 0.500,   // 肚臍 X 中心
    cy: 0.700,   // 肚臍 Y 中心
    rx: 0.155,   // 水平半徑
    ry: 0.215,   // 垂直半徑
  },
  exclusionRatio: 0.28,
  recoveryDays: 28,
  cycleDays: 7,
  storageKey: 'mounjaro-injection-tracker',
};

// 象限定義
const QUADRANTS = ['UL', 'UR', 'LL', 'LR'];
const Q_LABELS = { UL: '左上', UR: '右上', LL: '左下', LR: '右下' };

// ---- State ----
let state = { injections: [] };
let mirrored = false;
let pendingQuadrant = null;
let pendingDeleteId = null;

// ---- DOM ----
const $ = (sel) => document.querySelector(sel);
let els = {};
let VB_W = 1000;
let VB_H = 563;

// ============================================================
// Initialization
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  els = {
    img: $('#teddy-img'),
    svg: $('#overlay-svg'),
    statDays: $('#days-since'),
    statNext: $('#next-suggestion'),
    statCount: $('#total-count'),
    historyList: $('#history-list'),
    modalOverlay: $('#modal-overlay'),
    modalQuadrant: $('#modal-quadrant-info'),
    modalWarning: $('#modal-warning'),
    inputDatetime: $('#input-datetime'),
    inputDose: $('#input-dose'),
    inputWeight: $('#input-weight'),
    inputNotes: $('#input-notes'),
    deleteOverlay: $('#delete-overlay'),
    exportBtn: $('#export-btn'),
    importBtn: $('#import-btn'),
    importFile: $('#import-file'),
    clearBtn: $('#clear-btn'),
    mirrorBtn: $('#mirror-btn'),
  };

  loadState();

  if (els.img.complete && els.img.naturalWidth > 0) {
    onImageReady();
  } else {
    els.img.addEventListener('load', onImageReady);
  }

  bindEvents();
});

function onImageReady() {
  const { naturalWidth, naturalHeight } = els.img;
  VB_H = Math.round(VB_W * naturalHeight / naturalWidth);
  els.svg.setAttribute('viewBox', `0 0 ${VB_W} ${VB_H}`);
  render();
}

// ============================================================
// Event Binding
// ============================================================
function bindEvents() {
  $('#modal-save').addEventListener('click', onSaveInjection);
  $('#modal-cancel').addEventListener('click', closeModal);
  els.modalOverlay.addEventListener('click', (e) => {
    if (e.target === els.modalOverlay) closeModal();
  });

  $('#delete-confirm').addEventListener('click', onConfirmDelete);
  $('#delete-cancel').addEventListener('click', closeDeleteModal);
  els.deleteOverlay.addEventListener('click', (e) => {
    if (e.target === els.deleteOverlay) closeDeleteModal();
  });

  els.exportBtn.addEventListener('click', exportJSON);
  els.importBtn.addEventListener('click', () => els.importFile.click());
  els.importFile.addEventListener('change', onImportFile);
  els.clearBtn.addEventListener('click', onClearAll);
  els.mirrorBtn.addEventListener('click', toggleMirror);
}

// ============================================================
// Rendering
// ============================================================
function render() {
  renderSVGOverlay();
  renderStats();
  renderHistory();
}

function renderSVGOverlay() {
  const svg = els.svg;
  svg.innerHTML = '';

  const bcx = VB_W * CONFIG.belly.cx;
  const bcy = VB_H * CONFIG.belly.cy;
  const brx = VB_W * CONFIG.belly.rx;
  const bry = VB_H * CONFIG.belly.ry;

  // ---- 四象限 Path (扇形，剛好構成橢圓) ----
  const qPaths = {
    UL: `M ${bcx} ${bcy} L ${bcx} ${bcy - bry} A ${brx} ${bry} 0 0 0 ${bcx - brx} ${bcy} Z`,
    UR: `M ${bcx} ${bcy} L ${bcx} ${bcy - bry} A ${brx} ${bry} 0 0 1 ${bcx + brx} ${bcy} Z`,
    LR: `M ${bcx} ${bcy} L ${bcx + brx} ${bcy} A ${brx} ${bry} 0 0 1 ${bcx} ${bcy + bry} Z`,
    LL: `M ${bcx} ${bcy} L ${bcx - brx} ${bcy} A ${brx} ${bry} 0 0 0 ${bcx} ${bcy + bry} Z`,
  };

  // 象限標籤位置
  const qLabelPos = {
    UL: { x: bcx - brx * 0.50, y: bcy - bry * 0.48 },
    UR: { x: bcx + brx * 0.50, y: bcy - bry * 0.48 },
    LL: { x: bcx - brx * 0.50, y: bcy + bry * 0.55 },
    LR: { x: bcx + brx * 0.50, y: bcy + bry * 0.55 },
  };

  // ---- 鏡像映射：畫面位置 → 資料象限 ----
  const MIRROR_MAP = { UL: 'UR', UR: 'UL', LL: 'LR', LR: 'LL' };
  const toDataQ = (visQ) => mirrored ? MIRROR_MAP[visQ] : visQ;

  // ---- 繪製四象限 ----
  QUADRANTS.forEach(visQ => {
    const dataQ = toDataQ(visQ);           // 對應的資料象限
    const score = calcQuadrantScore(dataQ);
    const color = scoreToColor(score);
    const lp = qLabelPos[visQ];            // 畫面位置不變
    const lastDays = getLastDaysInQ(dataQ);
    const count = getCountInQ(dataQ);

    // 底色 path
    const path = svgEl('path', {
      d: qPaths[visQ],                     // 畫面位置不變
      fill: color,
      'fill-opacity': '0.55',
      cursor: 'pointer',
      'data-q': visQ,
    });

    // Hover 效果 (直接改 attribute，不重繪)
    path.addEventListener('mouseenter', () => onQHover(visQ, true));
    path.addEventListener('mouseleave', () => onQHover(visQ, false));
    path.addEventListener('click', () => onQuadrantClick(dataQ));
    path.addEventListener('touchend', (e) => {
      e.preventDefault();
      onQuadrantClick(dataQ);
    });

    svg.appendChild(path);

    // ---- 象限文字群組 ----
    const tg = svgEl('g', { 'pointer-events': 'none', 'data-qlabel': visQ });

    // 主要標籤：顯示天數資訊
    let mainLabel;
    if (count === 0) {
      mainLabel = '推薦';
    } else if (lastDays === 0) {
      mainLabel = '今天';
    } else {
      mainLabel = `${lastDays}天前`;
    }

    tg.appendChild(svgEl('text', {
      x: lp.x, y: lp.y,
      'font-size': '30',
      'font-weight': '700',
      fill: '#fff',
      'text-anchor': 'middle',
      'paint-order': 'stroke',
      stroke: 'rgba(0,0,0,0.3)',
      'stroke-width': '5',
      'stroke-linejoin': 'round',
    }, mainLabel));

    // 次數文字
    if (count > 1) {
      tg.appendChild(svgEl('text', {
        x: lp.x, y: lp.y + 26,
        'font-size': '18',
        'font-weight': '600',
        fill: 'rgba(255,255,255,0.85)',
        'text-anchor': 'middle',
        'paint-order': 'stroke',
        stroke: 'rgba(0,0,0,0.2)',
        'stroke-width': '3.5',
        'stroke-linejoin': 'round',
      }, `共 ${count} 次`));
    }

    svg.appendChild(tg);
  });

  // ---- 象限分隔線 (白色虛線) ----
  const dashStyle = {
    stroke: 'rgba(255,255,255,0.55)',
    'stroke-width': 1.5,
    'stroke-dasharray': '8 5',
    'pointer-events': 'none',
  };
  svg.appendChild(svgEl('line', { x1: bcx - brx, y1: bcy, x2: bcx + brx, y2: bcy, ...dashStyle }));
  svg.appendChild(svgEl('line', { x1: bcx, y1: bcy - bry, x2: bcx, y2: bcy + bry, ...dashStyle }));

  // ---- 禁區 ----
  const avgR = (brx + bry) / 2;
  const exR = avgR * CONFIG.exclusionRatio;
  svg.appendChild(svgEl('circle', {
    cx: bcx, cy: bcy, r: exR,
    fill: 'rgba(180,50,50,0.15)',
    stroke: 'rgba(180,50,50,0.5)',
    'stroke-width': 1.2,
    'stroke-dasharray': '4 3',
    'pointer-events': 'none',
  }));
  // X 標記
  const xs = exR * 0.35;
  svg.appendChild(svgEl('line', {
    x1: bcx - xs, y1: bcy - xs, x2: bcx + xs, y2: bcy + xs,
    stroke: 'rgba(180,50,50,0.4)', 'stroke-width': 1.5, 'pointer-events': 'none',
  }));
  svg.appendChild(svgEl('line', {
    x1: bcx + xs, y1: bcy - xs, x2: bcx - xs, y2: bcy + xs,
    stroke: 'rgba(180,50,50,0.4)', 'stroke-width': 1.5, 'pointer-events': 'none',
  }));

  // ---- 左右手標籤 (放在小熊兩側空白處) ----
  const leftLabel = mirrored ? '右手' : '左手';
  const rightLabel = mirrored ? '左手' : '右手';
  const sideY = bcy - bry * 0.15;  // 略高於中心

  // 左側標籤
  const lgLeft = svgEl('g', { 'pointer-events': 'none' });
  lgLeft.appendChild(svgEl('text', {
    x: VB_W * 0.12, y: sideY,
    'font-size': '48',
    'font-weight': '700',
    fill: 'var(--text-primary, #4a3f35)',
    'text-anchor': 'middle',
    'dominant-baseline': 'middle',
    opacity: '0.75',
  }, '✋'));
  lgLeft.appendChild(svgEl('text', {
    x: VB_W * 0.12, y: sideY + 48,
    'font-size': '36',
    'font-weight': '700',
    fill: 'var(--text-primary, #4a3f35)',
    'text-anchor': 'middle',
    opacity: '0.7',
  }, leftLabel));
  svg.appendChild(lgLeft);

  // 右側標籤
  const lgRight = svgEl('g', { 'pointer-events': 'none' });
  lgRight.appendChild(svgEl('text', {
    x: VB_W * 0.88, y: sideY,
    'font-size': '48',
    'font-weight': '700',
    fill: 'var(--text-primary, #4a3f35)',
    'text-anchor': 'middle',
    'dominant-baseline': 'middle',
    opacity: '0.75',
  }, '🤚'));
  lgRight.appendChild(svgEl('text', {
    x: VB_W * 0.88, y: sideY + 48,
    'font-size': '36',
    'font-weight': '700',
    fill: 'var(--text-primary, #4a3f35)',
    'text-anchor': 'middle',
    opacity: '0.7',
  }, rightLabel));
  svg.appendChild(lgRight);

  // ---- 外框橢圓 (裝飾用) ----
  svg.appendChild(svgEl('ellipse', {
    cx: bcx, cy: bcy, rx: brx + 1, ry: bry + 1,
    fill: 'none',
    stroke: 'rgba(100,85,65,0.15)',
    'stroke-width': 1.5,
    'pointer-events': 'none',
  }));
}

// ---- Quadrant hover (不重繪) ----
function onQHover(qId, enter) {
  const path = els.svg.querySelector(`[data-q="${qId}"]`);
  if (!path) return;

  if (enter) {
    path.setAttribute('fill-opacity', '0.72');
    path.setAttribute('stroke', 'rgba(255,255,255,0.7)');
    path.setAttribute('stroke-width', '2.5');
  } else {
    path.setAttribute('fill-opacity', '0.55');
    path.removeAttribute('stroke');
    path.removeAttribute('stroke-width');
  }
}

// ---- Stats ----
function renderStats() {
  const count = state.injections.length;
  els.statCount.textContent = count;

  if (count === 0) {
    els.statDays.textContent = '--';
    els.statNext.textContent = '--';
    els.statNext.style.color = '';
    return;
  }

  const sorted = [...state.injections].sort(
    (a, b) => new Date(b.date) - new Date(a.date)
  );
  const lastDays = daysSince(sorted[0].date);
  els.statDays.textContent = lastDays === 0 ? '今天' : `${lastDays} 天`;

  const daysLeft = CONFIG.cycleDays - lastDays;
  if (daysLeft <= 0) {
    els.statNext.textContent = '現在';
    els.statNext.style.color = '#b84040';
  } else {
    els.statNext.textContent = `${daysLeft} 天後`;
    els.statNext.style.color = '';
  }
}

// ---- History ----
function renderHistory() {
  const list = els.historyList;
  list.innerHTML = '';

  if (state.injections.length === 0) {
    list.innerHTML = '<p class="empty-msg">尚無注射記錄，點擊肚子開始記錄</p>';
    return;
  }

  const sorted = [...state.injections].sort(
    (a, b) => new Date(b.date) - new Date(a.date)
  );

  sorted.forEach((inj) => {
    const days = daysSince(inj.date);
    const dotColor = getDotColor(days);
    const qLabel = Q_LABELS[getInjQ(inj)] || '?';
    const dateStr = formatDate(inj.date);
    const daysText = days === 0 ? '今天' : `${days} 天前`;
    const weightText = inj.weight ? ` · ${inj.weight} kg` : '';
    const notesText = inj.notes ? ` · ${inj.notes}` : '';

    const item = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML = `
      <span class="history-dot" style="background:${dotColor}"></span>
      <div class="history-body">
        <div class="history-main">
          <span class="history-date">${dateStr}</span>
          <span class="history-quadrant">${qLabel}</span>
          <span class="history-dose">${inj.dose} mg</span>
        </div>
        <div class="history-sub">${daysText}${weightText}${notesText}</div>
      </div>
      <button class="history-delete" data-id="${inj.id}" title="刪除">&times;</button>
    `;

    item.querySelector('.history-delete').addEventListener('click', () => {
      pendingDeleteId = inj.id;
      els.deleteOverlay.classList.remove('hidden');
    });

    list.appendChild(item);
  });
}

// ============================================================
// Quadrant Scoring
// ============================================================
function calcQuadrantScore(qId) {
  const qInj = state.injections.filter(i => getInjQ(i) === qId);
  if (qInj.length === 0) return 1.0;

  let minDays = Infinity;
  for (const inj of qInj) {
    const d = daysSince(inj.date);
    if (d < minDays) minDays = d;
  }

  return Math.min(1.0, minDays / CONFIG.recoveryDays);
}

function scoreToColor(score) {
  const s = Math.max(0, Math.min(1, score));
  const hue = Math.round(s * 120); // 0=紅, 120=綠
  return `hsl(${hue}, 70%, 42%)`;
}

function getDotColor(days) {
  if (days < 7) return '#b84040';
  if (days < 14) return '#c07030';
  if (days < 21) return '#b8a030';
  if (days < 28) return '#6a9a40';
  return '#3a8a52';
}

// ============================================================
// Click Handling
// ============================================================
function onQuadrantClick(qId) {
  pendingQuadrant = qId;
  openModal(qId);
}

// ============================================================
// Mirror
// ============================================================
function toggleMirror() {
  mirrored = !mirrored;
  els.mirrorBtn.classList.toggle('active', mirrored);
  render();
}

// ============================================================
// Modal
// ============================================================
function openModal(qId) {
  const label = Q_LABELS[qId];
  const score = calcQuadrantScore(qId);
  const lastDays = getLastDaysInQ(qId);
  const count = getCountInQ(qId);

  let info = `位置：${label}`;
  if (count > 0) info += ` （上次 ${lastDays} 天前，共 ${count} 次）`;
  els.modalQuadrant.textContent = info;

  // 預設現在時間
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  els.inputDatetime.value = now.toISOString().slice(0, 16);

  // 保留上次劑量與體重
  if (state.injections.length > 0) {
    const sorted = [...state.injections].sort(
      (a, b) => new Date(b.date) - new Date(a.date)
    );
    els.inputDose.value = sorted[0].dose;
    els.inputWeight.value = sorted[0].weight || '';
  } else {
    els.inputWeight.value = '';
  }

  els.inputNotes.value = '';

  // 警告
  if (lastDays !== null && lastDays < 7) {
    els.modalWarning.textContent =
      `此象限在 ${lastDays} 天前才注射過（建議間隔至少 7 天），如非必要請選擇其他象限`;
    els.modalWarning.classList.remove('hidden');
  } else {
    els.modalWarning.classList.add('hidden');
  }

  els.modalOverlay.classList.remove('hidden');
  els.inputDatetime.focus();
}

function closeModal() {
  els.modalOverlay.classList.add('hidden');
  pendingQuadrant = null;
}

function onSaveInjection() {
  if (!pendingQuadrant) return;

  const weightVal = els.inputWeight.value.trim();
  const injection = {
    id: generateId(),
    quadrant: pendingQuadrant,
    dose: els.inputDose.value,
    date: els.inputDatetime.value,
    weight: weightVal ? parseFloat(weightVal) : null,
    notes: els.inputNotes.value.trim(),
  };

  state.injections.push(injection);
  saveState();
  closeModal();
  render();
}

// ---- Delete ----
function closeDeleteModal() {
  els.deleteOverlay.classList.add('hidden');
  pendingDeleteId = null;
}

function onConfirmDelete() {
  if (!pendingDeleteId) return;
  state.injections = state.injections.filter(i => i.id !== pendingDeleteId);
  saveState();
  closeDeleteModal();
  render();
}

// ============================================================
// Data Persistence
// ============================================================
function saveState() {
  try {
    localStorage.setItem(CONFIG.storageKey, JSON.stringify(state));
  } catch (e) {
    console.warn('Failed to save:', e);
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(CONFIG.storageKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.injections)) {
        state = parsed;
      }
    }
  } catch (e) {
    console.warn('Failed to load:', e);
  }
}

// ============================================================
// Import / Export
// ============================================================
function exportJSON() {
  const data = JSON.stringify(state, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mounjaro-tracker-${formatDateFile(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function onImportFile(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed || !Array.isArray(parsed.injections)) {
        alert('匯入失敗：JSON 格式不正確');
        return;
      }
      const existingIds = new Set(state.injections.map(i => i.id));
      let newCount = 0;
      for (const inj of parsed.injections) {
        if (!existingIds.has(inj.id)) {
          state.injections.push(inj);
          newCount++;
        }
      }
      saveState();
      render();
      alert(`匯入完成：新增 ${newCount} 筆記錄`);
    } catch (err) {
      alert('匯入失敗：無法解析 JSON 檔案');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

function onClearAll() {
  if (!confirm('確定要清除所有注射記錄嗎？此操作無法復原。')) return;
  state.injections = [];
  saveState();
  render();
}

// ============================================================
// Utility Functions
// ============================================================

function svgEl(tag, attrs, textContent) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  if (textContent !== undefined) el.textContent = textContent;
  return el;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// 取得注射所屬象限 (相容舊資料 x/y 格式)
function getInjQ(inj) {
  if (inj.quadrant) return inj.quadrant;
  // 舊資料相容
  const { cx, cy } = CONFIG.belly;
  const isLeft = (inj.x || 0) < cx;
  const isUp = (inj.y || 0) < cy;
  if (isLeft && isUp) return 'UL';
  if (!isLeft && isUp) return 'UR';
  if (isLeft && !isUp) return 'LL';
  return 'LR';
}

function getLastDaysInQ(qId) {
  const qInj = state.injections.filter(i => getInjQ(i) === qId);
  if (qInj.length === 0) return null;
  let min = Infinity;
  for (const inj of qInj) {
    const d = daysSince(inj.date);
    if (d < min) min = d;
  }
  return min;
}

function getCountInQ(qId) {
  return state.injections.filter(i => getInjQ(i) === qId).length;
}

function daysSince(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  return Math.max(0, Math.floor((now - d) / (1000 * 60 * 60 * 24)));
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${m}/${day} ${h}:${min}`;
}

function formatDateFile(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}
