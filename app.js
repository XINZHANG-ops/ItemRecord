/* ============================================================
   库存商品 — 前端逻辑
   设计要点：
   - 分类是数据驱动的（categories.json），将来可整份替换为 AI 输出的 JSON。
   - 保存采用 append-only + 客户端 UUID：每次提交都是一条独立记录，
     绝不“读出整份→改→写回整份”，将来换 Cloudflare D1 时天然防并发覆盖、可幂等去重。
   - 所有数据读写都走 store 抽象层，将来把内部实现换成 fetch 即可，UI 不动。
   ============================================================ */

/* ---------------- 数据访问层 ---------------- */
// categories 从 VM 实时拉取（AI 更新后即时生效）；records 写 VM API（append-only + UUID 幂等）。
// products 目录仍从静态 JSON 加载（不频繁变动），自定义商品存 localStorage。
const store = {
  async fetchCatalog() {
    const res = await fetch('data/products.json');
    return res.json();
  },
  async fetchCustomProducts() {
    return JSON.parse(localStorage.getItem('itemrecord.customProducts') || '[]');
  },
  async fetchProducts() {
    const [catalog, custom] = await Promise.all([this.fetchCatalog(), this.fetchCustomProducts()]);
    const byCode = new Map();
    for (const p of catalog) byCode.set(p.barcode, { ...p, source: 'catalog' });
    for (const p of custom) if (!byCode.has(p.barcode)) byCode.set(p.barcode, p);
    return [...byCode.values()];
  },
  async addProduct(product) {
    const key = 'itemrecord.customProducts';
    const list = JSON.parse(localStorage.getItem(key) || '[]');
    const catalog = await this.fetchCatalog();
    const exists = list.some((p) => p.barcode === product.barcode) ||
      catalog.some((p) => p.barcode === product.barcode);
    if (exists) return { ok: false, reason: 'duplicate' };
    list.push(product);
    localStorage.setItem(key, JSON.stringify(list));
    return { ok: true };
  },

  // 分类从 VM 拉取（AI 改完立即生效），本地只缓存 5 分钟兜底
  async fetchCategories() {
    try {
      const res = await fetch('/api/categories', { cache: 'no-store' });
      if (!res.ok) throw new Error('api error');
      const data = await res.json();
      localStorage.setItem('itemrecord.categories.cache', JSON.stringify({ ts: Date.now(), data }));
      return data;
    } catch {
      // 离线 / VM 宕机时用本地缓存
      const cached = JSON.parse(localStorage.getItem('itemrecord.categories.cache') || 'null');
      if (cached) return cached.data;
      // 最后兜底：读静态文件
      const res = await fetch('data/categories.json');
      return res.json();
    }
  },

  // append-only + UUID 幂等，优先写 VM API，失败时暂存 localStorage 待下次重试
  async saveRecord(record) {
    try {
      const res = await fetch('/api/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return record;
    } catch (e) {
      // 网络异常时存入本地队列，下次打开时重试
      const q = JSON.parse(localStorage.getItem('itemrecord.pendingRecords') || '[]');
      if (!q.some((r) => r.id === record.id)) {
        q.push(record);
        localStorage.setItem('itemrecord.pendingRecords', JSON.stringify(q));
      }
      throw e;
    }
  },

  async fetchRecords() {
    try {
      const res = await fetch('/api/records', { cache: 'no-store' });
      if (!res.ok) throw new Error('api error');
      return res.json();
    } catch {
      return [];
    }
  },

  // 刷新时把离线暂存的记录补提交
  async flushPendingRecords() {
    const key = 'itemrecord.pendingRecords';
    const q = JSON.parse(localStorage.getItem(key) || '[]');
    if (!q.length) return;
    const remaining = [];
    for (const r of q) {
      try {
        const res = await fetch('/api/records', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(r),
        });
        if (!res.ok) remaining.push(r);
      } catch {
        remaining.push(r);
      }
    }
    localStorage.setItem(key, JSON.stringify(remaining));
  },

  // AI 更新分类
  async updateCategories(instruction, sessionId = null) {
    const res = await fetch('/api/categories/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction, session_id: sessionId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.detail || err.error || `HTTP ${res.status}`);
    }
    return res.json();
  },
};

/* ---------------- 全局状态 ---------------- */
const state = {
  products: [],
  categories: null,
  activeCat: 'all',     // 'all' | 'uncategorized' | category id
  activeSub: null,      // 子分类 id 或 null
  search: '',
  cart: new Map(),      // barcode -> { barcode, name, qty, addedAt }
};

