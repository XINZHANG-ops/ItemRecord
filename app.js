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
  // 商品来源改为 VM（全设备共享），仿 fetchCategories 的缓存兜底
  async fetchProducts() {
    try {
      const res = await fetch('/api/products', { cache: 'no-store' });
      if (!res.ok) throw new Error('api error');
      const data = await res.json();
      localStorage.setItem('itemrecord.products.cache', JSON.stringify({ ts: Date.now(), data }));
      return data;
    } catch {
      const cached = JSON.parse(localStorage.getItem('itemrecord.products.cache') || 'null');
      if (cached) return cached.data;
      return this.fetchCatalog();   // 最后兜底：静态种子
    }
  },
  // 新增/批量导入商品（都走 VM，密码服务端校验）
  async addProducts(items, password = '') {
    const res = await fetch('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || err.error || `HTTP ${res.status}`);
    }
    return res.json();   // { ok, added, skipped, total }
  },
  // 上传表格 → AI 解析成 [{barcode,name}]（不落库，前端确认后再 addProducts）
  async parseProductsFile(filename, dataB64, password = '') {
    const res = await fetch('/api/products/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, dataB64, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || err.error || `HTTP ${res.status}`);
    }
    return res.json();   // { ok, items } | { ok:false, error }
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

  // 校验管理密码（真正的密码只在 VM 上，客户端代码不含明文）
  async verifyPassword(pw) {
    const res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();   // { ok: boolean }
  },

  // 清空所有记录（软删除：后端追加删除事件，数据仍完整保留）
  async clearRecords(pw = '') {
    const res = await fetch(`/api/records?pw=${encodeURIComponent(pw)}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.detail || err.error || `HTTP ${res.status}`);
    }
    return res.json();
  },

  // 删除单条记录（软删除：后端追加删除事件，原记录不动）
  async deleteRecord(id, pw = '') {
    const res = await fetch(`/api/records/${encodeURIComponent(id)}?pw=${encodeURIComponent(pw)}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.detail || err.error || `HTTP ${res.status}`);
    }
    return res.json();
  },

  // 完整溯源：所有记录（含已删）+ 所有删除事件
  async fetchAudit() {
    const res = await fetch('/api/records/audit', { cache: 'no-store' });
    if (!res.ok) throw new Error('api error');
    return res.json();   // { records, deletions }
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

  // AI 更新分类（密码随请求发往后端校验）
  async updateCategories(instruction, password = '') {
    const res = await fetch('/api/categories/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction, password }),
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
  editBarcode: null,    // 当前数量编辑弹窗对应的商品
  editQty: 0,           // 弹窗中的待提交数量（关闭时才落到购物车）
  recordsView: 'current', // 记录弹窗当前视图：'current' | 'audit'
};

/* ---------------- 工具 ---------------- */
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clampQty = (n) => Math.max(-9999, Math.min(9999, n));

// 弹窗打开时锁住背景滚动（iOS 用 position:fixed 才可靠）。计数器支持弹窗叠加（如记录上再开密码框）。
let _scrollLockY = 0;
let _scrollLocks = 0;
function lockScroll() {
  if (_scrollLocks === 0) {
    _scrollLockY = window.scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${_scrollLockY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.width = '100%';
  }
  _scrollLocks++;
}
function unlockScroll() {
  _scrollLocks = Math.max(0, _scrollLocks - 1);
  if (_scrollLocks === 0) {
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    document.body.style.width = '';
    window.scrollTo(0, _scrollLockY);
  }
}

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

// 为每张卡片选一个「最能代表本商品」的 2~3 字词。思路：
// 1) 只看名字「前段」（逗号/括号/数字=尺码后缀之前）；
// 2) 浏览器内置 ICU 中文分词 Intl.Segmenter（零依赖、零下载）识别真词作强信号；
// 3) 对整份目录做 n-gram 统计：反复出现且字紧密绑定的串(如 邦尼兔/三叶草)也算真词，
//    弥补 ICU 词典缺失；占比过高的通用前缀(如 趣味)排除；
// 4) 这类商品名里有意义的名词几乎都在词尾，故取最靠右的真词；都没有则取末段尾部两字。
// 随商品列表变化重算。
function computeCardTags(products) {
  const CN = /[一-龥]/;
  const head = (name) => {
    const i = name.search(/[，,（(0-9]/);             // 尺码/数量后缀总以逗号、括号或数字开头
    const s = (i === -1 ? name : name.slice(0, i)).trim();
    return s || name;
  };
  const heads = products.map((p) => head(p.name));
  const N = products.length || 1;

  // 字符 / 2~3字 n-gram 的文档频率（按名字前段，每名去重）
  const cf = new Map(), df = new Map();
  const gramsOf = (h) => {
    const out = [];
    for (const r of (h.match(/[一-龥]+/g) || []))
      for (let k = 2; k <= 3; k++)
        for (let i = 0; i + k <= r.length; i++) out.push(r.slice(i, i + k));
    return out;
  };
  for (const h of heads) {
    const sc = new Set();
    for (const c of h) if (CN.test(c) && !sc.has(c)) { sc.add(c); cf.set(c, (cf.get(c) || 0) + 1); }
    const sg = new Set();
    for (const g of gramsOf(h)) if (!sg.has(g)) { sg.add(g); df.set(g, (df.get(g) || 0) + 1); }
  }

  const icu = new Set();                              // ICU 认得的真词（老浏览器无则为空）
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      const seg = new Intl.Segmenter('zh', { granularity: 'word' });
      for (const h of heads)
        for (const { segment: w } of seg.segment(h))
          if ((w.length === 2 || w.length === 3) && [...w].every((c) => CN.test(c))) icu.add(w);
    }
  } catch (e) { /* 无分词器，仅靠统计 */ }

  const cohesion = (g) => { let p = 1; for (const c of g) p *= cf.get(c); return df.get(g) / Math.pow(p, 1 / g.length); };
  const isWord = (g) => (df.get(g) / N <= 0.35) && (icu.has(g) || (df.get(g) >= 2 && cohesion(g) >= 0.55));

  products.forEach((p, idx) => {
    const h = heads[idx];
    let best = null, bestEnd = -1, bestLen = 0;        // 取最靠右的真词；同末尾偏好更长
    for (const m of h.matchAll(/[一-龥]+/g)) {
      const r = m[0], base = m.index;
      for (let k = 2; k <= 3; k++)
        for (let i = 0; i + k <= r.length; i++) {
          const g = r.slice(i, i + k);
          if (isWord(g)) {
            const end = base + i + k;
            if (end > bestEnd || (end === bestEnd && k > bestLen)) { bestEnd = end; bestLen = k; best = g; }
          }
        }
    }
    if (!best) {                                       // 兜底：末段尾部两字，再退字母/数字/首字
      const runs = h.match(/[一-龥]+/g);
      const last = runs ? runs[runs.length - 1] : '';
      best = last.length >= 2 ? last.slice(-2)
        : ((h.match(/[A-Za-z0-9]{1,3}/) || [])[0] || (h.match(/[一-龥A-Za-z0-9]/) || ['？'])[0]);
    }
    p.tag = best;
  });
  return products;
}

// 合并 + 拼音富化 + 卡片标签，单一入口
async function loadProducts() {
  return computeCardTags(enrichPinyin(await store.fetchProducts()));
}

/* ---------------- 分类 ---------------- */
function catOf(cfg, id) {
  return cfg.categories.find((c) => c.id === id);
}

function itemInCat(product, cat) {
  // catchAll: true 表示"不属于其他任何分类"的商品都归入此类
  if (cat.catchAll) {
    return !state.categories.categories.some((c) => !c.catchAll && matchKeywords(product.name, c.keywords));
  }
  return matchKeywords(product.name, cat.keywords);
}

function isUncategorized(product) {
  // 有 catchAll 分类时，所有商品都有归属，不存在真正的"未分类"
  if (state.categories.categories.some((c) => c.catchAll)) return false;
  return !state.categories.categories.some((c) => itemInCat(product, c));
}

// 卡片上展示用：商品当前所属的主分类名（优先具体分类 → catchAll 兜底 → 未分类）
function categoryNameOf(product) {
  const cfg = state.categories;
  for (const c of cfg.categories) {
    if (!c.catchAll && matchKeywords(product.name, c.keywords)) return c.name;
  }
  const fallback = cfg.categories.find((c) => c.catchAll);
  if (fallback) return fallback.name;
  return cfg.uncategorizedLabel || '未分类';
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
    const qty = state.cart.get(p.barcode)?.qty ?? 0;
    const isNew = p.source === 'custom';
    const cat = categoryNameOf(p);
    return `
      <div class="card">
        <div class="card-cover" style="${coverStyle(p.name)}"><span class="cover-char">${esc(p.tag || '')}</span><span class="cover-cat" title="${esc(cat)}">${esc(cat)}</span>${isNew ? '<span class="new-badge">新</span>' : ''}</div>
        <div class="card-body">
          <div class="card-name" title="${esc(p.name)}">${esc(p.name)}</div>
          <div class="card-barcode">${esc(p.barcode)}</div>
          <div class="card-stepper${inCart ? ' active' : ''}">
            <button class="card-step" data-barcode="${esc(p.barcode)}" data-delta="-1" aria-label="减少">−</button>
            <span class="card-qty" data-barcode="${esc(p.barcode)}" role="button" tabindex="0" title="点击输入数量（可正可负）">${qty}</span>
            <button class="card-step" data-barcode="${esc(p.barcode)}" data-delta="1" aria-label="增加">＋</button>
          </div>
        </div>
      </div>`;
  }).join('');

  grid.querySelectorAll('.card-step').forEach((btn) => {
    btn.addEventListener('click', () => stepCard(btn.dataset.barcode, Number(btn.dataset.delta)));
  });
  // 点数字弹出小窗编辑（卡片窄放不下 ±，弹窗里有加减和正负切换）
  grid.querySelectorAll('.card-qty').forEach((el) => {
    el.addEventListener('click', () => openQtyEditor(el.dataset.barcode));
  });
}

