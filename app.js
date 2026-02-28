// ============================================================
// Mounjaro 腹部注射追蹤器 - Main Application
// ============================================================

// ---- Configuration ----
const CONFIG = {
  // 肚子橢圓區域 (相對於圖片的比例座標 0~1)
  belly: {
    cx: 0.500,   // 肚臍 X 中心
    cy: 0.630,   // 肚臍 Y 中心
    rx: 0.155,   // 水平半徑
    ry: 0.215,   // 垂直半徑
  },
  // 禁區比例 (佔肚子平均半徑的比例，對應 ~5cm)
  exclusionRatio: 0.30,
  // 注射恢復天數 (同一點至少間隔 28 天)
  recoveryDays: 28,
  // 建議注射週期 (天)
  cycleDays: 7,
  // 熱力圖解析度 (格數)
  heatmapRes: 60,
  // 高斯擴散 sigma (歸一化肚子座標)
  sigma: 0.45,
  // localStorage key
  storageKey: 'mounjaro-injection-tracker',
};

// Mounjaro 劑量選項
const DOSE_OPTIONS = ['2.5', '5', '7.5', '10', '12.5', '15'];

// ---- State ----
let state = {
  injections: [],
};

// 暫存新增注射的座標
let pendingClick = null;
// 暫存要刪除的 ID
let pendingDeleteId = null;

// ---- DOM References ----
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let els = {};

// ---- SVG viewBox 尺寸 (根據圖片動態設定) ----
let VB_W = 1000;
let VB_H = 563; // 預設，載入圖片後更新

// ============================================================
// Initialization
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  // 取得 DOM 參考
  els = {
    img: $('#teddy-img'),
    canvas: $('#heatmap-canvas'),
    svg: $('#overlay-svg'),
    statDays: $('#days-since'),
    statNext: $('#next-suggestion'),
    statCount: $('#total-count'),
    historyList: $('#history-list'),
    emptyMsg: $('#empty-msg'),
    modalOverlay: $('#modal-overlay'),
    modalQuadrant: $('#modal-quadrant-info'),
    modalWarning: $('#modal-warning'),
    inputDatetime: $('#input-datetime'),
    inputDose: $('#input-dose'),
    inputNotes: $('#input-notes'),
    deleteOverlay: $('#delete-overlay'),
    exportBtn: $('#export-btn'),
    importBtn: $('#import-btn'),
    importFile: $('#import-file'),
    clearBtn: $('#clear-btn'),
  };

  // 載入資料
  loadState();

  // 圖片載入後設定 overlay
  if (els.img.complete && els.img.naturalWidth > 0) {
    onImageReady();
  } else {
    els.img.addEventListener('load', onImageReady);
  }

  // 綁定事件
  bindEvents();
});

function onImageReady() {
  const { naturalWidth, naturalHeight } = els.img;
  const aspect = naturalHeight / naturalWidth;
  VB_H = Math.round(VB_W * aspect);

  // Canvas 解析度
  els.canvas.width = VB_W;
  els.canvas.height = VB_H;

  // SVG viewBox
  els.svg.setAttribute('viewBox', `0 0 ${VB_W} ${VB_H}`);

  render();
}

// ============================================================
// Event Binding
// ============================================================
function bindEvents() {
  // 點擊肚子
  els.svg.addEventListener('click', onOverlayClick);
  els.svg.addEventListener('touchend', onOverlayTouchEnd);

  // Modal 儲存 / 取消
  $('#modal-save').addEventListener('click', onSaveInjection);
  $('#modal-cancel').addEventListener('click', closeModal);
  els.modalOverlay.addEventListener('click', (e) => {
    if (e.target === els.modalOverlay) closeModal();
  });

  // 刪除確認
  $('#delete-confirm').addEventListener('click', onConfirmDelete);
  $('#delete-cancel').addEventListener('click', closeDeleteModal);
  els.deleteOverlay.addEventListener('click', (e) => {
    if (e.target === els.deleteOverlay) closeDeleteModal();
  });

  // 匯出 / 匯入 / 清除
  els.exportBtn.addEventListener('click', exportJSON);
  els.importBtn.addEventListener('click', () => els.importFile.click());
  els.importFile.addEventListener('change', onImportFile);
  els.clearBtn.addEventListener('click', onClearAll);
}

// ============================================================
// Rendering
// ============================================================
function render() {
  renderHeatmap();
  renderSVGOverlay();
  renderStats();
  renderHistory();
}