/* ---------------- 工具 ---------------- */
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function fmtTime(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 由名称稳定生成一个柔和渐变色（无图片时当封面）
function coverStyle(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  const h2 = (h + 40) % 360;
  return `background:linear-gradient(135deg,hsl(${h} 65% 62%),hsl(${h2} 65% 52%))`;
}

const matchKeywords = (name, kws) => {
  const n = name.toLowerCase();
  return kws.some((k) => n.includes(k.toLowerCase()));
};

// 为每个商品预计算拼音（全拼无空格 + 首字母），用于搜索。
// 依赖 vendor/pinyin-pro.js；缺失时优雅降级（仅中文/条码可搜）。
function enrichPinyin(products) {
  const lib = (typeof pinyinPro !== 'undefined' && pinyinPro.pinyin) ? pinyinPro : null;
  for (const p of products) {
    if (p.py !== undefined) continue;
    if (lib) {
      try {
        p.py = lib.pinyin(p.name, { toneType: 'none', type: 'array' }).join('').toLowerCase();
        p.pyi = lib.pinyin(p.name, { pattern: 'first', toneType: 'none', type: 'array' }).join('').toLowerCase();
      } catch (e) { p.py = ''; p.pyi = ''; }
    } else { p.py = ''; p.pyi = ''; }
  }
  return products;
}

// 合并 + 拼音富化，单一入口
async function loadProducts() {
  return enrichPinyin(await store.fetchProducts());
}

/* ---------------- 分类 ---------------- */
function catOf(cfg, id) {
  return cfg.categories.find((c) => c.id === id);
}

function itemInCat(product, cat) {
  return matchKeywords(product.name, cat.keywords);
}

function isUncategorized(product) {
  return !state.categories.categories.some((c) => itemInCat(product, c));
}

function countFor(predicate) {
  return state.products.reduce((n, p) => n + (predicate(p) ? 1 : 0), 0);
}

function renderCategoryBar() {
  const cfg = state.categories;
  const main = $('#catMain');
  const chips = [];

  chips.push(chip('all', '全部', state.products.length, state.activeCat === 'all'));
  for (const c of cfg.categories) {
    chips.push(chip(c.id, c.name, countFor((p) => itemInCat(p, c)), state.activeCat === c.id));
  }
  chips.push(chip('uncategorized', cfg.uncategorizedLabel || '未分类',
    countFor(isUncategorized), state.activeCat === 'uncategorized'));
  main.innerHTML = chips.join('');

  main.querySelectorAll('.chip').forEach((el) => {
    el.addEventListener('click', () => {
      state.activeCat = el.dataset.id;
      state.activeSub = null;
      renderCategoryBar();
      renderGrid();
    });
  });

  // 子分类行
  const sub = $('#catSub');
  const active = catOf(cfg, state.activeCat);
  if (active && active.children && active.children.length) {
    const subChips = [subChip(null, '全部 ' + active.name, state.activeSub === null)];
    for (const ch of active.children) {
      const n = countFor((p) => itemInCat(p, active) && matchKeywords(p.name, ch.keywords));
      subChips.push(subChip(ch.id, ch.name, state.activeSub === ch.id, n));
    }
    sub.innerHTML = subChips.join('');
    sub.hidden = false;
    sub.querySelectorAll('.chip').forEach((el) => {
      el.addEventListener('click', () => {
        state.activeSub = el.dataset.id || null;
        renderCategoryBar();
        renderGrid();
      });
    });
  } else {
    sub.hidden = true;
    sub.innerHTML = '';
  }
}

function chip(id, label, count, active) {
  return `<button class="chip${active ? ' active' : ''}" data-id="${esc(id)}">${esc(label)}<span class="count">${count}</span></button>`;
}
function subChip(id, label, active, count) {
  const c = (typeof count === 'number') ? `<span class="count">${count}</span>` : '';
  return `<button class="chip chip-sub${active ? ' active' : ''}" data-id="${id ? esc(id) : ''}">${esc(label)}${c}</button>`;
}

/* ---------------- 过滤 + 网格 ---------------- */
// 多关键词 AND：空格分词，不分顺序，每个词需在 名称/条码/全拼/首字母 任一命中。
// 例：「巴塞」中文、「basailuoxiong」全拼、「bslx」首字母 都能搜到。
function matchSearch(p, terms) {
  if (!terms.length) return true;
  const name = p.name.toLowerCase();
  return terms.every((t) =>
    name.includes(t) || p.barcode.includes(t) ||
    (p.py && p.py.includes(t)) || (p.pyi && p.pyi.includes(t)));
}

function visibleProducts() {
  const cfg = state.categories;
  const terms = state.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return state.products.filter((p) => {
    // 分类过滤
    if (state.activeCat === 'uncategorized') {
      if (!isUncategorized(p)) return false;
    } else if (state.activeCat !== 'all') {
      const cat = catOf(cfg, state.activeCat);
      if (!cat || !itemInCat(p, cat)) return false;
      if (state.activeSub) {
        const ch = (cat.children || []).find((c) => c.id === state.activeSub);
        if (ch && !matchKeywords(p.name, ch.keywords)) return false;
      }
    }
    // 搜索过滤
    if (!matchSearch(p, terms)) return false;
    return true;
  });
}

function renderGrid() {
  const list = visibleProducts();
  $('#resultCount').textContent = `共 ${list.length} 件商品`;
  const grid = $('#grid');
  const empty = $('#emptyState');

  if (!list.length) {
    grid.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  grid.innerHTML = list.map((p) => {
    const inCart = state.cart.has(p.barcode);
    const first = (p.name.match(/[一-龥A-Za-z0-9]/) || ['？'])[0];
    const isNew = p.source === 'custom';
    return `
      <div class="card">
        <div class="card-cover" style="${coverStyle(p.name)}">${esc(first)}${isNew ? '<span class="new-badge">新</span>' : ''}</div>
        <div class="card-body">
          <div class="card-name" title="${esc(p.name)}">${esc(p.name)}</div>
          <div class="card-barcode">${esc(p.barcode)}</div>
          <button class="card-add${inCart ? ' in-cart' : ''}" data-barcode="${esc(p.barcode)}">
            ${inCart ? '已加入 ✓' : '＋ 加入'}
          </button>
        </div>
      </div>`;
  }).join('');

  grid.querySelectorAll('.card-add').forEach((btn) => {
    btn.addEventListener('click', () => addToCart(btn.dataset.barcode));
  });
}

/* ---------------- 购物车 ---------------- */
function addToCart(barcode) {
  const p = state.products.find((x) => x.barcode === barcode);
  if (!p) return;
  const existing = state.cart.get(barcode);
  if (existing) {
    existing.qty += 1;
  } else {
    // 记录每件商品被加入的时间
    state.cart.set(barcode, { barcode: p.barcode, name: p.name, qty: 1, addedAt: new Date().toISOString() });
  }
  toast(`已加入：${p.name}`);
  renderCart();
  renderGrid();
}

function changeQty(barcode, delta) {
  const item = state.cart.get(barcode);
  if (!item) return;
  item.qty += delta;
  if (item.qty <= 0) state.cart.delete(barcode);
  renderCart();
  renderGrid();
}

function removeFromCart(barcode) {
  state.cart.delete(barcode);
  renderCart();
  renderGrid();
}

function cartCount() {
  let n = 0;
  for (const it of state.cart.values()) n += it.qty;
  return n;
}

function renderCart() {
  const count = cartCount();
  const badge = $('#cartBadge');
  badge.textContent = count;
  badge.hidden = count === 0;
  $('#cartTitleCount').textContent = count;
  $('#submitBtn').disabled = state.cart.size === 0;

  const listEl = $('#cartList');
  const emptyEl = $('#cartEmpty');
  if (state.cart.size === 0) {
    listEl.innerHTML = '';
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;
  listEl.innerHTML = [...state.cart.values()].map((it) => `
    <div class="cart-item">
      <div class="ci-info">
        <div class="ci-name">${esc(it.name)}</div>
        <div class="ci-meta">${esc(it.barcode)} · 加入于 ${fmtTime(it.addedAt)}</div>
      </div>
      <div class="qty">
        <button data-act="dec" data-bc="${esc(it.barcode)}">－</button>
        <span>${it.qty}</span>
        <button data-act="inc" data-bc="${esc(it.barcode)}">＋</button>
      </div>
      <button class="ci-del" data-act="del" data-bc="${esc(it.barcode)}" aria-label="删除">🗑</button>
    </div>`).join('');

  listEl.querySelectorAll('button[data-act]').forEach((btn) => {
    const bc = btn.dataset.bc;
    btn.addEventListener('click', () => {
      if (btn.dataset.act === 'inc') changeQty(bc, 1);
      else if (btn.dataset.act === 'dec') changeQty(bc, -1);
      else removeFromCart(bc);
    });
  });
}

function openCart() {
  $('#cartPanel').classList.add('open');
  $('#cartPanel').setAttribute('aria-hidden', 'false');
  $('#overlay').hidden = false;
}
function closeCart() {
  $('#cartPanel').classList.remove('open');
  $('#cartPanel').setAttribute('aria-hidden', 'true');
  $('#overlay').hidden = true;
}

/* ---------------- 提交 ---------------- */
function openSubmit() {
  if (state.cart.size === 0) return;
  const items = [...state.cart.values()];
  $('#submitSummary').innerHTML = items.map((it) =>
    `<div class="row"><span>${esc(it.name)}</span><span>×${it.qty}</span></div>`).join('');
  $('#personInput').value = localStorage.getItem('itemrecord.lastPerson') || '';
  $('#submitOverlay').hidden = false;
  $('#personInput').focus();
}
function closeSubmit() { $('#submitOverlay').hidden = true; }

async function confirmSubmit() {
  const person = $('#personInput').value.trim();
  if (!person) { toast('请填写存货人姓名'); $('#personInput').focus(); return; }

  // 一条独立、自带唯一 id 的记录（append-only，幂等）
  const record = {
    id: uuid(),
    person,
    submittedAt: new Date().toISOString(),
    items: [...state.cart.values()].map((it) => ({
      barcode: it.barcode, name: it.name, qty: it.qty, addedAt: it.addedAt,
    })),
  };

  const btn = $('#submitConfirm');
  btn.disabled = true;
  try {
    await store.saveRecord(record);
    localStorage.setItem('itemrecord.lastPerson', person);
    state.cart.clear();
    renderCart();
    renderGrid();
    closeSubmit();
    closeCart();
    toast('已保存 ✓');
  } catch (e) {
    toast('保存失败，请重试');
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- 新增商品 ---------------- */
function openAddProduct() {
  $('#addName').value = '';
  $('#addBarcode').value = '';
  $('#addPerson').value = localStorage.getItem('itemrecord.lastPerson') || '';
  $('#addOverlay').hidden = false;
  $('#addName').focus();
}
function closeAddProduct() { $('#addOverlay').hidden = true; }

async function confirmAddProduct() {
  const name = $('#addName').value.trim();
  if (!name) { toast('请填写商品名称'); $('#addName').focus(); return; }
  let barcode = $('#addBarcode').value.trim();
  if (!barcode) barcode = 'custom-' + Date.now().toString(36);
  const createdBy = $('#addPerson').value.trim();

  const product = {
    barcode,
    name,
    source: 'custom',
    createdBy: createdBy || null,
    createdAt: new Date().toISOString(),
  };

  const btn = $('#addConfirm');
  btn.disabled = true;
  try {
    const res = await store.addProduct(product);
    if (!res.ok) { toast(res.reason === 'duplicate' ? '该条码已存在' : '保存失败'); return; }
    if (createdBy) localStorage.setItem('itemrecord.lastPerson', createdBy);
    state.products = await loadProducts(); // 重新合并 + 拼音富化，新品立即进入所有视图、分类与拼音搜索
    renderCategoryBar();
    renderGrid();
    closeAddProduct();
    toast('已新增：' + name);
  } catch (e) {
    toast('保存失败，请重试');
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- AI 更新分类 ---------------- */
function openAiCategories() {
  $('#aiCatInstruction').value = '';
  $('#aiCatResult').hidden = true;
  $('#aiCatOverlay').hidden = false;
  $('#aiCatInstruction').focus();
}
function closeAiCategories() { $('#aiCatOverlay').hidden = true; }

async function confirmAiCategories() {
  const instruction = $('#aiCatInstruction').value.trim();
  if (!instruction) { toast('请描述你想怎么修改分类'); $('#aiCatInstruction').focus(); return; }

  const btn = $('#aiCatConfirm');
  btn.disabled = true;
  btn.textContent = 'AI 运行中…';
  $('#aiCatResult').hidden = true;

  try {
    const res = await store.updateCategories(instruction);
    if (res.ok) {
      // 更新成功：重新拉取分类并刷新 UI
      state.categories = await store.fetchCategories();
      renderCategoryBar();
      renderGrid();

      // 显示统计摘要
      const stats = res.stats || {};
      const perCat = Object.entries(stats.per_category || {})
        .map(([k, v]) => `${k}：${v} 件`).join('　');
      $('#aiCatResult').innerHTML =
        `<div class="ai-result-ok">✓ 分类已更新</div>` +
        `<div class="ai-result-stats">${perCat}　未分类：${stats.uncategorized ?? '?'} 件</div>`;
      if (stats.uncategorized_names && stats.uncategorized_names.length) {
        const names = stats.uncategorized_names.slice(0, 10).join('、');
        $('#aiCatResult').innerHTML +=
          `<div class="ai-result-uncat">未分类商品：${names}${stats.uncategorized_names.length > 10 ? '…' : ''}</div>`;
      }
    } else {
      $('#aiCatResult').innerHTML = `<div class="ai-result-err">✗ ${res.message || '更新失败'}</div>`;
    }
    $('#aiCatResult').hidden = false;
  } catch (e) {
    $('#aiCatResult').innerHTML = `<div class="ai-result-err">✗ ${e.message}</div>`;
    $('#aiCatResult').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = '开始更新';
  }
}

/* ---------------- 记录查看 ---------------- */
async function openRecords() {
  const records = await store.fetchRecords();
  const listEl = $('#recordsList');
  const emptyEl = $('#recordsEmpty');
  records.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  if (!records.length) {
    listEl.innerHTML = '';
    emptyEl.hidden = false;
  } else {
    emptyEl.hidden = true;
    listEl.innerHTML = records.map((r) => `
      <div class="record">
        <div class="record-head">
          <span class="record-person">${esc(r.person)}</span>
          <span class="record-time">${esc(fmtTime(r.submittedAt))}</span>
        </div>
        <div class="record-items">
          ${r.items.map((it) => `<span class="tag">${esc(it.name)} ×${it.qty}</span>`).join('')}
        </div>
      </div>`).join('');
  }
  $('#recordsOverlay').hidden = false;
}
function closeRecords() { $('#recordsOverlay').hidden = true; }

/* ---------------- 轻提示 ---------------- */
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 1800);
}

/* ---------------- 搜索（防抖） ---------------- */
function bindSearch() {
  const input = $('#searchInput');
  const clear = $('#searchClear');
  let t = null;
  input.addEventListener('input', () => {
    clear.hidden = !input.value;
    clearTimeout(t);
    t = setTimeout(() => { state.search = input.value; renderGrid(); }, 150);
  });
  clear.addEventListener('click', () => {
    input.value = '';
    clear.hidden = true;
    state.search = '';
    renderGrid();
    input.focus();
  });
}

/* ---------------- 初始化 ---------------- */
async function init() {
  bindSearch();
  $('#cartBtn').addEventListener('click', openCart);
  $('#cartClose').addEventListener('click', closeCart);
  $('#overlay').addEventListener('click', closeCart);
  $('#submitBtn').addEventListener('click', openSubmit);
  $('#submitCancel').addEventListener('click', closeSubmit);
  $('#submitConfirm').addEventListener('click', confirmSubmit);
  $('#recordsBtn').addEventListener('click', openRecords);
  $('#recordsClose').addEventListener('click', closeRecords);
  $('#addProductBtn').addEventListener('click', openAddProduct);
  $('#addCancel').addEventListener('click', closeAddProduct);
  $('#addConfirm').addEventListener('click', confirmAddProduct);
  $('#aiCatBtn').addEventListener('click', openAiCategories);
  $('#aiCatCancel').addEventListener('click', closeAiCategories);
  $('#aiCatConfirm').addEventListener('click', confirmAiCategories);
  $('#addName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#addBarcode').focus(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeCart(); closeSubmit(); closeRecords(); closeAddProduct(); closeAiCategories(); }
  });
  $('#personInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmSubmit(); });

  store.flushPendingRecords(); // 静默补提交上次离线暂存的记录，不阻塞 UI
  try {
    const [products, categories] = await Promise.all([loadProducts(), store.fetchCategories()]);
    state.products = products;
    state.categories = categories;
    renderCategoryBar();
    renderGrid();
    renderCart();
  } catch (e) {
    $('#grid').innerHTML = '';
    $('#emptyState').hidden = false;
    $('#emptyState').textContent = '加载商品数据失败，请通过本地服务器访问（见说明）。';
  }
}

document.addEventListener('DOMContentLoaded', init);