// 给数量输入框绑定：聚焦全选、回车收起键盘、change 时提交（避免每键重渲染丢焦点）
function bindQtyInputs(scope, dataKey) {
  scope.querySelectorAll('input[inputmode="numeric"]').forEach((inp) => {
    inp.addEventListener('focus', () => inp.select());
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    inp.addEventListener('change', () => setQty(inp.dataset[dataKey], inp.value));
  });
}

/* ---------------- 购物车 ---------------- */
// 购物车持久化：选购过程可能长达半小时，手机后台回收标签页会重载页面，
// 内存里的 cart 会丢。每次变更都写本地，init 时恢复，确保刷新/回收后选购不丢。
const CART_KEY = 'itemrecord.cart';
function persistCart() {
  localStorage.setItem(CART_KEY, JSON.stringify([...state.cart.values()]));
}
function restoreCart() {
  try {
    const arr = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    if (Array.isArray(arr)) state.cart = new Map(arr.filter((it) => it && it.barcode).map((it) => [it.barcode, it]));
  } catch { /* 损坏则忽略，保持空车 */ }
}

// 卡片上的 −/＋：记录流通流水，数量可正可负可为 0（负数=出库）。
// 不再在 0 处自动移除——要从车里删除请用购物车里的 🗑。
function stepCard(barcode, delta) {
  const item = state.cart.get(barcode);
  if (!item) {
    if (delta === 0) return;
    const p = state.products.find((x) => x.barcode === barcode);
    if (!p) return;
    state.cart.set(barcode, { barcode: p.barcode, name: p.name, qty: delta, addedAt: new Date().toISOString() });
  } else {
    const q = clampQty(item.qty + delta);
    if (q === 0) state.cart.delete(barcode);   // 归 0 = 不记录，移出购物车
    else item.qty = q;
  }
  persistCart();
  renderCart();
  renderGrid();
}