// ---- Heatmap (Canvas) ----
function renderHeatmap() {
  const ctx = els.canvas.getContext('2d');
  ctx.clearRect(0, 0, VB_W, VB_H);

  const res = CONFIG.heatmapRes;
  const offscreen = document.createElement('canvas');
  offscreen.width = res;
  offscreen.height = res;
  const offCtx = offscreen.getContext('2d');
  const imgData = offCtx.createImageData(res, res);

  for (let gy = 0; gy < res; gy++) {
    for (let gx = 0; gx < res; gx++) {
      const rx = gx / res;
      const ry = gy / res;
      const score = calculatePointScore(rx, ry);
      const idx = (gy * res + gx) * 4;

      if (score === -2) {
        // 肚子外部 → 透明
        imgData.data[idx] = 0;
        imgData.data[idx + 1] = 0;
        imgData.data[idx + 2] = 0;
        imgData.data[idx + 3] = 0;
      } else {
        const [r, g, b, a] = scoreToRGBA(score);
        imgData.data[idx] = r;
        imgData.data[idx + 1] = g;
        imgData.data[idx + 2] = b;
        imgData.data[idx + 3] = a;
      }
    }
  }

  offCtx.putImageData(imgData, 0, 0);

  // 繪製到主 canvas，以橢圓裁切
  ctx.save();
  ctx.beginPath();
  const bcx = VB_W * CONFIG.belly.cx;
  const bcy = VB_H * CONFIG.belly.cy;
  const brx = VB_W * CONFIG.belly.rx;
  const bry = VB_H * CONFIG.belly.ry;
  ctx.ellipse(bcx, bcy, brx, bry, 0, 0, Math.PI * 2);
  ctx.clip();

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // 將 offscreen 的肚子區域映射到 canvas 的肚子區域
  const srcX = (CONFIG.belly.cx - CONFIG.belly.rx) * res;
  const srcY = (CONFIG.belly.cy - CONFIG.belly.ry) * res;
  const srcW = CONFIG.belly.rx * 2 * res;
  const srcH = CONFIG.belly.ry * 2 * res;

  ctx.drawImage(
    offscreen,
    srcX, srcY, srcW, srcH,
    bcx - brx, bcy - bry, brx * 2, bry * 2
  );

  ctx.restore();
}

