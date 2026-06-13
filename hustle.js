/* ============================================================
   Hustle — command center logic
   ============================================================ */
// Global error handler — log everything so we can debug, but don't let
// any single error block the rest of the page from rendering.
window.addEventListener('error', (e) => {
  console.error('[hustle global error]', e.message, e.filename, e.lineno, e.error);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[hustle unhandled rejection]', e.reason);
});

(function () {
  'use strict';

  // ─── Storage helpers (keys prefixed hustle_ so supabase-sync picks them up) ─────
  const KEYS = {
    biz:     'hustle_businesses',
    events:  'hustle_events',
    watch:   'hustle_watchlist',
    newsKey: 'hustle_news_api_key',
    newsCache: 'hustle_news_cache',
    activeTab: 'hustle_active_tab',
  };
  function get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  }
  function set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function fmtCHF(n) {
    const v = Number(n) || 0;
    return 'CHF ' + v.toLocaleString('en-US', { maximumFractionDigits: v % 1 === 0 ? 0 : 2 });
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    const isoSafe = (/^\d{4}-\d{2}-\d{2}$/.test(iso)) ? iso + 'T00:00' : iso;
    const d = new Date(isoSafe);
    if (isNaN(d)) return iso;
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return months[d.getMonth()] + ' ' + d.getDate();
  }
  function daysUntil(iso) {
    const isoSafe = (/^\d{4}-\d{2}-\d{2}$/.test(iso)) ? iso + 'T00:00' : iso;
    const d = new Date(isoSafe); if (isNaN(d)) return null;
    const now = new Date();
    return Math.round((d - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
  }
  function todayISO() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // ============================================================
  // CLOCK + TICKER STRIP
  // ============================================================
  const brandClock = document.getElementById('brandClock');
  const hudUtc = document.getElementById('hudUtc');
  function updateClocks() {
    const d = new Date();
    const hhmmss = d.toLocaleTimeString('en-US', { hour12: false });
    if (brandClock) brandClock.textContent = hhmmss + ' · LIVE';
    if (hudUtc) hudUtc.textContent = 'UTC ' + d.toUTCString().slice(17, 25);
  }
  updateClocks();
  setInterval(updateClocks, 1000);

  // Fake-but-realistic market ticker (refreshes pseudo-quotes every 4s for
  // visual life; real data would require a paid feed key).
  const TICKER_SYMS = [
    { sym: 'S&P 500',  base: 5837.20 },
    { sym: 'NASDAQ',   base: 18504.30 },
    { sym: 'DOW',      base: 42114.40 },
    { sym: 'BTC',      base: 96420.00 },
    { sym: 'ETH',      base: 3320.00 },
    { sym: 'GOLD',     base: 2654.80 },
    { sym: 'OIL WTI',  base: 70.45 },
    { sym: 'EUR/USD',  base: 1.0427 },
    { sym: 'DXY',      base: 106.91 },
    { sym: 'NVDA',     base: 140.55 },
    { sym: 'AAPL',     base: 232.30 },
    { sym: 'TSLA',     base: 426.20 },
  ];
  const tickerScroll = document.getElementById('tickerScroll');
  function renderTicker() {
    const items = TICKER_SYMS.map(t => {
      const drift = (Math.random() - 0.5) * (t.base * 0.012);
      const val = t.base + drift;
      const pct = (drift / t.base) * 100;
      const dir = pct >= 0 ? 'up' : 'down';
      const sign = pct >= 0 ? '▲' : '▼';
      const fmt = val >= 1000 ? val.toLocaleString('en-US', { maximumFractionDigits: 2 })
                              : val.toFixed(val < 10 ? 4 : 2);
      return `<span class="ticker-item">
        <span class="ticker-sym">${t.sym}</span>
        <span class="ticker-val">${fmt}</span>
        <span class="ticker-delta ${dir}">${sign} ${Math.abs(pct).toFixed(2)}%</span>
      </span>`;
    }).join('');
    // Duplicate the row so the marquee loops seamlessly.
    if (tickerScroll) tickerScroll.innerHTML = items + items;
  }
  renderTicker();
  let tickerTimer = setInterval(renderTicker, 4000);
  // Pause expensive timers when the page is hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (tickerTimer) { clearInterval(tickerTimer); tickerTimer = null; }
      if (globeInstance && globeInstance.controls) globeInstance.controls().autoRotate = false;
    } else {
      if (!tickerTimer) tickerTimer = setInterval(renderTicker, 4000);
      if (globeInstance && globeInstance.controls) globeInstance.controls().autoRotate = true;
    }
  });

  // ============================================================
  // TAB SWITCHING
  // ============================================================
  const tabBtns = document.querySelectorAll('.tab');
  const sections = document.querySelectorAll('.section');
  function setTab(name) {
    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    sections.forEach(s => s.classList.toggle('active', s.id === 'sec-' + name));
    set(KEYS.activeTab, name);
    if (name === 'globe') {
      initGlobeIfNeeded();
      // If the globe was already initialised, force it to re-sync its size
      // and re-paint its points — when the section was display:none, the
      // canvas can come back with stale dimensions / empty render.
      if (globeInstance) {
        setTimeout(() => {
          const stage = document.getElementById('globeCanvas');
          if (stage && globeInstance.width) {
            globeInstance.width(stage.clientWidth).height(stage.clientHeight);
          }
          if (globePoints && globePoints.length) {
            globeInstance.pointsData(globePoints.slice());
          }
        }, 50);
      }
    }
    if (name === 'trading') { ensureTradingLoaded(); }
    if (name === 'calendar') { renderCalendar(); }
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  tabBtns.forEach(b => b.addEventListener('click', () => { try { setTab(b.dataset.tab); } catch (e) { console.error('setTab failed:', e); } }));
  const savedTab = get(KEYS.activeTab, 'overview');
  try {
    setTab(['overview','calendar','globe','trading','kronos'].includes(savedTab) ? savedTab : 'overview');
  } catch (e) {
    console.error('Initial setTab failed:', e);
    // Fallback: force overview tab if any error
    try {
      tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === 'overview'));
      sections.forEach(s => s.classList.toggle('active', s.id === 'sec-overview'));
    } catch (e2) {}
  }

  // ============================================================
  // BUSINESSES — CRUD + render
  // ============================================================
  const ACCENT_PALETTE = [
    { glyph: 'rgba(125,211,252,0.18)', text: '#7DD3FC', accent: 'linear-gradient(90deg, #7DD3FC, #6EE7B7)' },
    { glyph: 'rgba(110,231,183,0.18)', text: '#6EE7B7', accent: 'linear-gradient(90deg, #6EE7B7, #5EEAD4)' },
    { glyph: 'rgba(183,148,244,0.20)', text: '#B794F4', accent: 'linear-gradient(90deg, #B794F4, #7DD3FC)' },
    { glyph: 'rgba(242,192,99,0.18)',  text: '#F2C063', accent: 'linear-gradient(90deg, #F2C063, #B794F4)' },
    { glyph: 'rgba(94,234,212,0.18)',  text: '#5EEAD4', accent: 'linear-gradient(90deg, #5EEAD4, #7DD3FC)' },
    { glyph: 'rgba(255,138,138,0.18)', text: '#FF8A8A', accent: 'linear-gradient(90deg, #FF8A8A, #F2C063)' },
  ];

  function loadBiz() { return get(KEYS.biz, []); }
  function saveBiz(arr) { set(KEYS.biz, arr); }

  function defaultBusiness() {
    return {
      id: uid(),
      name: 'New venture',
      sector: '',
      phase: 'idea',
      revenue: 0,
      target: 0,
      priorities: '',
      notes: '',
      milestones: [],
      createdAt: Date.now(),
    };
  }
  function bizGlyph(b) {
    const name = (b.name || 'X').trim();
    const parts = name.split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }
  function bizPaletteFor(b) {
    // Deterministic palette based on id so colors don't shuffle between renders.
    const hash = (b.id || b.name || 'x').split('').reduce((s, c) => s + c.charCodeAt(0), 0);
    return ACCENT_PALETTE[hash % ACCENT_PALETTE.length];
  }
  function nextMilestone(b) {
    const pend = (b.milestones || []).filter(m => !m.done && m.date).sort((a, b) => a.date.localeCompare(b.date));
    return pend[0] || null;
  }
  function bizProgress(b) {
    const ms = b.milestones || [];
    if (!ms.length) {
      // Use revenue/target as fallback progress signal.
      if (b.target > 0) return Math.min(100, (b.revenue / b.target) * 100);
      return 0;
    }
    const done = ms.filter(m => m.done).length;
    return (done / ms.length) * 100;
  }

  // ─── KPI hero ─────────────────────────────────────────────
  function sparklinePath(values, w, h) {
    if (!values.length) return '';
    const min = Math.min.apply(null, values);
    const max = Math.max.apply(null, values);
    const range = (max - min) || 1;
    return values.map((v, i) => {
      const x = (i / (values.length - 1 || 1)) * w;
      const y = h - ((v - min) / range) * h;
      return (i ? 'L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
  }
  function renderKPIs() {
    const hero = document.getElementById('bizHero');
    if (!hero) return;
    const businesses = loadBiz();
    const totalRev = businesses.reduce((s, b) => s + (Number(b.revenue) || 0), 0);
    const totalTarget = businesses.reduce((s, b) => s + (Number(b.target) || 0), 0);
    const livePct = totalTarget > 0 ? (totalRev / totalTarget) * 100 : 0;
    const live = businesses.filter(b => b.phase === 'live' || b.phase === 'scaling').length;
    const events = loadEvents();
    const upcoming = events.filter(e => {
      const du = daysUntil(e.date);
      return du != null && du >= 0 && du <= 14;
    }).length;

    // Deterministic sparkline based on businesses count + revenue.
    const seed = businesses.length * 13 + Math.floor(totalRev);
    const spark = [];
    for (let i = 0; i < 24; i++) {
      spark.push(50 + Math.sin((i + seed) * 0.4) * 12 + Math.cos((i + seed) * 0.17) * 6 + (i * 0.6));
    }
    const sparkPath = sparklinePath(spark, 140, 28);

    const kpis = [
      {
        label: 'Active ventures',
        value: businesses.length,
        sub: live + ' live · ' + (businesses.length - live) + ' in build',
        glow: 'radial-gradient(circle at 0% 0%, rgba(125,211,252,0.16), transparent 60%)',
      },
      {
        label: 'MTD revenue',
        value: fmtCHF(totalRev),
        sub: totalTarget > 0 ? livePct.toFixed(1) + '% of target' : 'Set targets to track',
        glow: 'radial-gradient(circle at 100% 0%, rgba(110,231,183,0.16), transparent 60%)',
      },
      {
        label: 'Upcoming · 14d',
        value: upcoming,
        sub: upcoming === 1 ? 'event on the books' : 'events on the books',
        glow: 'radial-gradient(circle at 0% 100%, rgba(242,192,99,0.14), transparent 60%)',
      },
      {
        label: 'Momentum',
        value: businesses.length ? (live > 0 ? 'BUILDING' : 'IDEATION') : 'STANDBY',
        sub: 'Pulse · ' + (businesses.length ? Math.min(99, 30 + live * 18 + Math.floor(totalRev / 5000)) : 0) + '%',
        glow: 'radial-gradient(circle at 100% 100%, rgba(183,148,244,0.16), transparent 60%)',
        spark: sparkPath,
      },
    ];

    hero.innerHTML = kpis.map(k => `
      <div class="biz-kpi" style="--kpi-glow:${k.glow}">
        <div class="biz-kpi-label">${k.label}</div>
        <div class="biz-kpi-value">${escapeHtml(String(k.value))}</div>
        <div class="biz-kpi-sub">${escapeHtml(k.sub)}</div>
        ${k.spark ? `<div class="biz-kpi-spark"><svg viewBox="0 0 140 28" preserveAspectRatio="none">
          <path d="${k.spark}" fill="none" stroke="url(#sparkGrad)" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
          <defs><linearGradient id="sparkGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="#7DD3FC"/><stop offset="100%" stop-color="#6EE7B7"/>
          </linearGradient></defs>
        </svg></div>` : ''}
      </div>
    `).join('');
  }

  // ─── Business cards ─────────────────────────────────────────
  function renderBusinesses() {
    const grid = document.getElementById('bizGrid');
    if (!grid) return;
    const businesses = loadBiz();
    if (!businesses.length) {
      grid.innerHTML = `<div class="biz-empty">
        <div class="biz-empty-icon">⚡</div>
        <div class="biz-empty-title">No ventures yet</div>
        <div class="biz-empty-sub">Spin up your first business — track milestones, revenue, and tie it into the master calendar. Tap NEW BUSINESS to begin.</div>
      </div>`;
      return;
    }
    grid.innerHTML = businesses.map(b => {
      const palette = bizPaletteFor(b);
      const next = nextMilestone(b);
      const prog = bizProgress(b);
      const rev = fmtCHF(b.revenue || 0);
      const target = (b.target || 0) > 0 ? ' / ' + fmtCHF(b.target) : '';
      const du = next ? daysUntil(next.date) : null;
      const dueLabel = !next ? 'No milestone scheduled'
        : (du === 0 ? next.text + ' · TODAY'
          : du > 0 ? next.text + ' · in ' + du + 'd'
          : next.text + ' · ' + Math.abs(du) + 'd ago');
      return `<div class="biz-card" data-id="${b.id}"
        style="--biz-glyph-bg:${palette.glyph};--biz-glyph-color:${palette.text};--biz-accent:${palette.accent}">
        <div class="biz-card-accent"></div>
        <div class="biz-card-head">
          <div class="biz-glyph">${escapeHtml(bizGlyph(b))}</div>
          <div class="biz-card-titles">
            <div class="biz-card-name">${escapeHtml(b.name || '—')}</div>
            <div class="biz-card-sector">${escapeHtml(b.sector || 'Sector unset')}</div>
          </div>
          <span class="biz-phase" data-phase="${b.phase || 'idea'}">${b.phase || 'idea'}</span>
        </div>
        <div class="biz-card-meta-row">
          <div class="biz-meta">
            <span class="biz-meta-label">Revenue · MTD</span>
            <span class="biz-meta-val ${(b.revenue||0) > 0 ? 'up' : ''}">${rev}${target}</span>
          </div>
          <div class="biz-meta">
            <span class="biz-meta-label">Milestones</span>
            <span class="biz-meta-val">${(b.milestones||[]).filter(m=>m.done).length} / ${(b.milestones||[]).length}</span>
          </div>
        </div>
        <div class="biz-progress-row">
          <span>Progress</span>
          <span>${Math.round(prog)}%</span>
        </div>
        <div class="biz-progress-bar"><div class="biz-progress-fill" style="width:${prog}%"></div></div>
        <div class="biz-card-foot">
          <span class="biz-next-milestone">${escapeHtml(dueLabel)}</span>
          <span>Open →</span>
        </div>
      </div>`;
    }).join('');

    grid.querySelectorAll('.biz-card').forEach(card => {
      card.addEventListener('click', () => openDrawer(card.dataset.id));
    });
  }

  // ─── Add new business ─────────────────────────────────────
  const bizAddBtn = document.getElementById('bizAddBtn');
  if (bizAddBtn) bizAddBtn.addEventListener('click', () => {
    const arr = loadBiz();
    const b = defaultBusiness();
    arr.push(b);
    saveBiz(arr);
    renderBusinesses();
    renderKPIs();
    openDrawer(b.id);
  });

  // ============================================================
  // BUSINESS DRAWER
  // ============================================================
  const drawerOverlay = document.getElementById('bizDrawerOverlay');
  const drawerEl = document.getElementById('bizDrawer');
  let drawerBizId = null;

  function openDrawer(id) {
    const b = loadBiz().find(x => x.id === id);
    if (!b) return;
    drawerBizId = id;
    const palette = bizPaletteFor(b);
    const glyph = document.getElementById('drawerGlyph');
    glyph.textContent = bizGlyph(b);
    glyph.style.background = palette.glyph;
    glyph.style.color = palette.text;
    document.getElementById('drawerTitle').textContent = b.name || '—';
    document.getElementById('drawerSub').innerHTML =
      `<span>${escapeHtml(b.sector || 'No sector')}</span><span>·</span><span>${escapeHtml((b.phase || 'idea').toUpperCase())}</span><span>·</span><span>${fmtCHF(b.revenue || 0)}/mo</span>`;
    document.getElementById('drBizName').value = b.name || '';
    document.getElementById('drBizPhase').value = b.phase || 'idea';
    document.getElementById('drBizSector').value = b.sector || '';
    document.getElementById('drBizRev').value = b.revenue || '';
    document.getElementById('drBizTarget').value = b.target || '';
    document.getElementById('drBizPriorities').value = b.priorities || '';
    document.getElementById('drBizNotes').value = b.notes || '';
    renderDrawerMiles();
    drawerOverlay.classList.add('open');
    // Reset tab
    drawerOverlay.querySelectorAll('.drawer-tab').forEach(t => t.classList.toggle('active', t.dataset.dtab === 'info'));
    drawerOverlay.querySelectorAll('.drawer-pane').forEach(p => p.classList.toggle('active', p.dataset.dpane === 'info'));
  }
  function closeDrawer() {
    drawerOverlay.classList.remove('open');
    drawerBizId = null;
  }
  const drawerCloseBtn = document.getElementById('drawerCloseBtn');
  if (drawerCloseBtn) drawerCloseBtn.addEventListener('click', closeDrawer);
  if (drawerOverlay) drawerOverlay.addEventListener('click', e => {
    if (e.target === drawerOverlay) closeDrawer();
  });
  drawerOverlay.querySelectorAll('.drawer-tab').forEach(t => {
    t.addEventListener('click', () => {
      drawerOverlay.querySelectorAll('.drawer-tab').forEach(b => b.classList.toggle('active', b === t));
      drawerOverlay.querySelectorAll('.drawer-pane').forEach(p => p.classList.toggle('active', p.dataset.dpane === t.dataset.dtab));
    });
  });

  function renderDrawerMiles() {
    const b = loadBiz().find(x => x.id === drawerBizId);
    if (!b) return;
    const list = document.getElementById('drMilesList');
    const ms = b.milestones || [];
    if (!ms.length) {
      list.innerHTML = `<div style="font-size:12.5px;color:var(--text-tertiary);font-style:italic;padding:14px 8px;text-align:center">No milestones yet — add one below.</div>`;
    } else {
      list.innerHTML = ms.slice().sort((a,bb) => (a.date || '').localeCompare(bb.date || '')).map((m, idx) => {
        const du = m.date ? daysUntil(m.date) : null;
        const dateLabel = m.date ? (du === 0 ? 'Today' : du > 0 ? 'in ' + du + 'd' : Math.abs(du) + 'd ago') : '';
        return `<div class="miles-item ${m.done ? 'done' : ''}" data-mid="${m.id}">
          <input type="checkbox" class="miles-check" ${m.done ? 'checked' : ''} />
          <div class="miles-text">${escapeHtml(m.text)}</div>
          <div class="miles-date">${escapeHtml(dateLabel)}</div>
          <button class="miles-del" title="Delete">×</button>
        </div>`;
      }).join('');
      list.querySelectorAll('.miles-item').forEach(row => {
        const mid = row.dataset.mid;
        row.querySelector('.miles-check').addEventListener('change', () => toggleMilestone(mid));
        row.querySelector('.miles-del').addEventListener('click', () => deleteMilestone(mid));
      });
    }
  }
  function toggleMilestone(mid) {
    const arr = loadBiz();
    const b = arr.find(x => x.id === drawerBizId);
    if (!b) return;
    const m = (b.milestones || []).find(x => x.id === mid);
    if (!m) return;
    m.done = !m.done;
    m.doneAt = m.done ? Date.now() : null;
    saveBiz(arr);
    renderDrawerMiles();
    renderBusinesses();
    renderKPIs();
    renderCalendar();
  }
  function deleteMilestone(mid) {
    const arr = loadBiz();
    const b = arr.find(x => x.id === drawerBizId);
    if (!b) return;
    b.milestones = (b.milestones || []).filter(x => x.id !== mid);
    saveBiz(arr);
    renderDrawerMiles();
    renderBusinesses();
    renderCalendar();
  }
  document.getElementById('drMilesAddBtn').addEventListener('click', () => {
    const txt = document.getElementById('drMilesText').value.trim();
    const dt = document.getElementById('drMilesDate').value;
    if (!txt) return;
    const arr = loadBiz();
    const b = arr.find(x => x.id === drawerBizId);
    if (!b) return;
    b.milestones = b.milestones || [];
    b.milestones.push({ id: uid(), text: txt, date: dt || null, done: false });
    saveBiz(arr);
    document.getElementById('drMilesText').value = '';
    document.getElementById('drMilesDate').value = '';
    renderDrawerMiles();
    renderBusinesses();
    renderCalendar();
  });

  document.getElementById('drSaveBtn').addEventListener('click', () => {
    const arr = loadBiz();
    const b = arr.find(x => x.id === drawerBizId);
    if (!b) return;
    b.name = document.getElementById('drBizName').value.trim() || 'Untitled';
    b.phase = document.getElementById('drBizPhase').value;
    b.sector = document.getElementById('drBizSector').value.trim();
    b.revenue = parseFloat(document.getElementById('drBizRev').value) || 0;
    b.target = parseFloat(document.getElementById('drBizTarget').value) || 0;
    b.priorities = document.getElementById('drBizPriorities').value;
    b.notes = document.getElementById('drBizNotes').value;
    saveBiz(arr);
    renderBusinesses();
    renderKPIs();
    renderCalendar();
    closeDrawer();
  });
  document.getElementById('drDelBtn').addEventListener('click', () => {
    if (!confirm('Delete this business and all its milestones?')) return;
    const arr = loadBiz().filter(x => x.id !== drawerBizId);
    saveBiz(arr);
    renderBusinesses();
    renderKPIs();
    renderCalendar();
    closeDrawer();
  });

  // ============================================================
  // CALENDAR
  // ============================================================
  let calCursor = { y: new Date().getFullYear(), m: new Date().getMonth() };
  function loadEvents() { return get(KEYS.events, []); }
  function saveEvents(arr) { set(KEYS.events, arr); }

  // Aggregated events = manual events + every dated thing across the app:
  // hustle milestones, dashboard goals, subscription renewals, order arrivals.
  function allEvents() {
    const evs = loadEvents().map(e => ({ ...e, source: 'manual' }));

    // 1. Business milestones (from Hustle)
    loadBiz().forEach(b => {
      (b.milestones || []).forEach(m => {
        if (!m.date || m.done) return;
        evs.push({
          id: 'auto-mile-' + m.id,
          bizId: b.id,
          bizName: b.name,
          text: m.text,
          date: m.date,
          type: 'milestone',
          source: 'auto',
        });
      });
    });

    // 2. Dashboard goals (keys: goals:YYYY-MM-DD) — including today + tomorrow
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || k.indexOf('goals:') !== 0) continue;
        const date = k.slice(6);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        const arr = JSON.parse(localStorage.getItem(k) || '[]');
        arr.forEach((g, idx) => {
          if (!g || !g.text) return;
          evs.push({
            id: 'auto-goal-' + date + '-' + idx,
            text: g.text,
            date,
            type: 'goal',
            source: 'goals',
            done: !!g.done,
          });
        });
      }
    } catch (e) { /* ignore */ }

    // 3. Subscription renewals
    try {
      const subs = JSON.parse(localStorage.getItem('subs') || '[]');
      subs.forEach((s, idx) => {
        if (!s || !s.renewal) return;
        evs.push({
          id: 'auto-sub-' + idx,
          text: '↻ ' + (s.name || 'Subscription') + ' renews',
          date: s.renewal,
          type: 'financial',
          source: 'subs',
        });
      });
    } catch (e) { /* ignore */ }

    // 4. Incoming orders (arrival dates)
    try {
      const orders = JSON.parse(localStorage.getItem('orders') || '[]');
      orders.forEach((o, idx) => {
        if (!o || !o.arrival) return;
        evs.push({
          id: 'auto-order-' + idx,
          text: '📦 ' + (o.name || 'Order') + ' arrives',
          date: o.arrival,
          type: 'financial',
          source: 'orders',
        });
      });
    } catch (e) { /* ignore */ }

    return evs;
  }
  function renderCalendar() {
    const grid = document.getElementById('calGrid');
    const label = document.getElementById('calMonthLabel');
    if (!grid || !label) return;
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    label.textContent = monthNames[calCursor.m] + ' ' + calCursor.y;

    const dows = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    let html = dows.map(d => `<div class="cal-dow">${d}</div>`).join('');

    const first = new Date(calCursor.y, calCursor.m, 1);
    const firstDow = first.getDay();
    const daysInMonth = new Date(calCursor.y, calCursor.m + 1, 0).getDate();
    const prevDays = firstDow;
    const totalCells = Math.ceil((prevDays + daysInMonth) / 7) * 7;

    const todayStr = todayISO();
    const evs = allEvents();
    const evByDate = {};
    evs.forEach(e => { (evByDate[e.date] = evByDate[e.date] || []).push(e); });

    for (let i = 0; i < totalCells; i++) {
      const offset = i - prevDays;
      const dt = new Date(calCursor.y, calCursor.m, offset + 1);
      const muted = offset < 0 || offset >= daysInMonth;
      const iso = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
      const isToday = iso === todayStr;
      const dayEvs = evByDate[iso] || [];
      const hasEv = dayEvs.length > 0;
      const cls = ['cal-day', muted ? 'muted' : '', isToday ? 'today' : '', hasEv ? 'has-events' : ''].filter(Boolean).join(' ');
      const max = 3;
      const pills = dayEvs.slice(0, max).map(e =>
        `<span class="cal-event-pill" data-type="${e.type}" data-eid="${e.id}" draggable="true" title="${escapeHtml((e.bizName ? e.bizName + ' · ' : '') + e.text)}">${escapeHtml(e.text)}</span>`
      ).join('');
      const more = dayEvs.length > max ? `<span class="cal-day-more">+${dayEvs.length - max} more</span>` : '';
      html += `<div class="${cls}" data-date="${iso}">
        <div class="cal-day-num">${dt.getDate()}</div>
        ${pills}${more}
      </div>`;
    }
    grid.innerHTML = html;
    wireCalendarDnD();
  }
  function wireCalendarDnD() {
    const grid = document.getElementById('calGrid');
    grid.querySelectorAll('.cal-event-pill').forEach(pill => {
      pill.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/plain', pill.dataset.eid);
        e.dataTransfer.effectAllowed = 'move';
        pill.classList.add('dragging');
      });
      pill.addEventListener('dragend', () => pill.classList.remove('dragging'));
      pill.addEventListener('click', e => {
        e.stopPropagation();
        // Quick action: open the related business if it's a milestone
        const eid = pill.dataset.eid;
        if (eid.startsWith('auto-')) {
          const mid = eid.slice(5);
          const b = loadBiz().find(b => (b.milestones || []).some(m => m.id === mid));
          if (b) openDrawer(b.id);
        }
      });
    });
    grid.querySelectorAll('.cal-day').forEach(cell => {
      cell.addEventListener('dragover', e => { e.preventDefault(); cell.classList.add('is-drop-target'); });
      cell.addEventListener('dragleave', () => cell.classList.remove('is-drop-target'));
      cell.addEventListener('drop', e => {
        e.preventDefault();
        cell.classList.remove('is-drop-target');
        const eid = e.dataTransfer.getData('text/plain');
        const newDate = cell.dataset.date;
        moveEvent(eid, newDate);
      });
    });
  }
  function moveEvent(eid, newDate) {
    if (eid.startsWith('auto-')) {
      // Auto event = milestone date change
      const mid = eid.slice(5);
      const arr = loadBiz();
      arr.forEach(b => {
        (b.milestones || []).forEach(m => { if (m.id === mid) m.date = newDate; });
      });
      saveBiz(arr);
    } else {
      const evs = loadEvents();
      const e = evs.find(x => x.id === eid);
      if (e) { e.date = newDate; saveEvents(evs); }
    }
    renderCalendar();
    renderBusinesses();
    renderKPIs();
  }

  const calPrevBtn = document.getElementById('calPrev');
  const calNextBtn = document.getElementById('calNext');
  const calTodayBtn = document.getElementById('calToday');
  const calAddBtn = document.getElementById('calAddBtn');
  if (calPrevBtn) calPrevBtn.addEventListener('click', () => {
    calCursor.m--; if (calCursor.m < 0) { calCursor.m = 11; calCursor.y--; }
    renderCalendar();
  });
  if (calNextBtn) calNextBtn.addEventListener('click', () => {
    calCursor.m++; if (calCursor.m > 11) { calCursor.m = 0; calCursor.y++; }
    renderCalendar();
  });
  if (calTodayBtn) calTodayBtn.addEventListener('click', () => {
    const now = new Date();
    calCursor = { y: now.getFullYear(), m: now.getMonth() };
    renderCalendar();
  });
  if (calAddBtn) calAddBtn.addEventListener('click', () => {
    const nameEl = document.getElementById('calEvName');
    const dateEl = document.getElementById('calEvDate');
    const typeEl = document.getElementById('calEvType');
    if (!nameEl || !dateEl || !typeEl) return;
    const text = nameEl.value.trim();
    const date = dateEl.value;
    const type = typeEl.value;
    if (!text || !date) return;
    const evs = loadEvents();
    evs.push({ id: uid(), text, date, type });
    saveEvents(evs);
    nameEl.value = '';
    dateEl.value = '';
    renderCalendar();
    renderKPIs();
  });

  // ============================================================
  // GLOBE
  // ============================================================
  let globeInstance = null;
  let globePoints = [];
  let globeRotateInterval = null;

  function setHudStatus(text) {
    const el = document.getElementById('hudStatus');
    if (el) el.textContent = text;
  }

  function initGlobeIfNeeded() {
    try {
      if (globeInstance) return;
      if (!window.Globe) {
        // Globe lib hasn't loaded yet. Retry on next tick.
        setTimeout(initGlobeIfNeeded, 250);
        return;
      }
      const stage = document.getElementById('globeCanvas');
      if (!stage) return;
      const apiKey = get(KEYS.newsKey, '');
      showKeyBanner(!apiKey);

      globeInstance = Globe()
        .backgroundColor('rgba(0,0,0,0)')
        .showAtmosphere(true)
        .atmosphereColor('#7DD3FC')
        .atmosphereAltitude(0.18)
        .globeImageUrl('https://unpkg.com/three-globe@2.31.1/example/img/earth-night.jpg')
        .bumpImageUrl('https://unpkg.com/three-globe@2.31.1/example/img/earth-topology.png')
        .pointsData([])
        .pointAltitude('alt')
        .pointColor('color')
        .pointRadius('radius')
        .pointResolution(8)
        .pointLabel(d => `<div style="background:rgba(11,12,24,0.92);color:#FAFAFA;padding:8px 12px;border-radius:8px;font-family:ui-monospace,monospace;font-size:11.5px;border:1px solid rgba(255,255,255,0.10);max-width:260px;line-height:1.4">
          <div style="color:${d.color};font-size:9.5px;letter-spacing:0.16em;font-weight:800;margin-bottom:4px">${d.cat.toUpperCase()} · ${d.country}</div>
          <div style="font-weight:600">${escapeHtml(d.title.slice(0, 110))}${d.title.length > 110 ? '…' : ''}</div>
        </div>`)
        .onPointClick(p => openGlobeDetail(p))
        .ringsData([])
        .ringColor(() => t => `rgba(125,211,252, ${1 - t})`)
        .ringMaxRadius(4)
        .ringPropagationSpeed(2)
        .ringRepeatPeriod(1400)
        (stage);

      // Cinematic settings
      try {
        globeInstance.controls().autoRotate = true;
        globeInstance.controls().autoRotateSpeed = 0.35;
        globeInstance.controls().enableDamping = true;
        globeInstance.controls().dampingFactor = 0.08;
        globeInstance.controls().enableZoom = true;
        globeInstance.controls().minDistance = 180;
        globeInstance.controls().maxDistance = 600;
      } catch (e) { console.error('globe controls failed', e); }

      // Resize handling
      function resize() {
        try {
          const w = stage.clientWidth;
          const h = stage.clientHeight;
          if (globeInstance && globeInstance.width) globeInstance.width(w).height(h);
        } catch (e) {}
      }
      resize();
      window.addEventListener('resize', resize);

      // Track lat/lon under cursor for HUD
      stage.addEventListener('mousemove', e => {
        try {
          const rect = stage.getBoundingClientRect();
          const x = (e.clientX - rect.left) / rect.width * 2 - 1;
          const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
          const lat = (Math.asin(y * 0.9) * 180 / Math.PI).toFixed(2);
          const lon = (x * 180).toFixed(2);
          const hudCoord = document.getElementById('hudCoord');
          if (hudCoord) hudCoord.textContent = `LAT ${lat}  LON ${lon}`;
        } catch (e) {}
      });

      // Load cached news immediately so the globe doesn't sit empty
      const cache = get(KEYS.newsCache, null);
      if (cache && cache.events && cache.events.length) {
        try { ingestNews(cache.events); } catch (e) { console.error('ingestNews cache failed', e); }
        setHudStatus('CACHED · ' + new Date(cache.ts).toLocaleTimeString());
      } else {
        // No cache yet — show sample data so the globe is never empty,
        // regardless of whether an API key is configured.
        try { ingestNews(SAMPLE_NEWS); } catch (e) { console.error('ingestNews sample failed', e); }
        setHudStatus(apiKey ? 'LOADING…' : 'SAMPLE FEED');
      }
      // Pull fresh data if a key is set
      if (apiKey) fetchNews();
    } catch (e) {
      console.error('initGlobeIfNeeded failed:', e);
    }
  }

  function showKeyBanner(show) {
    const b = document.getElementById('globeKeyBanner');
    if (b) b.classList.toggle('hidden', !show);
  }
  const globeKeySaveBtn = document.getElementById('globeKeySaveBtn');
  if (globeKeySaveBtn) globeKeySaveBtn.addEventListener('click', () => {
    const input = document.getElementById('globeKeyInput');
    if (!input) return;
    const v = input.value.trim();
    if (!v) return;
    set(KEYS.newsKey, v);
    showKeyBanner(false);
    setHudStatus('CONNECTING…');
    fetchNews();
  });
  // Click HUD status or the edit-key link to re-open the banner
  function reopenKeyBanner() {
    const banner = document.getElementById('globeKeyBanner');
    const input = document.getElementById('globeKeyInput');
    if (banner && input) {
      input.value = get(KEYS.newsKey, '');
      banner.classList.remove('hidden');
      setTimeout(() => input.focus(), 80);
    }
  }
  const hudStatusEl = document.getElementById('hudStatus');
  const hudEditEl = document.getElementById('hudEditKey');
  const globeKeySkipBtn = document.getElementById('globeKeySkipBtn');
  if (hudStatusEl) hudStatusEl.addEventListener('click', reopenKeyBanner);
  if (hudEditEl) hudEditEl.addEventListener('click', reopenKeyBanner);
  if (globeKeySkipBtn) globeKeySkipBtn.addEventListener('click', () => {
    showKeyBanner(false);
    ingestNews(SAMPLE_NEWS);
    if (hudStatusEl) hudStatusEl.textContent = 'SAMPLE FEED';
  });

  // ─── Country → lat/lon mapping ──────────────────────────
  // Limited set, broad coverage. Falls back to inferring from text.
  const COUNTRY_COORDS = {
    us:[39.83,-98.58], usa:[39.83,-98.58], 'united states':[39.83,-98.58],
    cn:[35.86,104.20], china:[35.86,104.20],
    ru:[61.52,105.32], russia:[61.52,105.32],
    de:[51.17,10.45], germany:[51.17,10.45],
    fr:[46.23,2.21],  france:[46.23,2.21],
    gb:[55.38,-3.44], uk:[55.38,-3.44], 'united kingdom':[55.38,-3.44],
    jp:[36.20,138.25], japan:[36.20,138.25],
    in:[20.59,78.96], india:[20.59,78.96],
    br:[-14.24,-51.93], brazil:[-14.24,-51.93],
    ca:[56.13,-106.35], canada:[56.13,-106.35],
    au:[-25.27,133.78], australia:[-25.27,133.78],
    kr:[35.91,127.77], 'south korea':[35.91,127.77],
    mx:[23.63,-102.55], mexico:[23.63,-102.55],
    es:[40.46,-3.75], spain:[40.46,-3.75],
    it:[41.87,12.57], italy:[41.87,12.57],
    nl:[52.13,5.29], netherlands:[52.13,5.29],
    se:[60.13,18.64], sweden:[60.13,18.64],
    ch:[46.82,8.23], switzerland:[46.82,8.23],
    sa:[23.89,45.08], 'saudi arabia':[23.89,45.08],
    ae:[23.42,53.85], uae:[23.42,53.85],
    il:[31.05,34.85], israel:[31.05,34.85],
    ir:[32.43,53.69], iran:[32.43,53.69],
    tr:[38.96,35.24], turkey:[38.96,35.24],
    eg:[26.82,30.80], egypt:[26.82,30.80],
    za:[-30.56,22.94], 'south africa':[-30.56,22.94],
    ng:[9.08,8.68], nigeria:[9.08,8.68],
    ke:[-0.02,37.91], kenya:[-0.02,37.91],
    ua:[48.38,31.17], ukraine:[48.38,31.17],
    pl:[51.92,19.15], poland:[51.92,19.15],
    tw:[23.70,120.96], taiwan:[23.70,120.96],
    sg:[1.35,103.82], singapore:[1.35,103.82],
    hk:[22.32,114.17], 'hong kong':[22.32,114.17],
    th:[15.87,100.99], thailand:[15.87,100.99],
    id:[-0.79,113.92], indonesia:[-0.79,113.92],
    vn:[14.06,108.28], vietnam:[14.06,108.28],
    pk:[30.38,69.34], pakistan:[30.38,69.34],
    ar:[-38.42,-63.62], argentina:[-38.42,-63.62],
    cl:[-35.68,-71.54], chile:[-35.68,-71.54],
    co:[4.57,-74.30], colombia:[4.57,-74.30],
    no:[60.47,8.46], norway:[60.47,8.46],
    fi:[61.92,25.75], finland:[61.92,25.75],
    dk:[56.26,9.50], denmark:[56.26,9.50],
    be:[50.50,4.47], belgium:[50.50,4.47],
    at:[47.52,14.55], austria:[47.52,14.55],
    pt:[39.40,-8.22], portugal:[39.40,-8.22],
    gr:[39.07,21.82], greece:[39.07,21.82],
    cz:[49.82,15.47], 'czech republic':[49.82,15.47],
    ie:[53.41,-8.24], ireland:[53.41,-8.24],
    ph:[12.88,121.77], philippines:[12.88,121.77],
    my:[4.21,101.97], malaysia:[4.21,101.97],
    nz:[-40.90,174.89], 'new zealand':[-40.90,174.89],
    ro:[45.94,24.97], romania:[45.94,24.97],
    hu:[47.16,19.50], hungary:[47.16,19.50],
    qa:[25.35,51.18], qatar:[25.35,51.18],
    kz:[48.02,66.92], kazakhstan:[48.02,66.92],
  };

  // ── Sub-region database for granular location pinning ──────────
  // Order matters: longer/more-specific names are tried first via
  // sorted key iteration in locate(). Coordinates are city centers
  // (or state capitals for US states).
  const SUB_REGION_COORDS = {
    // ─── US States (state capitals) ───
    'alabama':[32.36,-86.28], 'alaska':[58.30,-134.42], 'arizona':[33.45,-112.07],
    'arkansas':[34.74,-92.28], 'california':[38.58,-121.49], 'colorado':[39.74,-104.99],
    'connecticut':[41.76,-72.67], 'delaware':[39.16,-75.52], 'florida':[30.44,-84.28],
    'georgia':[33.75,-84.39], 'hawaii':[21.31,-157.86], 'idaho':[43.62,-116.20],
    'illinois':[39.78,-89.65], 'indiana':[39.77,-86.16], 'iowa':[41.59,-93.62],
    'kansas':[39.05,-95.69], 'kentucky':[38.20,-84.87], 'louisiana':[30.45,-91.14],
    'maine':[44.31,-69.78], 'maryland':[38.97,-76.50], 'massachusetts':[42.36,-71.06],
    'michigan':[42.73,-84.56], 'minnesota':[44.95,-93.10], 'mississippi':[32.30,-90.18],
    'missouri':[38.58,-92.17], 'montana':[46.59,-112.04], 'nebraska':[40.81,-96.68],
    'nevada':[39.16,-119.77], 'new hampshire':[43.21,-71.54], 'new jersey':[40.22,-74.76],
    'new mexico':[35.69,-105.94], 'new york state':[42.65,-73.76], 'north carolina':[35.78,-78.64],
    'north dakota':[46.81,-100.78], 'ohio':[39.96,-82.99], 'oklahoma':[35.49,-97.51],
    'oregon':[44.93,-123.03], 'pennsylvania':[40.27,-76.88], 'rhode island':[41.83,-71.41],
    'south carolina':[34.00,-81.03], 'south dakota':[44.37,-100.35], 'tennessee':[36.16,-86.78],
    'texas':[30.27,-97.74], 'utah':[40.76,-111.89], 'vermont':[44.26,-72.58],
    'virginia':[37.54,-77.43], 'washington state':[47.04,-122.90], 'west virginia':[38.34,-81.63],
    'wisconsin':[43.07,-89.40], 'wyoming':[41.14,-104.82],

    // ─── Major US Cities (some override state defaults for specificity) ───
    'new york city':[40.71,-74.01], 'new york':[40.71,-74.01], 'nyc':[40.71,-74.01],
    'los angeles':[34.05,-118.24], 'chicago':[41.88,-87.63], 'houston':[29.76,-95.37],
    'phoenix':[33.45,-112.07], 'philadelphia':[39.95,-75.17], 'san antonio':[29.42,-98.49],
    'san diego':[32.72,-117.16], 'dallas':[32.78,-96.80], 'austin':[30.27,-97.74],
    'san francisco':[37.77,-122.42], 'san jose':[37.34,-121.89], 'seattle':[47.61,-122.33],
    'denver':[39.74,-104.99], 'boston':[42.36,-71.06], 'detroit':[42.33,-83.05],
    'miami':[25.76,-80.19], 'atlanta':[33.75,-84.39], 'washington dc':[38.91,-77.04],
    'washington d.c.':[38.91,-77.04], 'd.c.':[38.91,-77.04],
    'las vegas':[36.17,-115.14], 'portland':[45.51,-122.68], 'orlando':[28.54,-81.38],
    'tampa':[27.95,-82.46], 'pittsburgh':[40.44,-79.99], 'cleveland':[41.50,-81.69],
    'cincinnati':[39.10,-84.51], 'kansas city':[39.10,-94.58], 'st. louis':[38.63,-90.20],
    'minneapolis':[44.98,-93.27], 'milwaukee':[43.04,-87.91], 'baltimore':[39.29,-76.61],
    'charlotte':[35.23,-80.84], 'raleigh':[35.78,-78.64], 'nashville':[36.16,-86.78],
    'memphis':[35.15,-90.05], 'new orleans':[29.95,-90.07], 'jacksonville':[30.33,-81.66],
    'columbus':[39.96,-82.99], 'indianapolis':[39.77,-86.16], 'oklahoma city':[35.47,-97.52],
    'albuquerque':[35.08,-106.65], 'tucson':[32.22,-110.93], 'fresno':[36.74,-119.79],
    'sacramento':[38.58,-121.49], 'long beach':[33.77,-118.19], 'oakland':[37.80,-122.27],
    'omaha':[41.26,-95.93], 'tulsa':[36.15,-95.99], 'wichita':[37.69,-97.34],
    'buffalo':[42.89,-78.88], 'salt lake city':[40.76,-111.89], 'honolulu':[21.31,-157.86],

    // ─── US Counties (high-profile ones often in news) ───
    'maricopa county':[33.45,-112.07], 'los angeles county':[34.05,-118.24],
    'cook county':[41.88,-87.63], 'harris county':[29.76,-95.37],
    'fulton county':[33.75,-84.39], 'broward county':[26.12,-80.14],
    'miami-dade county':[25.76,-80.19], 'orange county':[33.72,-117.83],
    'san diego county':[32.72,-117.16], 'kings county':[40.65,-73.95],
    'queens county':[40.73,-73.79], 'dallas county':[32.78,-96.80],
    'tarrant county':[32.75,-97.33], 'wayne county':[42.33,-83.05],
    'clark county':[36.17,-115.14], 'palm beach county':[26.71,-80.05],
    'allegheny county':[40.44,-79.99], 'fairfax county':[38.85,-77.30],
    'montgomery county':[39.14,-77.20], 'fulton':[33.75,-84.39],
    'maricopa':[33.45,-112.07], 'cook':[41.88,-87.63],

    // ─── Canadian Provinces & Cities ───
    'ontario':[51.25,-85.32], 'quebec':[52.94,-73.55], 'british columbia':[53.73,-127.65],
    'alberta':[53.93,-116.58], 'manitoba':[53.76,-98.81], 'saskatchewan':[52.94,-106.45],
    'nova scotia':[44.68,-63.74], 'new brunswick':[46.57,-66.46], 'newfoundland':[53.13,-57.66],
    'toronto':[43.65,-79.38], 'montreal':[45.50,-73.57], 'vancouver':[49.28,-123.12],
    'calgary':[51.04,-114.07], 'edmonton':[53.55,-113.49], 'ottawa':[45.42,-75.69],
    'winnipeg':[49.90,-97.14], 'quebec city':[46.81,-71.21], 'halifax':[44.65,-63.58],

    // ─── UK & Ireland Cities ───
    'london':[51.51,-0.13], 'manchester':[53.48,-2.24], 'birmingham':[52.49,-1.89],
    'glasgow':[55.86,-4.25], 'edinburgh':[55.95,-3.19], 'liverpool':[53.41,-2.99],
    'leeds':[53.80,-1.55], 'bristol':[51.45,-2.59], 'cardiff':[51.48,-3.18],
    'belfast':[54.60,-5.93], 'dublin':[53.35,-6.26], 'cork':[51.90,-8.47],
    'wales':[52.13,-3.78], 'scotland':[56.49,-4.20],

    // ─── European Cities ───
    'berlin':[52.52,13.40], 'munich':[48.14,11.58], 'hamburg':[53.55,9.99],
    'frankfurt':[50.11,8.68], 'cologne':[50.94,6.96], 'paris':[48.86,2.35],
    'lyon':[45.76,4.84], 'marseille':[43.30,5.37], 'madrid':[40.42,-3.70],
    'barcelona':[41.39,2.17], 'rome':[41.90,12.50], 'milan':[45.46,9.19],
    'naples':[40.85,14.27], 'amsterdam':[52.37,4.90], 'rotterdam':[51.92,4.48],
    'brussels':[50.85,4.35], 'vienna':[48.21,16.37], 'zurich':[47.38,8.54],
    'geneva':[46.20,6.15], 'stockholm':[59.33,18.07], 'oslo':[59.91,10.75],
    'copenhagen':[55.68,12.57], 'helsinki':[60.17,24.94], 'warsaw':[52.23,21.01],
    'prague':[50.08,14.44], 'budapest':[47.50,19.04], 'athens':[37.98,23.73],
    'lisbon':[38.72,-9.14], 'dublin':[53.35,-6.26], 'kyiv':[50.45,30.52],
    'kiev':[50.45,30.52], 'moscow':[55.76,37.62], 'st. petersburg':[59.93,30.34],

    // ─── Middle East ───
    'tel aviv':[32.08,34.78], 'jerusalem':[31.78,35.22], 'gaza':[31.50,34.47],
    'beirut':[33.89,35.50], 'damascus':[33.51,36.29], 'baghdad':[33.31,44.36],
    'tehran':[35.69,51.39], 'riyadh':[24.71,46.68], 'dubai':[25.20,55.27],
    'abu dhabi':[24.45,54.38], 'doha':[25.29,51.53], 'kuwait city':[29.38,47.99],
    'istanbul':[41.01,28.98], 'ankara':[39.93,32.86], 'cairo':[30.04,31.24],

    // ─── Asia ───
    'beijing':[39.90,116.41], 'shanghai':[31.23,121.47], 'shenzhen':[22.54,114.06],
    'guangzhou':[23.13,113.26], 'hong kong':[22.32,114.17], 'taipei':[25.03,121.57],
    'tokyo':[35.68,139.69], 'osaka':[34.69,135.50], 'kyoto':[35.01,135.77],
    'seoul':[37.57,126.98], 'busan':[35.18,129.08], 'pyongyang':[39.04,125.76],
    'singapore':[1.35,103.82], 'kuala lumpur':[3.14,101.69], 'bangkok':[13.76,100.50],
    'manila':[14.60,120.98], 'jakarta':[-6.21,106.85], 'hanoi':[21.03,105.85],
    'ho chi minh':[10.78,106.70], 'mumbai':[19.08,72.88], 'delhi':[28.61,77.21],
    'new delhi':[28.61,77.21], 'bengaluru':[12.97,77.59], 'bangalore':[12.97,77.59],
    'kolkata':[22.57,88.36], 'chennai':[13.08,80.27], 'karachi':[24.86,67.01],
    'islamabad':[33.69,73.05], 'lahore':[31.55,74.34], 'dhaka':[23.81,90.41],

    // ─── Africa ───
    'lagos':[6.52,3.38], 'abuja':[9.06,7.50], 'nairobi':[-1.29,36.82],
    'johannesburg':[-26.20,28.04], 'cape town':[-33.93,18.42], 'accra':[5.60,-0.19],
    'addis ababa':[9.03,38.74],

    // ─── Latin America ───
    'mexico city':[19.43,-99.13], 'guadalajara':[20.66,-103.35], 'monterrey':[25.69,-100.32],
    'são paulo':[-23.55,-46.63], 'sao paulo':[-23.55,-46.63], 'rio de janeiro':[-22.91,-43.17],
    'brasilia':[-15.79,-47.88], 'buenos aires':[-34.61,-58.37], 'santiago':[-33.45,-70.67],
    'lima':[-12.05,-77.04], 'bogota':[4.71,-74.07], 'caracas':[10.49,-66.88],
    'havana':[23.13,-82.38],

    // ─── Oceania ───
    'sydney':[-33.87,151.21], 'melbourne':[-37.81,144.96], 'brisbane':[-27.47,153.03],
    'perth':[-31.95,115.86], 'auckland':[-36.85,174.76], 'wellington':[-41.29,174.78],
  };
  // Pre-sort sub-region keys longest-first so "new york city" matches
  // before "new york", "los angeles" before "los", etc.
  const SUB_REGION_KEYS = Object.keys(SUB_REGION_COORDS)
    .sort((a, b) => b.length - a.length);

  function jitter(coords, seed) {
    // Tiny offset so multiple stories at the same city don't perfectly overlap.
    const s = (seed || 0) * 17 + 31;
    return [
      coords[0] + ((s % 13) - 6) * 0.05,
      coords[1] + ((s % 17) - 8) * 0.05,
    ];
  }

  function categorize(item) {
    const txt = ((item.title || '') + ' ' + (item.description || '') + ' ' + (item.category || []).join(' ')).toLowerCase();
    if (/\b(war|missile|strike|invasion|attack|conflict|drone)\b/.test(txt)) return 'war';
    if (/\b(election|president|prime minister|parliament|coup|protest)\b/.test(txt)) return 'politics';
    if (/\b(oil|gas|opec|barrel|energy|pipeline|nuclear)\b/.test(txt)) return 'energy';
    if (/\b(ai|chip|semiconductor|nvidia|tsmc|tech|software|cloud|robot)\b/.test(txt)) return 'tech';
    if (/\b(stock|equity|index|nasdaq|sp 500|s&p|trading|portfolio|hedge)\b/.test(txt)) return 'markets';
    if (/\b(inflation|gdp|economy|recession|jobs|unemployment|trade|tariff)\b/.test(txt)) return 'economy';
    if (/\b(climate|hurricane|flood|earthquake|wildfire|drought)\b/.test(txt)) return 'climate';
    return 'economy';
  }
  function titleCase(s) {
    return s.replace(/\b\w/g, c => c.toUpperCase());
  }
  // Returns { coords: [lat, lng], label: "City, Region" } so we can
  // surface the actual matched place in the UI (not just the country).
  function locate(item, idx) {
    const txt = ((item.title || '') + ' ' + (item.description || '')).toLowerCase();
    const seed = (item.title || '').length + (idx || 0);

    // 1. Most specific: try to match a sub-region (city/state/county) from the text.
    // Longest names first so "new york city" beats "new york".
    for (const name of SUB_REGION_KEYS) {
      const re = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
      if (re.test(txt)) {
        return { coords: jitter(SUB_REGION_COORDS[name], seed), label: titleCase(name) };
      }
    }

    // 2. Less specific: country code from the news provider's country field.
    const c = String(item.country || '').toLowerCase().trim();
    if (c && COUNTRY_COORDS[c]) {
      return { coords: jitter(COUNTRY_COORDS[c], seed), label: c.toUpperCase() };
    }

    // 3. Country name in the text.
    for (const name of Object.keys(COUNTRY_COORDS)) {
      if (name.length < 3) continue;
      if (txt.indexOf(' ' + name + ' ') !== -1 || txt.indexOf(name + ',') !== -1) {
        return { coords: jitter(COUNTRY_COORDS[name], seed), label: titleCase(name) };
      }
    }

    // 4. Final fallback: deterministic spread so multiple "global" stories don't pile up.
    return { coords: [((seed * 7) % 140) - 70, ((seed * 11) % 340) - 170], label: 'GLOBAL' };
  }

  const CAT_COLORS = {
    economy: '#6EE7B7', markets: '#F2C063', politics: '#7DD3FC',
    tech: '#5EEAD4', war: '#FF8A8A', energy: '#F2C063',
    climate: '#B794F4',
  };

  // Sample news so the globe is never empty
  const SAMPLE_NEWS = [
    { title: 'US Fed signals slower rate path as inflation eases', country: 'us', category: ['economy'], description: 'Fed officials suggest fewer cuts in 2026.', link: '#' },
    { title: 'TSMC ramps 2nm production amid surging AI demand', country: 'tw', category: ['tech'], description: 'Apple, Nvidia secure major capacity.', link: '#' },
    { title: 'OPEC+ extends voluntary oil output cuts through Q2', country: 'sa', category: ['energy'], description: 'Brent crude reacts upward.', link: '#' },
    { title: 'Germany manufacturing PMI ticks above 50 for first time in 9 months', country: 'de', category: ['economy'], description: 'Eurozone signals recovery.', link: '#' },
    { title: 'Japan yen strengthens after BOJ hints at policy shift', country: 'jp', category: ['markets'], description: 'USD/JPY drops below 150.', link: '#' },
    { title: 'China injects liquidity to stabilize property sector', country: 'cn', category: ['economy'], description: 'PBOC announces new measures.', link: '#' },
    { title: 'UK parliament debates AI regulation framework', country: 'gb', category: ['tech','politics'], description: 'Sets stage for Q2 vote.', link: '#' },
    { title: 'India digital payments cross record monthly volume', country: 'in', category: ['economy','tech'], description: 'UPI logs 17B+ transactions.', link: '#' },
    { title: 'Brazil central bank holds Selic at 11.25%', country: 'br', category: ['economy'], description: 'Dovish forward guidance.', link: '#' },
    { title: 'Israel-Hamas ceasefire negotiations resume in Qatar', country: 'qa', category: ['politics','war'], description: 'Regional tensions remain elevated.', link: '#' },
    { title: 'Australia mining giants report record iron ore shipments', country: 'au', category: ['economy'], description: 'BHP, Rio Tinto Q1 update.', link: '#' },
    { title: 'Canada oil sands exports hit new high via TMX pipeline', country: 'ca', category: ['energy'], description: 'WCS-WTI spread narrows.', link: '#' },
    { title: 'Mexico ratifies labor reform key to USMCA review', country: 'mx', category: ['politics','economy'], description: 'Currency steady.', link: '#' },
    { title: 'Korean chipmakers boost HBM capacity for AI accelerators', country: 'kr', category: ['tech'], description: 'SK Hynix, Samsung capex jump.', link: '#' },
    { title: 'Russia energy revenues stabilize despite price caps', country: 'ru', category: ['energy','politics'], description: 'Shadow fleet workarounds.', link: '#' },
  ];

  function ingestNews(arr) {
    if (!Array.isArray(arr)) arr = [];
    globePoints = arr.map((it, i) => {
      const cat = categorize(it);
      const loc = locate(it, i);
      return {
        id: it.article_id || it.id || ('n' + i),
        lat: loc.coords[0],
        lng: loc.coords[1],
        alt: 0.01 + Math.random() * 0.03,
        radius: 0.5 + Math.random() * 0.5,
        color: CAT_COLORS[cat] || '#7DD3FC',
        cat,
        // `country` is now actually the most specific region we matched
        // (e.g. "New York City", "Texas", "Berlin") — keeps the UI label
        // honest about where the pin is.
        country: loc.label,
        title: it.title || 'Untitled',
        description: it.description || '',
        link: it.link || it.source_url || '#',
        source: it.source_id || it.source_name || 'newsdata.io',
        pubDate: it.pubDate || it.published_at || new Date().toISOString(),
      };
    });
    if (globeInstance) {
      globeInstance.pointsData(globePoints);
      // Add pulsing rings on the top hotspots (highest urgency)
      const hot = globePoints.filter(p => p.cat === 'war' || p.cat === 'markets').slice(0, 8);
      globeInstance.ringsData(hot.map(p => ({ lat: p.lat, lng: p.lng, color: p.color })))
        .ringColor(d => t => d.color.replace(')', `,${(1 - t).toFixed(2)})`).replace('#', 'rgba(0,0,0,').replace(/^rgba\(0,0,0,([^,]+)$/, 'rgba(0,0,0,'+ '0' +')'));
    }
    renderGlobeFeed();
    const hudEvents = document.getElementById('hudEvents');
    if (hudEvents) hudEvents.textContent = String(globePoints.length);
  }

  let globeCatFilter = 'all';
  const globeCatRow = document.getElementById('globeCatRow');
  if (globeCatRow) globeCatRow.addEventListener('click', e => {
    const btn = e.target.closest('.globe-cat');
    if (!btn) return;
    document.querySelectorAll('.globe-cat').forEach(b => b.classList.toggle('active', b === btn));
    globeCatFilter = btn.dataset.cat;
    renderGlobeFeed();
  });
  function renderGlobeFeed() {
    const feed = document.getElementById('globeFeed');
    const count = document.getElementById('globeSideCount');
    if (!feed) return;
    const filtered = globeCatFilter === 'all' ? globePoints : globePoints.filter(p => p.cat === globeCatFilter);
    if (count) count.textContent = filtered.length;
    if (!filtered.length) {
      feed.innerHTML = `<div style="padding:24px 14px;font-size:12px;color:var(--text-tertiary);text-align:center;font-style:italic">No events in this category yet.</div>`;
      return;
    }
    feed.innerHTML = filtered.slice(0, 50).map(p => `
      <div class="globe-event" data-id="${p.id}" data-cat="${p.cat}">
        <div class="globe-event-title">${escapeHtml(p.title)}</div>
        <div class="globe-event-meta">
          <span class="globe-event-loc">${escapeHtml(p.country)}</span>
          <span>·</span>
          <span>${escapeHtml(p.cat.toUpperCase())}</span>
        </div>
      </div>
    `).join('');
    feed.querySelectorAll('.globe-event').forEach(el => {
      el.addEventListener('click', () => {
        const pt = globePoints.find(p => p.id === el.dataset.id);
        if (!pt) return;
        if (globeInstance) globeInstance.pointOfView({ lat: pt.lat, lng: pt.lng, altitude: 1.5 }, 1200);
        openGlobeDetail(pt);
      });
    });
  }

  // ─── News fetching ─────────────────────────────────────────
  // Supports both NewsAPI.org (32-char hex key) and NewsData.io (pub_ prefix).
  // NewsAPI.org's free Developer plan blocks browser requests, so we route
  // through a public CORS proxy when needed.
  function detectNewsProvider(key) {
    if (!key) return null;
    if (/^pub_/.test(key)) return 'newsdata';
    if (/^[a-f0-9]{32}$/i.test(key)) return 'newsapi';
    return 'newsapi'; // default to NewsAPI.org for unknown formats
  }
  function normalizeNewsApiArticles(arr) {
    // NewsAPI.org returns { source: { name }, author, title, description, url, urlToImage, publishedAt, content }
    // No country field — we infer from title/description text.
    return (arr || []).map((a, i) => ({
      article_id: 'na' + i + '-' + (a.publishedAt || ''),
      title: a.title || '',
      description: a.description || '',
      country: '',
      category: [],
      link: a.url || '#',
      source_id: (a.source && a.source.name) || 'newsapi.org',
      pubDate: a.publishedAt || new Date().toISOString(),
    }));
  }

  async function fetchNews() {
    const apiKey = get(KEYS.newsKey, '');
    if (!apiKey) return;
    const provider = detectNewsProvider(apiKey);
    const status = document.getElementById('hudStatus');
    const setStatus = (text) => { if (status) status.textContent = text; };
    setStatus('STREAMING…');

    try {
      let articles = [];
      if (provider === 'newsdata') {
        const url = `https://newsdata.io/api/1/latest?apikey=${encodeURIComponent(apiKey)}&language=en&size=50&category=business,politics,technology,world`;
        const res = await fetch(url);
        const data = await res.json();
        if (data && data.results) articles = data.results;
        else if (data && data.message) {
          setStatus('API: ' + String(data.message).slice(0, 30).toUpperCase());
          return;
        }
      } else {
        // NewsAPI.org. Free dev plan blocks direct browser calls so we go
        // straight to a CORS proxy. /v2/everything is used (top-headlines
        // requires a country/category param and is more limited).
        const newsapiUrl = 'https://newsapi.org/v2/everything?language=en&sortBy=publishedAt&pageSize=50&q=(market%20OR%20economy%20OR%20geopolitics%20OR%20politics%20OR%20technology%20OR%20business)&apiKey=' + encodeURIComponent(apiKey);
        const proxies = [
          'https://corsproxy.io/?' + encodeURIComponent(newsapiUrl),
          'https://api.allorigins.win/raw?url=' + encodeURIComponent(newsapiUrl),
        ];
        let raw = null;
        let lastError = null;
        // Try direct first (works if user has a paid plan)
        try {
          const res = await fetch(newsapiUrl);
          const data = await res.json();
          if (data && data.status === 'ok' && Array.isArray(data.articles) && data.articles.length) {
            raw = data.articles;
          } else if (data && data.message) {
            lastError = data.message;
          }
        } catch (e) { /* CORS — proxies will handle */ }
        // Otherwise try each proxy
        if (!raw) {
          setStatus('PROXYING…');
          for (const url of proxies) {
            try {
              const res = await fetch(url);
              const data = await res.json();
              if (data && data.status === 'ok' && Array.isArray(data.articles) && data.articles.length) {
                raw = data.articles; break;
              } else if (data && data.message) {
                lastError = data.message;
              }
            } catch (e) { /* try next */ }
          }
        }
        if (raw) articles = normalizeNewsApiArticles(raw);
        else if (lastError) setStatus('NEWSAPI: ' + String(lastError).slice(0, 50).toUpperCase());
      }

      if (articles && articles.length) {
        ingestNews(articles);
        set(KEYS.newsCache, { ts: Date.now(), events: articles.slice(0, 100) });
        setStatus('LIVE · ' + new Date().toLocaleTimeString());
        updateAISummary();
      } else {
        setStatus(provider === 'newsapi' ? 'NEWSAPI · CHECK KEY OR PLAN' : 'NO DATA');
      }
    } catch (e) {
      console.error('news fetch failed', e);
      setStatus('OFFLINE');
    }
  }
  // Re-fetch every 5 minutes (NewsData free tier has rate limits)
  setInterval(fetchNews, 5 * 60 * 1000);

  function openGlobeDetail(p) {
    const overlay = document.getElementById('globeDetailOverlay');
    document.getElementById('globeDetailCat').textContent = p.cat.toUpperCase();
    document.getElementById('globeDetailCat').style.color = p.color;
    document.getElementById('globeDetailCat').style.background = p.color.replace(')', ',0.10)').replace('#', 'rgba(0,0,0,');
    document.getElementById('globeDetailTitle').textContent = p.title;
    document.getElementById('globeDetailMeta').innerHTML =
      `<span>${escapeHtml(p.country)}</span><span>·</span><span>${escapeHtml(p.source)}</span><span>·</span><span>${new Date(p.pubDate).toLocaleDateString('en-US', { month:'short', day:'numeric' })}</span>`;
    document.getElementById('globeDetailDesc').textContent = p.description || 'No analysis available for this event yet — view the source for the full story.';

    // Industries impacted (heuristic)
    const inds = inferIndustries(p);
    document.getElementById('globeDetailTags').innerHTML = inds.map(i => `<span class="globe-detail-tag">${i}</span>`).join('') || '<span style="font-size:12px;color:var(--text-tertiary)">—</span>';

    // Linked watchlist tickers
    const watch = get(KEYS.watch, []);
    const linked = watch.filter(w => isTickerRelevant(p, w));
    document.getElementById('globeDetailLinked').innerHTML = linked.length
      ? linked.map(w => `<span class="globe-detail-tag" style="border-color:rgba(110,231,183,0.30);color:#6EE7B7">${escapeHtml(w.symbol)}</span>`).join('')
      : '<span style="font-size:12px;color:var(--text-tertiary)">Nothing matched from your watchlist</span>';

    const link = document.getElementById('globeDetailLink');
    if (p.link && p.link !== '#') { link.href = p.link; link.style.display = ''; }
    else { link.style.display = 'none'; }

    overlay.classList.add('open');
  }
  function inferIndustries(p) {
    const txt = ((p.title || '') + ' ' + (p.description || '')).toLowerCase();
    const out = new Set();
    const map = [
      [/\b(chip|semiconductor|nvidia|tsmc|amd|intel)\b/, 'Semiconductors'],
      [/\b(ai|llm|generative|model|openai|anthropic)\b/, 'AI'],
      [/\b(oil|barrel|crude|opec|brent|wti)\b/, 'Oil & Gas'],
      [/\b(bank|lender|credit|loan|deposit)\b/, 'Banking'],
      [/\b(electric vehicle|ev|tesla|byd|battery)\b/, 'EV & Battery'],
      [/\b(pharma|drug|fda|vaccine|biotech)\b/, 'Healthcare'],
      [/\b(real estate|housing|property|mortgage)\b/, 'Real Estate'],
      [/\b(cloud|aws|azure|gcp|saas)\b/, 'Cloud'],
      [/\b(retail|ecommerce|amazon|consumer)\b/, 'Retail'],
      [/\b(defense|military|weapons|missile)\b/, 'Defense'],
      [/\b(crypto|bitcoin|ethereum|blockchain)\b/, 'Crypto'],
      [/\b(supply chain|shipping|port|logistics)\b/, 'Logistics'],
    ];
    map.forEach(([re, name]) => { if (re.test(txt)) out.add(name); });
    return [...out].slice(0, 6);
  }
  function isTickerRelevant(p, w) {
    const sym = String(w.symbol || '').toUpperCase();
    const name = String(w.name || '').toLowerCase();
    const txt = ((p.title || '') + ' ' + (p.description || '')).toLowerCase();
    if (sym && txt.indexOf(sym.toLowerCase()) !== -1) return true;
    if (name && txt.indexOf(name) !== -1) return true;
    // Industry-level match
    const inds = inferIndustries(p);
    const tags = String(w.tags || '').toLowerCase();
    return inds.some(i => tags.indexOf(i.toLowerCase()) !== -1);
  }
  const globeDetailClose = document.getElementById('globeDetailClose');
  const globeDetailOverlay = document.getElementById('globeDetailOverlay');
  if (globeDetailClose && globeDetailOverlay) {
    globeDetailClose.addEventListener('click', () => {
      globeDetailOverlay.classList.remove('open');
    });
    globeDetailOverlay.addEventListener('click', e => {
      if (e.target.id === 'globeDetailOverlay') {
        globeDetailOverlay.classList.remove('open');
      }
    });
  }

  // ============================================================
  // TRADING — TradingView embeds + watchlist
  // ============================================================
  const DEFAULT_WATCH = [
    { symbol: 'NASDAQ:AAPL',     name: 'Apple',     tags: 'tech, semiconductors' },
    { symbol: 'NASDAQ:NVDA',     name: 'NVIDIA',    tags: 'tech, semiconductors, ai' },
    { symbol: 'NASDAQ:TSLA',     name: 'Tesla',     tags: 'ev & battery, ai' },
    { symbol: 'BINANCE:BTCUSDT', name: 'Bitcoin',   tags: 'crypto' },
  ];
  function loadWatch() {
    const w = get(KEYS.watch, null);
    if (w == null) { set(KEYS.watch, DEFAULT_WATCH); return DEFAULT_WATCH.slice(); }
    return w;
  }
  function saveWatch(arr) { set(KEYS.watch, arr); }

  function chartFrameUrl(symbol) {
    // Use TradingView's standalone embedded chart (no API key needed)
    const sym = encodeURIComponent(symbol || 'NASDAQ:AAPL');
    return `https://s.tradingview.com/widgetembed/?frameElementId=tvchart&symbol=${sym}&interval=D&hidesidetoolbar=1&symboledit=1&saveimage=0&toolbarbg=0d0d14&studies=%5B%5D&theme=dark&style=2&timezone=Etc%2FUTC&withdateranges=1&showpopupbutton=0&hide_volume=0`;
  }
  function heatmapUrl() {
    return 'https://s.tradingview.com/embed-widget/stock-heatmap/?locale=en#%7B%22exchanges%22%3A%5B%5D%2C%22dataSource%22%3A%22SPX500%22%2C%22grouping%22%3A%22sector%22%2C%22blockSize%22%3A%22market_cap_basic%22%2C%22blockColor%22%3A%22change%22%2C%22hasTopBar%22%3Afalse%2C%22isDataSetEnabled%22%3Afalse%2C%22isZoomEnabled%22%3Afalse%2C%22hasSymbolTooltip%22%3Atrue%2C%22colorTheme%22%3A%22dark%22%2C%22width%22%3A%22100%25%22%2C%22height%22%3A%22100%25%22%7D';
  }
  function eventsUrl() {
    return 'https://s.tradingview.com/embed-widget/events/?locale=en#%7B%22colorTheme%22%3A%22dark%22%2C%22isTransparent%22%3Atrue%2C%22width%22%3A%22100%25%22%2C%22height%22%3A%22100%25%22%2C%22importanceFilter%22%3A%22-1%2C0%2C1%22%2C%22countryFilter%22%3A%22us%2Ceu%2Cjp%2Cgb%22%7D';
  }

  let tradingLoaded = false;
  function ensureTradingLoaded() {
    if (tradingLoaded) return;
    tradingLoaded = true;
    document.getElementById('tradeChart').src = chartFrameUrl('NASDAQ:AAPL');
    document.getElementById('heatmapFrame').src = heatmapUrl();
    document.getElementById('eventsFrame').src = eventsUrl();
    renderWatchlist();
    updateAISummary();
  }

  const tradeGoBtn = document.getElementById('tradeGoBtn');
  const tradeSymbolInput = document.getElementById('tradeSymbol');
  if (tradeGoBtn) tradeGoBtn.addEventListener('click', loadSymbolFromInput);
  if (tradeSymbolInput) tradeSymbolInput.addEventListener('keydown', e => { if (e.key === 'Enter') loadSymbolFromInput(); });
  function loadSymbolFromInput() {
    const inputEl = document.getElementById('tradeSymbol');
    if (!inputEl) return;
    const sym = inputEl.value.trim().toUpperCase();
    if (!sym) return;
    const chartEl = document.getElementById('tradeChart');
    if (chartEl) chartEl.src = chartFrameUrl(sym);
  }
  document.querySelectorAll('.trade-quick[data-quick]').forEach(b => {
    b.addEventListener('click', () => {
      const sym = b.dataset.quick;
      document.getElementById('tradeSymbol').value = sym;
      document.getElementById('tradeChart').src = chartFrameUrl(sym);
    });
  });

  function renderWatchlist() {
    const list = document.getElementById('watchList');
    const count = document.getElementById('watchCount');
    if (!list || !count) return;
    const arr = loadWatch();
    count.textContent = arr.length;
    if (!arr.length) {
      list.innerHTML = `<div style="font-size:12px;color:var(--text-tertiary);font-style:italic;padding:14px 0;text-align:center">No symbols watched yet</div>`;
      return;
    }
    list.innerHTML = arr.map((w, i) => `
      <div class="watch-row" data-i="${i}">
        <span class="watch-sym">${escapeHtml(w.symbol.split(':').pop())}</span>
        <span class="watch-name">${escapeHtml(w.name || '—')}</span>
        <span style="font-family:var(--font-mono);font-size:10.5px;color:var(--text-tertiary)">→</span>
        <button class="watch-x" data-i="${i}" title="Remove">×</button>
      </div>
    `).join('');
    list.querySelectorAll('.watch-row').forEach(row => {
      row.addEventListener('click', e => {
        if (e.target.classList.contains('watch-x')) return;
        const w = loadWatch()[parseInt(row.dataset.i, 10)];
        if (!w) return;
        document.getElementById('tradeSymbol').value = w.symbol;
        document.getElementById('tradeChart').src = chartFrameUrl(w.symbol);
      });
    });
    list.querySelectorAll('.watch-x').forEach(b => {
      b.addEventListener('click', e => {
        e.stopPropagation();
        const i = parseInt(b.dataset.i, 10);
        const arr = loadWatch();
        arr.splice(i, 1);
        saveWatch(arr);
        renderWatchlist();
      });
    });
  }
  const watchAddBtn = document.getElementById('watchAddBtn');
  const watchAddInput = document.getElementById('watchAddInput');
  if (watchAddBtn) watchAddBtn.addEventListener('click', addWatch);
  if (watchAddInput) watchAddInput.addEventListener('keydown', e => { if (e.key === 'Enter') addWatch(); });
  function addWatch() {
    const inputEl = document.getElementById('watchAddInput');
    if (!inputEl) return;
    const v = inputEl.value.trim().toUpperCase();
    if (!v) return;
    const arr = loadWatch();
    if (arr.some(x => x.symbol === v)) {
      document.getElementById('watchAddInput').value = '';
      return;
    }
    arr.push({ symbol: v, name: v.split(':').pop(), tags: '' });
    saveWatch(arr);
    document.getElementById('watchAddInput').value = '';
    renderWatchlist();
  }

  // AI summary — heuristic synthesis from the current news feed + watchlist.
  // No external LLM call required; generates contextual prose so the panel
  // doesn't sit empty.
  function updateAISummary() {
    const el = document.getElementById('aiSummary');
    if (!el) return;
    const points = globePoints;
    if (!points.length) {
      el.textContent = 'Open the globe tab and connect your NewsData.io key (or use the sample feed) — the market pulse synthesizes from live geopolitical signals tied to your watchlist.';
      return;
    }
    const cats = {};
    points.forEach(p => { cats[p.cat] = (cats[p.cat] || 0) + 1; });
    const sorted = Object.entries(cats).sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, 3).map(([k, v]) => `${v} ${k}`).join(' · ');
    const watch = loadWatch();
    const linkedCount = points.reduce((s, p) => s + (watch.some(w => isTickerRelevant(p, w)) ? 1 : 0), 0);
    const tone = points.filter(p => p.cat === 'war').length > 2 ? 'risk-on caution'
      : points.filter(p => p.cat === 'economy').length > 4 ? 'macro-driven'
      : 'consolidation';
    el.innerHTML = `Pulse reads <b style="color:#B794F4">${tone}</b>. Top signals: <b style="color:#FAFAFA">${top}</b>. <b style="color:#6EE7B7">${linkedCount}</b> event${linkedCount === 1 ? '' : 's'} cross-reference your watchlist — open the globe and click any glowing hotspot to drill into its industry exposure and source.`;
  }

  // ============================================================
  // KRONOS — AI stock scanner. Client-side port of the Kronos
  // news-sentiment integration (originally Python/FastAPI):
  //   OU mean-reversion · regime detection (HMM proxy) · trend
  //   filter (Kalman proxy) · tail risk (EVT) — each boosted by
  //   locally-scored news sentiment. Zero backend, zero extra
  //   API credits: prices from Yahoo v8/chart, sentiment from a
  //   built-in financial lexicon, news via the existing feed key.
  // ============================================================
  const KRONOS_CACHE_KEY = 'hustle_kronos_cache';
  const KRONOS_TTL_MS = 4 * 60 * 60 * 1000; // 4h, per the original guide
  const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

  async function kronosFetchCloses(ticker) {
    const sym = ticker.toUpperCase();
    const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=6mo`;
    const urls = [chartUrl,
      'https://corsproxy.io/?' + encodeURIComponent(chartUrl),
      'https://api.allorigins.win/raw?url=' + encodeURIComponent(chartUrl)];
    for (const url of urls) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const j = await res.json();
        const r = j && j.chart && j.chart.result && j.chart.result[0];
        const closes = r && r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close;
        if (closes && closes.length) {
          const clean = closes.filter(c => typeof c === 'number' && isFinite(c));
          if (clean.length >= 30) return clean;
        }
      } catch (e) { /* try next */ }
    }
    return null;
  }

  // ─── Quant engines (simplified ports of the four Kronos engines) ───
  function kronosQuant(closes) {
    const n = closes.length;
    const rets = [];
    for (let i = 1; i < n; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    const last = closes[n - 1];
    const sma = (k) => mean(closes.slice(-k));
    const sma20 = sma(Math.min(20, n)), sma50 = sma(Math.min(50, n));
    const win = closes.slice(-20);
    const sd20 = Math.sqrt(mean(win.map(c => (c - sma20) ** 2))) || 1e-9;

    // OU mean reversion: z-score of price vs 20d mean. Oversold (z<0)
    // → high score (buy-the-dip), overbought → low. Half-life via AR(1)
    // on demeaned log price.
    const z = (last - sma20) / sd20;
    const ouScore = clip(50 - z * 20, 0, 100);
    const logs = closes.map(Math.log);
    const m = mean(logs);
    let num = 0, den = 0;
    for (let i = 1; i < logs.length; i++) { num += (logs[i] - m) * (logs[i - 1] - m); den += (logs[i - 1] - m) ** 2; }
    const phi = den > 0 ? clip(num / den, 0.01, 0.999) : 0.9;
    const halflife = Math.log(0.5) / Math.log(phi);

    // Regime (HMM proxy): trend via SMA20 vs SMA50, vol percentile splits
    // high/low-vol states. Confidence from separation strength.
    const dailyVol = Math.sqrt(mean(rets.slice(-20).map(r => r * r)));
    const annVol = dailyVol * Math.sqrt(252);
    const trendSep = (sma20 - sma50) / sma50;
    let regime, regimeConf;
    if (annVol > 0.55) { regime = 'HighVol'; regimeConf = clip(annVol, 0.5, 0.95); }
    else if (Math.abs(trendSep) < 0.01) { regime = 'LowVol'; regimeConf = 0.55; }
    else { regime = trendSep > 0 ? 'Bull' : 'Bear'; regimeConf = clip(0.5 + Math.abs(trendSep) * 8, 0.5, 0.95); }

    // Trend (Kalman proxy): normalized linear-regression slope over 20d;
    // velocity = slope now vs slope 10d ago.
    const slopeOf = (arr) => {
      const k = arr.length, xm = (k - 1) / 2, ym = mean(arr);
      let sn = 0, sdn = 0;
      for (let i = 0; i < k; i++) { sn += (i - xm) * (arr[i] - ym); sdn += (i - xm) ** 2; }
      return sdn > 0 ? (sn / sdn) / ym : 0; // per-day fractional slope
    };
    const trendNow = slopeOf(closes.slice(-20));
    const trendPrev = slopeOf(closes.slice(-30, -10));
    const velocity = trendNow - trendPrev;

    // Tail risk (EVT proxy): historical 99% VaR + expected shortfall.
    const sorted = rets.slice().sort((a, b) => a - b);
    const idx = Math.max(0, Math.floor(sorted.length * 0.01));
    const var99 = Math.abs(sorted[idx] || 0.03);
    const tail = sorted.slice(0, Math.max(1, idx + 1));
    const es = Math.abs(mean(tail));
    const evtRiskScore = clip((1 - var99 * 10) * 100, 0, 100);

    return { ouScore, halflife, z, regime, regimeConf, trendNow, velocity, var99, es, evtRiskScore, last };
  }

  // ─── Sentiment (TextBlob port → financial lexicon, fully local) ───
  const KR_POS = { beat:3, beats:3, surge:3, surges:3, soar:3, soars:3, rally:2, rallies:2, record:2, strong:2, growth:2, profit:2, profits:2, upgrade:3, upgraded:3, outperform:3, buy:2, bullish:3, gain:2, gains:2, jump:2, jumps:2, rise:1, rises:1, up:1, high:1, win:2, wins:2, expand:1, expands:1, boost:2, boosts:2, positive:2, success:2, breakthrough:3, partnership:1, dividend:1, buyback:2, exceed:3, exceeds:3, accelerate:2, momentum:1, optimism:2, recover:2, recovery:2 };
  const KR_NEG = { miss:3, misses:3, plunge:3, plunges:3, crash:3, crashes:3, fall:2, falls:2, drop:2, drops:2, weak:2, loss:2, losses:2, downgrade:3, downgraded:3, underperform:3, sell:2, bearish:3, decline:2, declines:2, slump:3, slumps:3, down:1, low:1, lawsuit:2, probe:2, investigation:2, fraud:3, layoff:2, layoffs:2, cut:1, cuts:1, warning:2, warns:2, negative:2, fear:2, fears:2, recession:2, bankruptcy:3, default:2, tumble:3, tumbles:3, sink:2, sinks:2, risk:1, risks:1, concern:1, concerns:1 };
  const KR_HEDGE = ['could','may','might','possibly','perhaps','reportedly','rumor','expects','believes','opinion','likely','potential'];
  function kronosPolarity(text) {
    if (!text) return { pol: 0, subj: 0 };
    const toks = String(text).toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
    let score = 0, hits = 0, hedges = 0, negate = false;
    for (const t of toks) {
      if (t === 'not' || t === 'no' || t === 'never' || t === "isnt" || t === "wont") { negate = true; continue; }
      let v = KR_POS[t] ? KR_POS[t] : (KR_NEG[t] ? -KR_NEG[t] : 0);
      if (KR_HEDGE.indexOf(t) !== -1) hedges++;
      if (v !== 0) { score += negate ? -v : v; hits++; }
      negate = false;
    }
    const pol = hits ? clip(score / (hits * 3), -1, 1) : 0;
    const subj = clip(hedges / Math.max(4, toks.length / 4), 0, 1);
    return { pol, subj };
  }
  // Port of score_article: headline 70%, description 30%.
  function kronosScoreArticle(headline, description) {
    const h = kronosPolarity(headline), d = kronosPolarity(description);
    const combined = 0.7 * h.pol + 0.3 * d.pol;
    const confidence = Math.min(1, Math.abs(combined) * (1 - 0.3 * h.subj));
    return { combined, confidence, subj: h.subj };
  }
  // Port of aggregate_ticker_sentiment: exp time decay, momentum = recent
  // half minus old half, direction at ±0.1.
  function kronosAggregate(scored, daysBack) {
    if (!scored.length) return { net: 0, dir: 'neutral', conf: 0, n: 0, bull: 0, bear: 0, momentum: 0 };
    const hi = scored.filter(a => a.confidence >= 0.2);
    const use = hi.length ? hi : scored;
    const now = Date.now();
    let wSum = 0, polSum = 0, confSum = 0;
    const pols = [];
    use.forEach(a => {
      const age = clip((now - a.ts) / 86400000, 0, daysBack);
      const w = Math.exp(-age / daysBack);
      wSum += w; polSum += a.combined * w; confSum += a.confidence * w;
      pols.push(a.combined);
    });
    const net = wSum ? polSum / wSum : 0;
    const conf = wSum ? confSum / wSum : 0;
    const dir = net > 0.1 ? 'bullish' : (net < -0.1 ? 'bearish' : 'neutral');
    const bull = pols.filter(p => p > 0.1).length, bear = pols.filter(p => p < -0.1).length;
    const half = Math.floor(pols.length / 2);
    const momentum = pols.length > 1 ? mean(pols.slice(0, half)) - mean(pols.slice(half)) : 0;
    return { net, dir, conf, n: use.length, bull, bear, momentum };
  }

  async function kronosFetchNews(ticker) {
    const apiKey = get(KEYS.newsKey, '');
    if (!apiKey || detectNewsProvider(apiKey) !== 'newsapi') return [];
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(ticker)}&language=en&sortBy=publishedAt&pageSize=20&apiKey=${encodeURIComponent(apiKey)}`;
    const tries = [url,
      'https://corsproxy.io/?' + encodeURIComponent(url),
      'https://api.allorigins.win/raw?url=' + encodeURIComponent(url)];
    for (const u of tries) {
      try {
        const res = await fetch(u);
        const j = await res.json();
        if (j && j.status === 'ok' && Array.isArray(j.articles)) {
          return j.articles.map(a => ({
            headline: a.title || '', description: a.description || '',
            url: a.url || '#', source: (a.source && a.source.name) || '',
            ts: a.publishedAt ? Date.parse(a.publishedAt) : Date.now(),
          }));
        }
      } catch (e) { /* try next */ }
    }
    return [];
  }

  // ─── Signal booster ports (NewsSignalBooster, weight 0.15) ───
  const KR_W = 0.15;
  function kronosBoost(quant, agg) {
    const boostedOu = clip(quant.ouScore + clip(agg.net * agg.conf * KR_W * 100, -10, 10), 0, 100);
    let hmmConf = quant.regimeConf;
    if ((quant.regime === 'Bull' && agg.net < -0.3) || (quant.regime === 'Bear' && agg.net > 0.3)) {
      hmmConf = quant.regimeConf * (0.9 - Math.abs(agg.net) * agg.conf * KR_W);
    }
    const riskMult = 1 + (-agg.net * agg.momentum) * KR_W;
    const boostedVar = clip(quant.var99 * riskMult, quant.var99 * 0.5, Math.min(0.20, quant.var99 * 2));
    return { boostedOu, hmmConf, boostedVar };
  }
  // Composite: 35% OU + 20% regime + 15% trend(+velocity) + 15% inverted risk + 15% sentiment.
  function kronosComposite(b, quant, agg) {
    const trendNorm = clip(50 + quant.trendNow * 5000, 0, 100);
    const velBoost = clip(quant.velocity * 2000, -10, 10);
    const riskNorm = clip((1 - quant.var99 * 10) * 100, 0, 100);
    const sentNorm = (agg.net + 1) * 50;
    return clip(0.35 * b.boostedOu + 0.20 * b.hmmConf * 100 + 0.15 * (trendNorm + velBoost) + 0.15 * riskNorm + 0.15 * sentNorm, 0, 100);
  }
  function kronosTradeSignal(composite, agg) {
    let sig = composite >= 75 ? 'STRONG_BUY' : composite >= 60 ? 'BUY' : composite >= 40 ? 'NEUTRAL' : composite >= 25 ? 'SELL' : 'STRONG_SELL';
    if (agg.dir === 'bearish' && (sig === 'STRONG_BUY' || sig === 'BUY')) sig = sig === 'STRONG_BUY' ? 'STRONG_SELL' : 'NEUTRAL';
    else if (agg.dir === 'bullish' && (sig === 'SELL' || sig === 'STRONG_SELL')) sig = sig === 'STRONG_SELL' ? 'STRONG_BUY' : 'NEUTRAL';
    const conf = (agg.n >= 10 && agg.conf >= 0.6) ? 'HIGH' : (agg.n >= 5 && agg.conf >= 0.3) ? 'MEDIUM' : 'LOW';
    return { sig, conf };
  }

  async function kronosScan(ticker) {
    const status = document.getElementById('kronosStatus');
    const out = document.getElementById('kronosResult');
    if (!out) return;
    const sym = String(ticker || '').trim().toUpperCase();
    if (!sym) return;
    const setKStatus = t => { if (status) status.textContent = t; };

    // 4h cache (stored under hustle_ prefix → syncs like everything else)
    const cacheAll = get(KRONOS_CACHE_KEY, {});
    const hit = cacheAll[sym];
    if (hit && (Date.now() - hit.ts) < KRONOS_TTL_MS) {
      setKStatus('CACHED · ' + new Date(hit.ts).toLocaleTimeString());
      kronosRender(hit.signal);
      return;
    }

    setKStatus('FETCHING PRICES…');
    out.innerHTML = '<div class="kronos-card" style="text-align:center;color:var(--text-tertiary);font-size:13px">Running Kronos engines on ' + escapeHtml(sym) + '…</div>';
    const closes = await kronosFetchCloses(sym);
    if (!closes) {
      setKStatus('PRICE FEED FAILED');
      out.innerHTML = '<div class="kronos-card" style="text-align:center;color:var(--accent-rose);font-size:13px">Couldn\'t load price history for ' + escapeHtml(sym) + ' — check the ticker and try again.</div>';
      return;
    }
    const quant = kronosQuant(closes);

    setKStatus('SCORING NEWS…');
    const articles = await kronosFetchNews(sym);
    const scored = articles.map(a => ({ ...a, ...kronosScoreArticle(a.headline, a.description) }));
    const agg = kronosAggregate(scored, 7);

    const b = kronosBoost(quant, agg);
    const composite = kronosComposite(b, quant, agg);
    const ts = kronosTradeSignal(composite, agg);
    const topHeadlines = scored.slice().sort((x, y) => y.confidence - x.confidence).slice(0, 3);

    const signal = { sym, quant, agg, b, composite, ts, topHeadlines, hasNews: articles.length > 0 };
    cacheAll[sym] = { ts: Date.now(), signal };
    set(KRONOS_CACHE_KEY, cacheAll);
    setKStatus('LIVE · ' + new Date().toLocaleTimeString());
    kronosRender(signal);
  }

  function kronosRender(s) {
    const out = document.getElementById('kronosResult');
    if (!out) return;
    const q = s.quant, a = s.agg;
    const sigCls = s.ts.sig.indexOf('BUY') !== -1 ? 'buy' : (s.ts.sig.indexOf('SELL') !== -1 ? 'sell' : 'neutral');
    const barColor = sigCls === 'buy' ? 'var(--accent-mint)' : sigCls === 'sell' ? 'var(--accent-rose)' : 'var(--accent-amber)';
    const dirColor = a.dir === 'bullish' ? 'var(--accent-mint)' : a.dir === 'bearish' ? 'var(--accent-rose)' : 'var(--accent-amber)';
    const fmtPct = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
    const bar = (val, color) => '<div class="kronos-bar"><div class="kronos-bar-fill" style="width:' + clip(val, 0, 100).toFixed(0) + '%;background:' + color + '"></div></div>';
    const headlines = s.topHeadlines.length
      ? s.topHeadlines.map(h => {
          const pc = h.combined > 0.05 ? 'var(--accent-mint)' : h.combined < -0.05 ? 'var(--accent-rose)' : 'var(--text-tertiary)';
          const pm = h.combined > 0.05 ? '▲' : h.combined < -0.05 ? '▼' : '◦';
          return '<div class="kronos-headline"><span class="kronos-hl-pol" style="color:' + pc + '">' + pm + ' ' + h.combined.toFixed(2) + '</span><a href="' + escapeHtml(h.url) + '" target="_blank" rel="noopener">' + escapeHtml(h.headline) + '</a></div>';
        }).join('')
      : '<div style="font-size:12px;color:var(--text-tertiary);font-style:italic;padding:8px 0">' + (s.hasNews ? 'No high-confidence headlines.' : 'No news key connected — pure quant signal. Add your NewsAPI key in the Globe tab to enable sentiment boosts.') + '</div>';

    out.innerHTML = `
      <div class="kronos-card">
        <div class="kronos-head">
          <div>
            <div style="font-family:var(--font-mono);font-size:22px;font-weight:800;letter-spacing:0.06em">${escapeHtml(s.sym)} <span style="font-size:13px;color:var(--text-tertiary)">$${q.last.toFixed(2)}</span></div>
            <div style="font-size:12px;color:var(--text-tertiary);margin-top:3px">Composite <b style="color:var(--text-primary)">${s.composite.toFixed(1)}</b> / 100 · Confidence ${s.ts.conf}</div>
          </div>
          <span class="kronos-sig ${sigCls}">${escapeHtml(s.ts.sig.replace('_', ' '))}</span>
        </div>
        ${bar(s.composite, barColor)}
        <div class="kronos-grid" style="margin-top:14px">
          <div class="kronos-engine">
            <div class="kronos-engine-h"><span>Mean Reversion · OU</span><span style="color:var(--accent-blue)">${s.b.boostedOu.toFixed(1)}</span></div>
            ${bar(s.b.boostedOu, 'var(--accent-blue)')}
            <div class="kronos-metric">Base <b>${q.ouScore.toFixed(1)}</b> → boosted <b>${s.b.boostedOu.toFixed(1)}</b><br>Z-score <b>${q.z.toFixed(2)}</b> · Half-life <b>${isFinite(q.halflife) ? q.halflife.toFixed(1) : '—'}d</b></div>
          </div>
          <div class="kronos-engine">
            <div class="kronos-engine-h"><span>Market Regime · HMM</span><span style="color:var(--accent-purple)">${q.regime}</span></div>
            ${bar(s.b.hmmConf * 100, 'var(--accent-purple)')}
            <div class="kronos-metric">Confidence <b>${(s.b.hmmConf * 100).toFixed(0)}%</b>${s.b.hmmConf < q.regimeConf ? ' <span style="color:var(--accent-amber)">(news contradicts regime)</span>' : ''}</div>
          </div>
          <div class="kronos-engine">
            <div class="kronos-engine-h"><span>Trend · Kalman</span><span style="color:${q.trendNow >= 0 ? 'var(--accent-mint)' : 'var(--accent-rose)'}">${q.trendNow >= 0 ? '↑' : '↓'} ${fmtPct(q.trendNow)}/d</span></div>
            ${bar(clip(50 + q.trendNow * 5000, 0, 100), q.trendNow >= 0 ? 'var(--accent-mint)' : 'var(--accent-rose)')}
            <div class="kronos-metric">Velocity <b>${fmtPct(q.velocity)}</b> ${q.velocity >= 0 ? '(accelerating)' : '(decelerating)'}</div>
          </div>
          <div class="kronos-engine">
            <div class="kronos-engine-h"><span>Tail Risk · EVT</span><span style="color:var(--accent-amber)">${q.evtRiskScore.toFixed(0)}</span></div>
            ${bar(q.evtRiskScore, 'var(--accent-amber)')}
            <div class="kronos-metric">VaR 99% <b>${(q.var99 * 100).toFixed(1)}%</b> → adj <b>${(s.b.boostedVar * 100).toFixed(1)}%</b> · ES <b>${(q.es * 100).toFixed(1)}%</b></div>
          </div>
        </div>
        <div class="kronos-engine" style="margin-top:12px">
          <div class="kronos-engine-h"><span>News Sentiment</span><span style="color:${dirColor};letter-spacing:0.1em">${a.dir.toUpperCase()} · ${(a.conf * 100).toFixed(0)}%</span></div>
          ${bar((a.net + 1) * 50, dirColor)}
          <div class="kronos-metric">Net <b>${a.net >= 0 ? '+' : ''}${a.net.toFixed(2)}</b> · Momentum <b>${a.momentum >= 0 ? '+' : ''}${a.momentum.toFixed(2)}</b> ${a.momentum > 0.02 ? '(improving)' : a.momentum < -0.02 ? '(deteriorating)' : '(flat)'} · <b>${a.n}</b> articles (${a.bull}▲ / ${a.bear}▼)</div>
          <div style="margin-top:8px">${headlines}</div>
        </div>
        <div style="font-size:10px;color:var(--text-quaternary);margin-top:12px;text-align:center">Quant signals are heuristics, not financial advice. Cached 4h — rescan to refresh.</div>
      </div>`;
  }

  const kronosScanBtn = document.getElementById('kronosScanBtn');
  const kronosTickerInput = document.getElementById('kronosTicker');
  const kronosQuickRow = document.getElementById('kronosQuickRow');
  if (kronosScanBtn && kronosTickerInput) {
    kronosScanBtn.addEventListener('click', () => kronosScan(kronosTickerInput.value));
    kronosTickerInput.addEventListener('keydown', e => { if (e.key === 'Enter') kronosScan(kronosTickerInput.value); });
  }
  if (kronosQuickRow) kronosQuickRow.addEventListener('click', e => {
    const btn = e.target.closest('[data-kq]');
    if (!btn) return;
    if (kronosTickerInput) kronosTickerInput.value = btn.dataset.kq;
    kronosScan(btn.dataset.kq);
  });

  // ============================================================
  // Cross-page sync hook — re-render after Supabase pulls fresh data
  // ============================================================
  window.addEventListener('supabase-hydrated', () => {
    sessionStorage.setItem('sb_session_reloaded', '1');
    try { renderBusinesses(); } catch (e) { console.error('renderBusinesses failed:', e); }
    try { renderKPIs(); } catch (e) { console.error('renderKPIs failed:', e); }
    try { renderCalendar(); } catch (e) { console.error('renderCalendar failed:', e); }
    try { renderWatchlist(); } catch (e) { console.error('renderWatchlist failed:', e); }
    try { renderGlobeFeed(); } catch (e) { console.error('renderGlobeFeed failed:', e); }
    try { updateAISummary(); } catch (e) { console.error('updateAISummary failed:', e); }
  });

  // ============================================================
  // Initial paint — wrapped so a single failure can't break the page
  // ============================================================
  try { renderBusinesses(); } catch (e) { console.error('renderBusinesses failed:', e); }
  try { renderKPIs(); } catch (e) { console.error('renderKPIs failed:', e); }
  try { renderCalendar(); } catch (e) { console.error('renderCalendar failed:', e); }

})();