// 设置数量：可正可负。0 = 不记录，移出购物车。空/非法不改动。
function setQty(barcode, value) {
  let q = parseInt(String(value).trim(), 10);
  if (isNaN(q)) { renderCart(); renderGrid(); return; }
  q = clampQty(q);
  const item = state.cart.get(barcode);
  if (q === 0) {
    if (item) state.cart.delete(barcode);
  } else if (!item) {
    const p = state.products.find((x) => x.barcode === barcode);
    if (p) state.cart.set(barcode, { barcode: p.barcode, name: p.name, qty: q, addedAt: new Date().toISOString() });
  } else {
    item.qty = q;
  }
  persistCart();
  renderCart();
  renderGrid();
}

function changeQty(barcode, delta) {
  const item = state.cart.get(barcode);
  if (!item) return;
  const q = clampQty(item.qty + delta);
  if (q === 0) state.cart.delete(barcode);   // 归 0 = 移出购物车
  else item.qty = q;
  persistCart();
  renderCart();
  renderGrid();
}

function removeFromCart(barcode) {
  state.cart.delete(barcode);
  persistCart();
  renderCart();
  renderGrid();
}

// 正负切换：iOS 数字键盘无减号键，靠此按钮把数量翻成负数（出库）/正数（入库）
function toggleSign(barcode) {
  const item = state.cart.get(barcode);
  if (!item) return;
  item.qty = -item.qty;
  persistCart();
  renderCart();
  renderGrid();
}

/* ---------------- 数量编辑弹窗（点卡片数字弹出，含加减与正负） ---------------- */
function openQtyEditor(barcode) {
  const p = state.products.find((x) => x.barcode === barcode);
  if (!p && !state.cart.has(barcode)) return;
  state.editBarcode = barcode;
  state.editQty = state.cart.get(barcode)?.qty ?? 0;
  $('#qtyEditName').textContent = state.cart.get(barcode)?.name || p?.name || '数量';
  syncQtyEditor();
  $('#qtyOverlay').hidden = false;
  const inp = $('#qtyEditInput');
  inp.focus();
  inp.select();
}
function syncQtyEditor() { $('#qtyEditInput').value = state.editQty; }
function stepQtyEditor(delta) { state.editQty = clampQty(state.editQty + delta); syncQtyEditor(); }
function signQtyEditor() { state.editQty = -state.editQty; syncQtyEditor(); }
function inputQtyEditor(value) {
  const v = parseInt(String(value).trim(), 10);
  state.editQty = isNaN(v) ? 0 : clampQty(v);
}
function commitQtyEditor() {
  if (state.editBarcode != null) setQty(state.editBarcode, state.editQty); // 0 自动移出
  closeQtyEditor();
}
function closeQtyEditor() {
  $('#qtyOverlay').hidden = true;
  state.editBarcode = null;
}