// ---- SVG Overlay ----
function renderSVGOverlay() {
  const svg = els.svg;
  svg.innerHTML = '';

  const bcx = VB_W * CONFIG.belly.cx;
  const bcy = VB_H * CONFIG.belly.cy;
  const brx = VB_W * CONFIG.belly.rx;
  const bry = VB_H * CONFIG.belly.ry;

  // 可點擊區域 (透明橢圓)
  const clickArea = svgEl('ellipse', {
    cx: bcx, cy: bcy, rx: brx, ry: bry,
    fill: 'transparent',
    stroke: 'rgba(139,126,111,0.2)',
    'stroke-width': 1.5,
    'stroke-dasharray': '6 4',
    class: 'click-area',
    cursor: 'crosshair',
  });
  svg.appendChild(clickArea);

  // 象限虛線 (水平 + 垂直穿過肚臍)
  const dashStyle = {
    stroke: 'rgba(139,126,111,0.3)',
    'stroke-width': 1,
    'stroke-dasharray': '8 5',
  };
  // 水平線
  svg.appendChild(svgEl('line', {
    x1: bcx - brx, y1: bcy, x2: bcx + brx, y2: bcy, ...dashStyle,
  }));
  // 垂直線
  svg.appendChild(svgEl('line', {
    x1: bcx, y1: bcy - bry, x2: bcx, y2: bcy + bry, ...dashStyle,
  }));

  // 禁區圓圈
  const avgR = (brx + bry) / 2;
  const exR = avgR * CONFIG.exclusionRatio;
  svg.appendChild(svgEl('circle', {
    cx: bcx, cy: bcy, r: exR,
    fill: 'rgba(199,92,92,0.08)',
    stroke: 'rgba(199,92,92,0.4)',
    'stroke-width': 1,
    'stroke-dasharray': '4 3',
  }));

  // 禁區 X 標記
  const xs = exR * 0.4;
  svg.appendChild(svgEl('line', {
    x1: bcx - xs, y1: bcy - xs, x2: bcx + xs, y2: bcy + xs,
    stroke: 'rgba(199,92,92,0.35)', 'stroke-width': 1.5,
  }));
  svg.appendChild(svgEl('line', {
    x1: bcx + xs, y1: bcy - xs, x2: bcx - xs, y2: bcy + xs,
    stroke: 'rgba(199,92,92,0.35)', 'stroke-width': 1.5,
  }));

  // 象限標籤
  const labelStyle = {
    'font-size': '13',
    'font-family': "'Noto Sans TC', sans-serif",
    'font-weight': '500',
    fill: 'rgba(139,126,111,0.5)',
    'text-anchor': 'middle',
    'pointer-events': 'none',
  };

  const labels = [
    { text: '左上', x: bcx - brx * 0.5, y: bcy - bry * 0.5 },
    { text: '右上', x: bcx + brx * 0.5, y: bcy - bry * 0.5 },
    { text: '左下', x: bcx - brx * 0.5, y: bcy + bry * 0.55 },
    { text: '右下', x: bcx + brx * 0.5, y: bcy + bry * 0.55 },
  ];

  labels.forEach(({ text, x, y }) => {
    svg.appendChild(svgEl('text', { x, y, ...labelStyle }, text));
  });

  // 注射點
  state.injections.forEach((inj) => {
    const ix = inj.x * VB_W;
    const iy = inj.y * VB_H;
    const days = daysSince(inj.date);
    const dotColor = days < 7 ? '#c75c5c'
      : days < 14 ? '#d4956a'
        : days < 21 ? '#d4b86a'
          : days < 28 ? '#8fb86a'
            : '#5a9e6f';

    // 外圈光暈
    if (days < 28) {
      const haloR = 12 + (1 - days / 28) * 8;
      svg.appendChild(svgEl('circle', {
        cx: ix, cy: iy, r: haloR,
        fill: dotColor,
        opacity: 0.15,
        'pointer-events': 'none',
      }));
    }

    // 主點
    const dot = svgEl('circle', {
      cx: ix, cy: iy, r: 6,
      fill: dotColor,
      stroke: '#fff',
      'stroke-width': 1.5,
      opacity: 0.9,
      'pointer-events': 'none',
    });
    svg.appendChild(dot);

    // 天數標示
    if (days <= 28) {
      svg.appendChild(svgEl('text', {
        x: ix,
        y: iy - 10,
        'font-size': '9',
        'font-family': "'Noto Sans TC', sans-serif",
        'font-weight': '600',
        fill: dotColor,
        'text-anchor': 'middle',
        'pointer-events': 'none',
      }, `${days}天`));
    }
  });
}

// ---- Stats ----
function renderStats() {
  const count = state.injections.length;
  els.statCount.textContent = count;

  if (count === 0) {
    els.statDays.textContent = '--';
    els.statNext.textContent = '--';
    return;
  }

  // 最近一次注射
  const sorted = [...state.injections].sort(
    (a, b) => new Date(b.date) - new Date(a.date)
  );
  const lastDays = daysSince(sorted[0].date);
  els.statDays.textContent = lastDays === 0 ? '今天' : `${lastDays} 天`;

  // 下次建議
  const daysLeft = CONFIG.cycleDays - lastDays;
  if (daysLeft <= 0) {
    els.statNext.textContent = '現在';
    els.statNext.style.color = '#c75c5c';
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
    const dotColor = days < 7 ? '#c75c5c'
      : days < 14 ? '#d4956a'
        : days < 21 ? '#d4b86a'
          : days < 28 ? '#8fb86a'
            : '#5a9e6f';
    const quadrant = getQuadrantName(inj.x, inj.y);
    const dateStr = formatDate(inj.date);
    const daysText = days === 0 ? '今天' : `${days} 天前`;
    const notesText = inj.notes ? ` · ${inj.notes}` : '';

    const item = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML = `
      <span class="history-dot" style="background:${dotColor}"></span>
      <div class="history-body">
        <div class="history-main">
          <span class="history-date">${dateStr}</span>
          <span class="history-quadrant">${quadrant}</span>
          <span class="history-dose">${inj.dose} mg</span>
        </div>
        <div class="history-sub">${daysText}${notesText}</div>
      </div>
      <button class="history-delete" data-id="${inj.id}" title="刪除">&times;</button>
    `;

    // 刪除按鈕
    item.querySelector('.history-delete').addEventListener('click', () => {
      pendingDeleteId = inj.id;
      els.deleteOverlay.classList.remove('hidden');
    });

    // hover 高亮對應的點
    item.addEventListener('mouseenter', () => highlightDot(inj.id, true));
    item.addEventListener('mouseleave', () => highlightDot(inj.id, false));

    list.appendChild(item);
  });
}

