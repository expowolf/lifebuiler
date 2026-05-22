// ============================================================
// Supabase sync — shared by dashboard.html and finance.html.
//
// What it does:
//   1. Loads the Supabase JS client from CDN.
//   2. Signs in anonymously (Supabase's built-in anonymous auth,
//      so RLS works without a login screen).
//   3. Hydrates localStorage from the user's row in `user_data`.
//   4. Wraps localStorage.setItem/removeItem to detect changes and
//      debounce-push them back to Supabase as one JSON blob.
//   5. Shows a tiny pill in the top-right indicating sync status.
//
// Required Supabase setup (run once in the SQL editor):
//
//   create table public.user_data (
//     user_id    uuid primary key references auth.users(id) on delete cascade,
//     data       jsonb not null default '{}'::jsonb,
//     updated_at timestamptz not null default now()
//   );
//   alter table public.user_data enable row level security;
//   create policy "own_select" on public.user_data
//     for select using (auth.uid() = user_id);
//   create policy "own_insert" on public.user_data
//     for insert with check (auth.uid() = user_id);
//   create policy "own_update" on public.user_data
//     for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
//
// Also: in Supabase dashboard → Authentication → Providers, enable
// "Anonymous Sign-Ins". Without it, signInAnonymously() will fail.
// ============================================================
(function () {
  const SUPABASE_URL = 'https://cmycjvfegyzhzfxxakpl.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_6L-ExMekosUH-SotO-hlgg_WKNSKRpW';
  const TABLE = 'user_data';
  const DEBOUNCE_MS = 1500;

  // Whitelist of localStorage keys that should round-trip to Supabase.
  // Exact matches:
  const SYNC_KEYS = new Set([
    'goal_streak_v1',
    'subs',
    'orders',
    'wishlist',
    'nw_currency',
    'finance_active_tab',
  ]);
  // Prefix matches (catch all keys starting with these):
  const SYNC_PREFIXES = ['goals:', 'nw:', 'wish:', 'order:'];

  function shouldSync(key) {
    if (!key) return false;
    if (SYNC_KEYS.has(key)) return true;
    for (const p of SYNC_PREFIXES) if (key.indexOf(p) === 0) return true;
    return false;
  }

  function gather() {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (shouldSync(k)) out[k] = localStorage.getItem(k);
    }
    return out;
  }

  function applyRemote(data) {
    if (!data || typeof data !== 'object') return;
    // Replace the local snapshot with the server's. Remove any local
    // sync-eligible keys that aren't in the remote payload — otherwise a
    // delete on device B never propagates to device A.
    const remoteKeys = new Set(Object.keys(data));
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (shouldSync(k) && !remoteKeys.has(k)) toRemove.push(k);
    }
    toRemove.forEach(k => _origRemove(k));
    Object.keys(data).forEach(k => {
      if (shouldSync(k)) _origSet(k, data[k]);
    });
  }

  // -----------------------------------------------------------
  // Sync status pill (top-right corner)
  // -----------------------------------------------------------
  let statusEl = null;
  function ensurePill() {
    if (statusEl) return statusEl;
    statusEl = document.createElement('div');
    statusEl.id = 'sb-sync-status';
    statusEl.style.cssText = [
      'position:fixed', 'top:12px', 'right:12px',
      'padding:4px 10px', 'border-radius:999px',
      'font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace',
      'font-size:9.5px', 'font-weight:800', 'letter-spacing:0.14em',
      'text-transform:uppercase', 'z-index:1000',
      'background:rgba(0,0,0,0.55)', 'backdrop-filter:blur(8px)',
      '-webkit-backdrop-filter:blur(8px)',
      'pointer-events:none', 'transition:color 0.25s, opacity 0.25s',
      'color:rgba(255,255,255,0.45)',
    ].join(';');
    document.body.appendChild(statusEl);
    return statusEl;
  }
  function setStatus(state) {
    const el = ensurePill();
    const map = {
      connecting: { t: '○ connecting', c: 'rgba(255,255,255,0.45)' },
      syncing:    { t: '◐ syncing',    c: '#F2C063' },
      synced:     { t: '● synced',     c: '#6BE3A4' },
      offline:    { t: '○ offline',    c: 'rgba(255,138,138,0.75)' },
      error:      { t: '✕ sync error', c: '#FF8A8A' },
    };
    const cfg = map[state] || map.synced;
    el.textContent = cfg.t;
    el.style.color = cfg.c;
    if (state === 'synced') {
      setTimeout(() => { if (el.textContent === cfg.t) el.style.opacity = '0.55'; }, 1800);
    } else {
      el.style.opacity = '1';
    }
  }

  // -----------------------------------------------------------
  // Monkey-patch localStorage so existing code triggers sync
  // automatically, without needing changes in dashboard/finance.
  // -----------------------------------------------------------
  const _origSet = localStorage.setItem.bind(localStorage);
  const _origRemove = localStorage.removeItem.bind(localStorage);

  let supabase = null;
  let userId = null;
  let hydrating = false;
  let pushTimer = null;

  function schedulePush() {
    if (!supabase || !userId || hydrating) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(doPush, DEBOUNCE_MS);
  }

  localStorage.setItem = function (k, v) {
    _origSet(k, v);
    if (shouldSync(k)) schedulePush();
  };
  localStorage.removeItem = function (k) {
    _origRemove(k);
    if (shouldSync(k)) schedulePush();
  };

  async function doPush() {
    if (!supabase || !userId || hydrating) return;
    setStatus('syncing');
    try {
      const data = gather();
      const { error } = await supabase
        .from(TABLE)
        .upsert(
          { user_id: userId, data: data, updated_at: new Date().toISOString() },
          { onConflict: 'user_id' }
        );
      if (error) throw error;
      setStatus('synced');
    } catch (e) {
      console.error('[supabase-sync] push failed:', e);
      setStatus('error');
    }
  }

  async function init() {
    setStatus('connecting');
    let createClient;
    try {
      const mod = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
      createClient = mod.createClient;
    } catch (e) {
      console.error('[supabase-sync] failed to load supabase-js:', e);
      setStatus('offline');
      return;
    }

    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });

    try {
      const { data: sess } = await supabase.auth.getSession();
      if (sess && sess.session) {
        userId = sess.session.user.id;
      } else {
        const { data: anon, error } = await supabase.auth.signInAnonymously();
        if (error) throw error;
        userId = anon.user.id;
      }
    } catch (e) {
      console.error('[supabase-sync] auth failed (is anonymous sign-in enabled?):', e);
      setStatus('offline');
      return;
    }

    hydrating = true;
    let row = null;
    try {
      const res = await supabase
        .from(TABLE)
        .select('data, updated_at')
        .eq('user_id', userId)
        .maybeSingle();
      if (res.error) throw res.error;
      row = res.data;
    } catch (e) {
      console.error('[supabase-sync] select failed (check the user_data table + RLS):', e);
      hydrating = false;
      setStatus('error');
      return;
    }

    if (row && row.data && Object.keys(row.data).length) {
      applyRemote(row.data);
      hydrating = false;
      // Let the page re-render with the freshly-hydrated data.
      window.dispatchEvent(new CustomEvent('supabase-hydrated'));
      setStatus('synced');
    } else {
      hydrating = false;
      // No remote data yet — push whatever's currently local as the seed row.
      await doPush();
    }

    // Push any in-flight changes that landed during init.
    if (pushTimer) { clearTimeout(pushTimer); doPush(); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose a tiny API for manual flush if needed.
  window.__sbSync = { flush: doPush, status: () => statusEl && statusEl.textContent };
})();