function renderCart() {
  // 两个数：种类数（车里有几样商品）+ 总数（各商品数量之和，可正可负=净流通）
  const count = state.cart.size;
  const total = [...state.cart.values()].reduce((s, it) => s + it.qty, 0);
  const badge = $('#cartBadge');
  badge.textContent = count === 0 ? '' : `${count}·${total}`;  // 红圈：种类·总数
  badge.hidden = count === 0;
  $('#cartTitleCount').textContent = count;
  $('#cartTitleTotal').textContent = total;
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
        <input type="text" inputmode="numeric" pattern="-?[0-9]*" value="${it.qty}" data-bc="${esc(it.barcode)}" aria-label="数量" />
        <button data-act="inc" data-bc="${esc(it.barcode)}">＋</button>
      </div>
      <button class="ci-sign" data-act="sign" data-bc="${esc(it.barcode)}" aria-label="正负切换">±</button>
      <button class="ci-del" data-act="del" data-bc="${esc(it.barcode)}" aria-label="删除">🗑</button>
    </div>`).join('');

  listEl.querySelectorAll('button[data-act]').forEach((btn) => {
    const bc = btn.dataset.bc;
    btn.addEventListener('click', () => {
      if (btn.dataset.act === 'inc') changeQty(bc, 1);
      else if (btn.dataset.act === 'dec') changeQty(bc, -1);
      else if (btn.dataset.act === 'sign') toggleSign(bc);
      else removeFromCart(bc);
    });
  });
  bindQtyInputs(listEl, 'bc');
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
    persistCart();
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
  migrateLocalProducts();   // 已通过密码门禁，顺手把旧的本地自定义商品迁移到 VM
}
function closeAddProduct() { $('#addOverlay').hidden = true; }

// 一次性迁移：把历史上只存在浏览器 localStorage 的自定义商品上传到 VM 后清掉
async function migrateLocalProducts() {
  const key = 'itemrecord.customProducts';
  let list;
  try { list = JSON.parse(localStorage.getItem(key) || '[]'); } catch { list = []; }
  if (!Array.isArray(list) || !list.length) return;
  try {
    await store.addProducts(
      list.map((p) => ({ barcode: p.barcode, name: p.name, createdBy: p.createdBy })),
      adminPw,
    );
    localStorage.removeItem(key);
    state.products = await loadProducts();
    renderCategoryBar();
    renderGrid();
  } catch { /* 无密码/离线则保留，下次再迁移 */ }
}

async function confirmAddProduct() {
  const name = $('#addName').value.trim();
  if (!name) { toast('请填写商品名称'); $('#addName').focus(); return; }
  const barcode = $('#addBarcode').value.trim();   // 空则后端自动生成
  const createdBy = $('#addPerson').value.trim();

  const btn = $('#addConfirm');
  btn.disabled = true;
  try {
    const res = await store.addProducts([{ barcode, name, createdBy: createdBy || null }], adminPw);
    if (!res.added) { toast('该商品已存在'); return; }
    if (createdBy) localStorage.setItem('itemrecord.lastPerson', createdBy);
    state.products = await loadProducts(); // 重新拉取 + 拼音富化，新品立即进入所有视图、分类与拼音搜索
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

/* ---------------- 表格批量导入 ---------------- */
let importRows = [];        // 导入确认弹窗的工作列表 [{name, barcode}]
let importParsedCount = 0;  // AI 本次解析出的原始件数（编辑后仍显示，便于对照）

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

// 'loading' | 'fail' | 'list'
function setImportMode(mode) {
  $('#importStatus').hidden = mode === 'list';
  $('#importCount').hidden = mode !== 'list';
  $('#importList').hidden = mode !== 'list';
  $('#importAddRow').style.display = mode === 'list' ? '' : 'none';
  $('#importConfirm').style.display = mode === 'list' ? '' : 'none';
}
function openImportOverlay(mode) {
  if ($('#importOverlay').hidden) { $('#importOverlay').hidden = false; lockScroll(); }
  setImportMode(mode);
}
function closeImport() {
  if (!$('#importOverlay').hidden) unlockScroll();
  $('#importOverlay').hidden = true;
  importRows = [];
}

async function onImportFileChosen(file) {
  if (!file) return;
  if (!/\.(xlsx|csv)$/i.test(file.name)) { toast('请选择 .xlsx 或 .csv 文件'); return; }
  closeAddProduct();
  openImportOverlay('loading');
  $('#importStatus').textContent = 'AI 解析中…请稍候';
  try {
    const dataB64 = await fileToBase64(file);
    const res = await store.parseProductsFile(file.name, dataB64, adminPw);
    if (!res.ok || !Array.isArray(res.items) || !res.items.length) {
      $('#importStatus').textContent = '自动添加失败，请联系张信';
      setImportMode('fail');
      return;
    }
    importRows = res.items.map((it) => ({ name: it.name || '', barcode: it.barcode || '' }));
    importParsedCount = importRows.length;
    setImportMode('list');
    renderImportList();
    toast(`AI 解析出 ${importParsedCount} 件商品`);
  } catch (e) {
    $('#importStatus').textContent = '自动添加失败，请联系张信';
    setImportMode('fail');
  }
}

function renderImportList() {
  const el = $('#importList');
  const n = importRows.length;
  $('#importCount').textContent = (n === importParsedCount)
    ? `AI 解析出 ${importParsedCount} 件商品`
    : `AI 解析出 ${importParsedCount} 件 · 当前 ${n} 件`;
  $('#importConfirm').textContent = `确认导入(${n})`;
  $('#importConfirm').disabled = n === 0;
  el.innerHTML = importRows.map((it, i) => `
    <div class="imp-row">
      <input class="imp-name" data-i="${i}" value="${esc(it.name)}" placeholder="商品名称" />
      <input class="imp-bc" data-i="${i}" value="${esc(it.barcode)}" placeholder="条码（可空）" />
      <button class="imp-del" data-i="${i}" aria-label="删除此行">🗑</button>
    </div>`).join('');
  el.querySelectorAll('.imp-name').forEach((inp) =>
    inp.addEventListener('change', () => { importRows[+inp.dataset.i].name = inp.value; }));
  el.querySelectorAll('.imp-bc').forEach((inp) =>
    inp.addEventListener('change', () => { importRows[+inp.dataset.i].barcode = inp.value; }));
  el.querySelectorAll('.imp-del').forEach((btn) =>
    btn.addEventListener('click', () => { importRows.splice(+btn.dataset.i, 1); renderImportList(); }));
}

function addImportRow() {
  importRows.unshift({ name: '', barcode: '' });
  renderImportList();
  const first = $('#importList').querySelector('.imp-name');
  if (first) first.focus();
}

async function confirmImport() {
  const items = importRows
    .map((it) => ({ name: (it.name || '').trim(), barcode: (it.barcode || '').trim() }))
    .filter((it) => it.name);
  if (!items.length) { toast('没有可导入的商品'); return; }
  // 客户端按 barcode+name 去重（空条码留给后端生成）
  const seen = new Set();
  const dedup = [];
  for (const it of items) {
    const key = it.barcode + ' ' + it.name;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(it);
  }
  const btn = $('#importConfirm');
  btn.disabled = true;
  try {
    const res = await store.addProducts(dedup, adminPw);
    state.products = await loadProducts();
    renderCategoryBar();
    renderGrid();
    closeImport();
    toast(`已导入 ${res.added} 件${res.skipped ? `（跳过 ${res.skipped} 件重复）` : ''}`);
  } catch (e) {
    toast(`导入失败：${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- AI 更新分类 ---------------- */
async function openAiCategories() {
  $('#aiCatInstruction').value = '';
  $('#aiCatResult').hidden = true;
  $('#aiCatOverlay').hidden = false;
  $('#aiCatInstruction').focus();
  // 显示当前对话历史轮数
  try {
    const h = await fetch('/api/categories/history').then((r) => r.json());
    $('#aiCatHistoryInfo').textContent = h.turns > 0
      ? `已有 ${h.turns} 轮对话历史，AI 会在此基础上继续调整`
      : '新对话，AI 将从当前分类规则开始';
  } catch {
    $('#aiCatHistoryInfo').textContent = '';
  }
}
function closeAiCategories() { $('#aiCatOverlay').hidden = true; }

async function clearAiHistory() {
  try {
    await fetch('/api/categories/history', { method: 'DELETE' });
    $('#aiCatHistoryInfo').textContent = '对话历史已清除，下次从零开始';
    toast('历史已清除');
  } catch {
    toast('清除失败');
  }
}

async function confirmAiCategories() {
  const instruction = $('#aiCatInstruction').value.trim();
  if (!instruction) { toast('请描述你想怎么修改分类'); $('#aiCatInstruction').focus(); return; }

  const btn = $('#aiCatConfirm');
  btn.disabled = true;
  btn.textContent = 'AI 运行中…';
  $('#aiCatResult').hidden = true;

  let applied = false;
  try {
    const res = await store.updateCategories(instruction, adminPw);
    if (res.ok) {
      applied = true;
      state.categories = await store.fetchCategories();
      renderCategoryBar();
      renderGrid();

      const stats = res.stats || {};
      const perCat = Object.entries(stats.per_category || {})
        .map(([k, v]) => `${k}：${v} 件`).join('　');
      $('#aiCatResult').innerHTML =
        `<div class="ai-result-ok">✓ 分类已更新（第 ${res.history_turns} 轮对话）</div>` +
        `<div class="ai-result-stats">${perCat}　未分类：${stats.uncategorized ?? '?'} 件</div>`;
      if (stats.uncategorized_names && stats.uncategorized_names.length) {
        const names = stats.uncategorized_names.slice(0, 10).join('、');
        $('#aiCatResult').innerHTML +=
          `<div class="ai-result-uncat">未分类：${names}${stats.uncategorized_names.length > 10 ? '…' : ''}</div>`;
      }
      $('#aiCatHistoryInfo').textContent = `分类已生效（第 ${res.history_turns} 轮）。如需继续调整，输入新指令；否则直接关闭`;
      $('#aiCatInstruction').value = '';   // 已应用，清空以免再次点击重复执行同一指令
    } else {
      $('#aiCatResult').innerHTML = `<div class="ai-result-err">✗ ${res.message || '更新失败'}</div>`;
    }
    $('#aiCatResult').hidden = false;
  } catch (e) {
    $('#aiCatResult').innerHTML = `<div class="ai-result-err">✗ ${e.message}</div>`;
    $('#aiCatResult').hidden = false;
  } finally {
    if (applied) {
      // 已生效，按钮变为禁用的「已应用」，待用户输入新指令再恢复（见 #aiCatInstruction input 监听）
      btn.disabled = true;
      btn.textContent = '已应用 ✓';
    } else {
      btn.disabled = false;
      btn.textContent = '开始更新';
    }
  }
}

/* ---------------- 记录查看 ---------------- */
async function openRecords() {
  const wasHidden = $('#recordsOverlay').hidden;
  $('#recordsOverlay').hidden = false;
  if (wasHidden) lockScroll();   // openRecords 也用于删除/清空后刷新，避免重复加锁
  setRecordsView('current');
  await renderCurrentRecords();
}
function closeRecords() {
  if (!$('#recordsOverlay').hidden) unlockScroll();
  $('#recordsOverlay').hidden = true;
}

// 切换「当前记录 / 完整溯源」两个视图（导出/清空只对当前记录有意义）
function setRecordsView(view) {
  state.recordsView = view;
  const current = view === 'current';
  $('#tabCurrent').classList.toggle('active', current);
  $('#tabAudit').classList.toggle('active', !current);
  $('#recordsList').hidden = !current;
  $('#auditTimeline').hidden = current;
  $('#recordsEmpty').hidden = true;
  $('#recordsExport').style.display = current ? '' : 'none';
  $('#recordsClear').style.display = current ? '' : 'none';
}

async function renderCurrentRecords() {
  const listEl = $('#recordsList');
  const emptyEl = $('#recordsEmpty');
  let records = [];
  try { records = await store.fetchRecords(); } catch { /* 离线 → 空 */ }
  records.sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
  if (!records.length) {
    listEl.innerHTML = '';
    emptyEl.textContent = '还没有任何记录。';
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;
  listEl.innerHTML = records.map((r) => `
    <div class="record">
      <div class="record-head">
        <span class="record-person">${esc(r.person)}</span>
        <span class="record-head-right">
          <span class="record-time">${esc(fmtTime(r.submittedAt))}</span>
          <button class="record-del" data-id="${esc(r.id || '')}" aria-label="删除此条记录">🗑</button>
        </span>
      </div>
      <div class="record-items">
        ${r.items.map((it) => `<span class="tag">${esc(it.name)} ×${it.qty}</span>`).join('')}
      </div>
    </div>`).join('');
  // 单条删除：先验密码，再删（密码即确认，不再二次 confirm）
  listEl.querySelectorAll('.record-del').forEach((btn) => {
    btn.addEventListener('click', () =>
      requirePassword('删除此条记录需要密码', (pw) => deleteOneRecord(btn.dataset.id, pw)));
  });
}

async function renderAuditView() {
  const el = $('#auditTimeline');
  el.innerHTML = '<div class="records-empty">加载中…</div>';
  let data;
  try { data = await store.fetchAudit(); }
  catch { el.innerHTML = '<div class="records-empty">溯源加载失败，请检查网络。</div>'; return; }
  renderAuditTimeline(data);
}

// 竖向时间线：新增=绿点、删除=红点，按时间倒序；被删的提交划掉并标「已删除」。
function renderAuditTimeline(data) {
  const records = (data && data.records) || [];
  const deletions = (data && data.deletions) || [];
  const deletedIds = new Set(deletions.map((d) => d.recordId));
  const recById = new Map(records.map((r) => [r.id, r]));

  const events = [];
  for (const r of records) {
    events.push({ t: r.submittedAt, kind: 'create', record: r, deleted: deletedIds.has(r.id) });
  }
  for (const d of deletions) {
    events.push({ t: d.deletedAt, kind: 'delete', mode: d.mode, record: recById.get(d.recordId) });
  }
  events.sort((a, b) => String(b.t || '').localeCompare(String(a.t || '')));

  const el = $('#auditTimeline');
  if (!events.length) {
    el.innerHTML = '<div class="records-empty">还没有任何操作。</div>';
    return;
  }
  const tags = (items) => (items || []).map((it) => `<span class="tag">${esc(it.name)} ×${it.qty}</span>`).join('');
  el.innerHTML = events.map((ev) => {
    if (ev.kind === 'create') {
      return `
        <div class="tl-event tl-create${ev.deleted ? ' tl-struck' : ''}">
          <span class="tl-dot"></span>
          <div class="tl-card">
            <div class="tl-head">
              <span class="tl-who">${esc(ev.record.person)} 提交</span>
              ${ev.deleted ? '<span class="tl-badge tl-badge-del">已删除</span>' : ''}
              <span class="tl-time">${esc(fmtTime(ev.t))}</span>
            </div>
            <div class="tl-items">${tags(ev.record.items)}</div>
          </div>
        </div>`;
    }
    const r = ev.record;
    const ref = r
      ? `${esc(r.person)}：${(r.items || []).map((it) => esc(it.name) + '×' + it.qty).join('、')}`
      : '（原记录已不可考）';
    return `
      <div class="tl-event tl-delete">
        <span class="tl-dot"></span>
        <div class="tl-card">
          <div class="tl-head">
            <span class="tl-who">删除${ev.mode === 'clear' ? '（清空）' : ''}</span>
            <span class="tl-time">${esc(fmtTime(ev.t))}</span>
          </div>
          <div class="tl-ref">↳ 原：${ref}</div>
        </div>
      </div>`;
  }).join('');
}

async function deleteOneRecord(id, pw) {
  if (!id) { toast('该记录缺少 id，无法删除'); return; }
  try {
    const res = await store.deleteRecord(id, pw);
    toast(res.deleted ? '已删除该条记录' : '记录不存在');
    await openRecords();   // 重新拉取刷新列表（软删后此条不再出现在当前视图）
  } catch (e) {
    toast(`删除失败：${e.message}`);
  }
}

// 导出存货记录为 CSV（含 UTF-8 BOM，Excel / WPS 直接打开；每个商品一行）
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
async function exportRecords() {
  const btn = $('#recordsExport');
  btn.disabled = true;
  try {
    const records = await store.fetchRecords();
    if (!records.length) { toast('没有记录可导出'); return; }
    records.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
    const rows = [['时间', '提交人', '条码', '名称', '数量']];
    for (const r of records) {
      for (const it of r.items) {
        rows.push([fmtTime(r.submittedAt), r.person, it.barcode, it.name, it.qty]);
      }
    }
    const csv = '﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const a = document.createElement('a');
    a.href = url;
    a.download = `存货记录_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    toast('导出失败，请重试');
  } finally {
    btn.disabled = false;
  }
}

async function clearRecords(pw) {
  const btn = $('#recordsClear');
  btn.disabled = true;
  try {
    const res = await store.clearRecords(pw);
    toast(`已清空 ${res.cleared ?? 0} 条记录（仍可在「完整溯源」查看）`);
    await openRecords();   // 重新拉取并刷新当前视图（清空后应为空）
  } catch (e) {
    toast(`清空失败：${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- 轻提示 ---------------- */
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 1800);
}

/* ---------------- 密码防护（自动分类 / 清空记录） ---------------- */
// 密码门禁：真正的密码只在 VM 后端，客户端代码不含明文（看源码也偷不到）。
// 输入后发后端校验；受保护的写操作本身也在后端再校验一次（直接调接口也得有正确密码）。
let pwPendingAction = null;
let adminPw = '';   // 最近一次校验通过的密码，供本次受保护操作复用（仅内存，不落地）

function requirePassword(title, action) {
  pwPendingAction = action;
  $('#pwTitle').textContent = title || '需要密码';
  $('#pwInput').value = '';
  setPwVisible(false);        // 每次打开默认隐藏
  $('#pwError').hidden = true;
  $('#pwOverlay').hidden = false;
  $('#pwInput').focus();
}
function setPwVisible(show) {
  $('#pwInput').type = show ? 'text' : 'password';
  $('#pwToggle').textContent = show ? '🙈' : '👁';
}
function togglePwVisible() {
  setPwVisible($('#pwInput').type === 'password');
  $('#pwInput').focus();
}
function closePassword() {
  $('#pwOverlay').hidden = true;
  pwPendingAction = null;
}
async function confirmPassword() {
  const pw = $('#pwInput').value;
  const btn = $('#pwConfirm');
  btn.disabled = true;
  try {
    const { ok } = await store.verifyPassword(pw);
    if (ok) {
      adminPw = pw;
      const action = pwPendingAction;
      closePassword();
      if (action) action(pw);
    } else {
      $('#pwError').textContent = '密码错误，请重试';
      $('#pwError').hidden = false;
      $('#pwInput').value = '';
      $('#pwInput').focus();
    }
  } catch (e) {
    $('#pwError').textContent = '验证失败，请检查网络后重试';
    $('#pwError').hidden = false;
  } finally {
    btn.disabled = false;
  }
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
  // 彻底禁用整页缩放：iOS 会忽略 viewport 的 user-scalable=no，需 JS 拦截捏合手势
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) =>
    document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));
  // 兜底拦掉双指 touchmove（部分内核不触发 gesture 事件）
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

  bindSearch();
  $('#cartBtn').addEventListener('click', openCart);
  $('#cartClose').addEventListener('click', closeCart);
  $('#overlay').addEventListener('click', closeCart);
  $('#submitBtn').addEventListener('click', openSubmit);
  $('#submitCancel').addEventListener('click', closeSubmit);
  $('#submitConfirm').addEventListener('click', confirmSubmit);
  $('#recordsBtn').addEventListener('click', openRecords);
  $('#recordsClose').addEventListener('click', closeRecords);
  $('#tabCurrent').addEventListener('click', () => { setRecordsView('current'); renderCurrentRecords(); });
  $('#tabAudit').addEventListener('click', () => { setRecordsView('audit'); renderAuditView(); });
  $('#recordsClear').addEventListener('click', () => requirePassword('清空记录需要密码', (pw) => clearRecords(pw)));
  $('#recordsExport').addEventListener('click', exportRecords);
  $('#addProductBtn').addEventListener('click', () => requirePassword('新增商品需要密码', openAddProduct));
  $('#addCancel').addEventListener('click', closeAddProduct);
  $('#addConfirm').addEventListener('click', confirmAddProduct);
  // 表格批量导入
  $('#addImportBtn').addEventListener('click', () => $('#importFileInput').click());
  $('#importFileInput').addEventListener('change', (e) => { onImportFileChosen(e.target.files[0]); e.target.value = ''; });
  $('#importAddRow').addEventListener('click', addImportRow);
  $('#importConfirm').addEventListener('click', confirmImport);
  $('#importCancel').addEventListener('click', closeImport);
  $('#importClose').addEventListener('click', closeImport);
  $('#aiCatBtn').addEventListener('click', () => requirePassword('自动分类需要密码', openAiCategories));
  $('#aiCatCancel').addEventListener('click', closeAiCategories);
  $('#aiCatConfirm').addEventListener('click', confirmAiCategories);
  $('#aiCatClearHistory').addEventListener('click', clearAiHistory);
  $('#aiCatInstruction').addEventListener('input', () => {
    const btn = $('#aiCatConfirm');
    if ($('#aiCatInstruction').value.trim() && btn.textContent === '已应用 ✓') {
      btn.disabled = false;
      btn.textContent = '开始更新';
    }
  });
  $('#addName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#addBarcode').focus(); });

  // 数量编辑弹窗
  $('#qtyEditDec').addEventListener('click', () => stepQtyEditor(-1));
  $('#qtyEditInc').addEventListener('click', () => stepQtyEditor(1));
  $('#qtyEditSign').addEventListener('click', signQtyEditor);
  $('#qtyEditDone').addEventListener('click', commitQtyEditor);
  $('#qtyEditInput').addEventListener('input', () => inputQtyEditor($('#qtyEditInput').value));
  $('#qtyEditInput').addEventListener('focus', () => $('#qtyEditInput').select());
  $('#qtyEditInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') commitQtyEditor(); });
  $('#qtyOverlay').addEventListener('click', (e) => { if (e.target === $('#qtyOverlay')) commitQtyEditor(); });

  // 密码弹窗
  $('#pwConfirm').addEventListener('click', confirmPassword);
  $('#pwCancel').addEventListener('click', closePassword);
  $('#pwToggle').addEventListener('click', togglePwVisible);
  $('#pwInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmPassword(); });
  $('#pwOverlay').addEventListener('click', (e) => { if (e.target === $('#pwOverlay')) closePassword(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { commitQtyEditor(); closePassword(); closeCart(); closeSubmit(); closeRecords(); closeAddProduct(); closeAiCategories(); closeImport(); }
  });
  $('#personInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmSubmit(); });

  restoreCart();               // 恢复上次未提交的选购（防止刷新/手机回收标签页丢失）
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