function highlightDot(id, show) {
  const inj = state.injections.find((i) => i.id === id);
  if (!inj) return;

  // 移除舊的高亮
  const old = els.svg.querySelector('.highlight-ring');
  if (old) old.remove();

  if (show) {
    const ring = svgEl('circle', {
      cx: inj.x * VB_W,
      cy: inj.y * VB_H,
      r: 14,
      fill: 'none',
      stroke: '#c6905a',
      'stroke-width': 2.5,
      opacity: 0.8,
      class: 'highlight-ring',
      'pointer-events': 'none',
    });
    els.svg.appendChild(ring);
  }
}

// ============================================================
// Recommendation Engine
// ============================================================
function calculatePointScore(rx, ry) {
  // 判斷是否在肚子橢圓內
  const { cx, cy } = CONFIG.belly;
  const nDx = (rx - cx) / CONFIG.belly.rx;
  const nDy = (ry - cy) / CONFIG.belly.ry;
  const normDist = Math.sqrt(nDx * nDx + nDy * nDy);

  if (normDist > 1) return -2; // 橢圓外部

  // 禁區
  if (normDist < CONFIG.exclusionRatio) return -1;

  // 無注射 → 最推薦
  if (state.injections.length === 0) return 1.0;

  let worstInfluence = 0;

  for (const inj of state.injections) {
    const days = daysSince(inj.date);
    // 時間因子：0 天 → 1.0，28 天 → 0.0
    const timeFactor = Math.max(0, 1 - days / CONFIG.recoveryDays);
    if (timeFactor === 0) continue;

    // 距離因子 (歸一化座標系中的歐氏距離)
    const dx = (rx - inj.x) / CONFIG.belly.rx;
    const dy = (ry - inj.y) / CONFIG.belly.ry;
    const dist = Math.sqrt(dx * dx + dy * dy);

    const sigma = CONFIG.sigma;
    const distFactor = Math.exp(-(dist * dist) / (2 * sigma * sigma));

    const influence = timeFactor * distFactor;
    worstInfluence = Math.max(worstInfluence, influence);
  }

  return 1 - worstInfluence; // 1=最推薦, 0=最不推薦
}

function scoreToRGBA(score) {
  // 禁區
  if (score === -1) return [199, 92, 92, 60]; // 半透明紅

  // 分數 0~1 映射到 HSL 色相 0°(紅)→120°(綠)
  const hue = Math.max(0, Math.min(1, score)) * 120;
  const [r, g, b] = hslToRgb(hue / 360, 0.55, 0.50);
  const alpha = Math.round(75 - score * 30); // 低分更明顯

  return [r, g, b, alpha];
}

// ============================================================
// Click Handling
// ============================================================
function onOverlayClick(e) {
  const pt = svgPoint(e);
  if (!pt) return;
  handleClick(pt.x / VB_W, pt.y / VB_H);
}

function onOverlayTouchEnd(e) {
  // 阻止 touch 後觸發的 click 事件
  if (e.touches && e.touches.length > 0) return;
  e.preventDefault();
  const touch = e.changedTouches[0];
  const rect = els.svg.getBoundingClientRect();
  const rx = (touch.clientX - rect.left) / rect.width;
  const ry = (touch.clientY - rect.top) / rect.height;
  handleClick(rx, ry);
}

function handleClick(rx, ry) {
  // 檢查是否在肚子區域內
  if (!isInBellyArea(rx, ry)) return;

  // 檢查禁區
  if (isInExclusionZone(rx, ry)) {
    showWarningToast('此位置在肚臍禁區內（需距離肚臍 5 公分以上）');
    return;
  }

  // 記錄座標，開啟 modal
  pendingClick = { x: rx, y: ry };
  openModal(rx, ry);
}

function svgPoint(e) {
  const svg = els.svg;
  const pt = svg.createSVGPoint();
  pt.x = e.clientX;
  pt.y = e.clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  return pt.matrixTransform(ctm.inverse());
}

// ============================================================
// Modal
// ============================================================
function openModal(rx, ry) {
  const quadrant = getQuadrantName(rx, ry);
  els.modalQuadrant.textContent = `位置：${quadrant}`;

  // 預設為現在時間
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  els.inputDatetime.value = now.toISOString().slice(0, 16);

  // 保留上次使用的劑量
  if (state.injections.length > 0) {
    const sorted = [...state.injections].sort(
      (a, b) => new Date(b.date) - new Date(a.date)
    );
    els.inputDose.value = sorted[0].dose;
  }

  els.inputNotes.value = '';

  // 接近既有注射點的警告
  const warnings = getProximityWarnings(rx, ry);
  if (warnings.length > 0) {
    els.modalWarning.textContent = warnings.join('\n');
    els.modalWarning.classList.remove('hidden');
  } else {
    els.modalWarning.classList.add('hidden');
  }

  els.modalOverlay.classList.remove('hidden');
  els.inputDatetime.focus();
}

function closeModal() {
  els.modalOverlay.classList.add('hidden');
  pendingClick = null;
}

function onSaveInjection() {
  if (!pendingClick) return;

  const injection = {
    id: generateId(),
    x: pendingClick.x,
    y: pendingClick.y,
    dose: els.inputDose.value,
    date: els.inputDatetime.value,
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
  state.injections = state.injections.filter((i) => i.id !== pendingDeleteId);
  saveState();
  closeDeleteModal();
  render();
}

// ---- Proximity Warnings ----
function getProximityWarnings(rx, ry) {
  const warnings = [];
  const brx = CONFIG.belly.rx;
  const bry = CONFIG.belly.ry;

  for (const inj of state.injections) {
    const days = daysSince(inj.date);
    if (days >= CONFIG.recoveryDays) continue;

    const dx = (rx - inj.x) / brx;
    const dy = (ry - inj.y) / bry;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // 接近度 (< 0.3 歸一化距離 ≈ 一根手指寬)
    if (dist < 0.3) {
      warnings.push(
        `距離 ${days} 天前的注射點過近，建議保持至少一根手指寬度的間距`
      );
      break; // 只顯示一個警告
    }
  }

  return warnings;
}

// ============================================================
// Data Persistence
// ============================================================
function saveState() {
  try {
    localStorage.setItem(CONFIG.storageKey, JSON.stringify(state));
  } catch (e) {
    console.warn('Failed to save to localStorage:', e);
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
    console.warn('Failed to load from localStorage:', e);
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
      // 合併或覆蓋
      const existingIds = new Set(state.injections.map((i) => i.id));
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
  // 重置 input 以允許重複匯入同一檔案
  e.target.value = '';
}

function onClearAll() {
  if (!confirm('確定要清除所有注射記錄嗎？此操作無法復原。')) return;
  state.injections = [];
  saveState();
  render();
}

// ============================================================
// Toast Warning
// ============================================================
function showWarningToast(msg) {
  // 簡易 toast
  let toast = document.querySelector('.toast-warning');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast-warning';
    toast.style.cssText = `
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: #c75c5c; color: #fff; padding: 10px 20px;
      border-radius: 8px; font-size: 0.85rem; font-weight: 500;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15); z-index: 2000;
      transition: opacity 0.3s; font-family: 'Noto Sans TC', sans-serif;
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.style.opacity = '0';
  }, 2500);
}

// ============================================================
// Utility Functions
// ============================================================

// SVG 元素建立
function svgEl(tag, attrs, textContent) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  if (textContent !== undefined) {
    el.textContent = textContent;
  }
  return el;
}

// 唯一 ID
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// 判斷點是否在肚子橢圓內
function isInBellyArea(rx, ry) {
  const { cx, cy } = CONFIG.belly;
  const nDx = (rx - cx) / CONFIG.belly.rx;
  const nDy = (ry - cy) / CONFIG.belly.ry;
  return (nDx * nDx + nDy * nDy) <= 1;
}

// 判斷是否在禁區內
function isInExclusionZone(rx, ry) {
  const { cx, cy } = CONFIG.belly;
  const nDx = (rx - cx) / CONFIG.belly.rx;
  const nDy = (ry - cy) / CONFIG.belly.ry;
  return Math.sqrt(nDx * nDx + nDy * nDy) < CONFIG.exclusionRatio;
}

// 象限名稱
function getQuadrantName(rx, ry) {
  const { cx, cy } = CONFIG.belly;
  const isLeft = rx < cx;
  const isUp = ry < cy;
  if (isLeft && isUp) return '左上';
  if (!isLeft && isUp) return '右上';
  if (isLeft && !isUp) return '左下';
  return '右下';
}

// 天數計算
function daysSince(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

// 日期格式化
function formatDate(dateStr) {
  const d = new Date(dateStr);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${m}/${day} ${h}:${min}`;
}

// 匯出用日期
function formatDateFile(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// HSL → RGB 轉換
function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}
