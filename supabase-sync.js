// ============================================================
// Supabase sync — shared by dashboard.html and finance.html.
//
// Auth: email magic link. Enter your email once on any device,
// click the link Supabase emails you, and all devices sharing
// that email share the same data row in user_data.
//
// Required one-time Supabase setup:
//
// 1. Authentication → Providers → Email: make sure "Email" is ON
//    and "Confirm email" can be OFF for magic-link-only flow.
//
// 2. Authentication → URL Configuration → Redirect URLs:
//    Add your production domain, e.g. https://yourdomain.vercel.app
//    (Also add http://localhost for local dev.)
//
// 3. Run this SQL in the SQL Editor:
//
//   create table if not exists public.user_data (
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
//     for update using (auth.uid() = user_id)
//     with check (auth.uid() = user_id);
// ============================================================
(function () {
  const SUPABASE_URL = 'https://cmycjvfegyzhzfxxakpl.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_6L-ExMekosUH-SotO-hlgg_WKNSKRpW';
  const TABLE        = 'user_data';
  const DEBOUNCE_MS  = 1500;

  // Keys synced to Supabase (whitelist)
  const SYNC_KEYS = new Set([
    'goal_streak_v1','subs','orders','wishlist','nw_currency','finance_active_tab',
  ]);
  const SYNC_PREFIXES = ['goals:','nw:','wish:','order:'];

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
    const remoteKeys = new Set(Object.keys(data));
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (shouldSync(k) && !remoteKeys.has(k)) toRemove.push(k);
    }
    toRemove.forEach(k => _origRemove(k));
    Object.keys(data).forEach(k => { if (shouldSync(k)) _origSet(k, data[k]); });
  }

  // ── monkey-patch localStorage ──────────────────────────────
  const _origSet    = localStorage.setItem.bind(localStorage);
  const _origRemove = localStorage.removeItem.bind(localStorage);
  let supabase = null, userId = null, hydrating = false, pushTimer = null;

  function schedulePush() {
    if (!supabase || !userId || hydrating) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(doPush, DEBOUNCE_MS);
  }
  localStorage.setItem = function(k, v) {
    _origSet(k, v);
    if (shouldSync(k)) schedulePush();
  };
  localStorage.removeItem = function(k) {
    _origRemove(k);
    if (shouldSync(k)) schedulePush();
  };

  async function doPush() {
    if (!supabase || !userId || hydrating) return;
    setStatus('syncing');
    try {
      const { error } = await supabase.from(TABLE).upsert(
        { user_id: userId, data: gather(), updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );
      if (error) throw error;
      setStatus('synced');
    } catch (e) {
      console.error('[sync] push failed:', e);
      setStatus('error');
    }
  }

  async function fetchAndHydrate() {
    const { data: row, error } = await supabase
      .from(TABLE).select('data').eq('user_id', userId).maybeSingle();
    if (error) throw error;
    if (row && row.data && Object.keys(row.data).length) {
      // Compare local vs remote BEFORE applying — if they differ, we
      // need to either re-render or hard-reload so the UI catches up.
      const beforeStr = JSON.stringify(sortedSnapshot(gather()));
      hydrating = true;
      applyRemote(row.data);
      hydrating = false;
      const afterStr = JSON.stringify(sortedSnapshot(gather()));

      window.dispatchEvent(new CustomEvent('supabase-hydrated', {
        detail: { changed: beforeStr !== afterStr },
      }));

      // Bulletproof fallback: if the page doesn't re-render itself
      // within 600ms of hydration, force a one-time reload so the user
      // actually sees their data. The session flag prevents loops.
      if (beforeStr !== afterStr) {
        const alreadyReloaded = sessionStorage.getItem('sb_session_reloaded') === '1';
        if (!alreadyReloaded) {
          setTimeout(() => {
            if (sessionStorage.getItem('sb_session_reloaded') !== '1') {
              sessionStorage.setItem('sb_session_reloaded', '1');
              window.location.reload();
            }
          }, 600);
        }
      }
    } else {
      await doPush(); // seed the row with current local data
    }
  }

  function sortedSnapshot(obj) {
    const out = {};
    Object.keys(obj).sort().forEach(k => { out[k] = obj[k]; });
    return out;
  }

  // ── status pill ────────────────────────────────────────────
  let pillEl = null;
  function pill() {
    if (pillEl) return pillEl;
    pillEl = document.createElement('button');
    pillEl.id = 'sb-sync-pill';
    pillEl.style.cssText = [
      'position:fixed','top:12px','right:12px',
      'padding:5px 11px','border-radius:999px','border:none',
      'font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace',
      'font-size:9.5px','font-weight:800','letter-spacing:0.14em',
      'text-transform:uppercase','z-index:1001',
      'background:rgba(0,0,0,0.60)','backdrop-filter:blur(10px)',
      '-webkit-backdrop-filter:blur(10px)',
      'cursor:pointer','transition:color 0.25s, opacity 0.25s',
      'color:rgba(255,255,255,0.45)',
    ].join(';');
    pillEl.addEventListener('click', () => {
      if (!userId) showLoginModal();
      else showUserModal();
    });
    document.body.appendChild(pillEl);
    return pillEl;
  }
  function setStatus(state, extra) {
    const el = pill();
    const map = {
      connecting: { t: '○ connecting',   c: 'rgba(255,255,255,0.45)' },
      syncing:    { t: '◐ syncing',       c: '#F2C063' },
      synced:     { t: '● synced',        c: '#6BE3A4' },
      offline:    { t: '○ offline',       c: 'rgba(255,138,138,0.75)' },
      error:      { t: '✕ sync error',    c: '#FF8A8A' },
      signin:     { t: '○ sign in to sync', c: '#7DD3FC' },
      sent:       { t: '✓ check email',   c: '#6BE3A4' },
    };
    const cfg = map[state] || map.synced;
    el.textContent = extra ? cfg.t + ' · ' + extra : cfg.t;
    el.style.color = cfg.c;
    el.style.opacity = '1';
    if (state === 'synced') {
      setTimeout(() => { if (el.style.color === cfg.c) el.style.opacity = '0.55'; }, 2000);
    }
  }

  // ── modal helpers ──────────────────────────────────────────
  function removeModal() {
    const m = document.getElementById('sb-modal-overlay');
    if (m) m.remove();
  }
  function makeModal(innerHTML) {
    removeModal();
    const overlay = document.createElement('div');
    overlay.id = 'sb-modal-overlay';
    overlay.style.cssText = [
      'position:fixed','inset:0','z-index:2000',
      'background:rgba(0,0,0,0.70)','backdrop-filter:blur(6px)',
      '-webkit-backdrop-filter:blur(6px)',
      'display:flex','align-items:center','justify-content:center',
      'padding:24px',
    ].join(';');
    const box = document.createElement('div');
    box.style.cssText = [
      'background:#111112','border:1px solid rgba(255,255,255,0.10)',
      'border-radius:16px','padding:28px 24px','width:100%','max-width:360px',
      'font-family:-apple-system,BlinkMacSystemFont,"Inter",sans-serif',
      'color:#FAFAFA',
    ].join(';');
    box.innerHTML = innerHTML;
    overlay.appendChild(box);
    overlay.addEventListener('click', e => { if (e.target === overlay) removeModal(); });
    document.body.appendChild(overlay);
    return box;
  }

  function showLoginModal() {
    const box = makeModal(`
      <div style="font-size:11px;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;color:#76746E;margin-bottom:16px">Sign in to sync</div>
      <div style="font-size:14px;color:#B8B6B0;line-height:1.5;margin-bottom:20px">
        Enter your email — we'll send a magic link.<br>
        Same email on any device = same data everywhere.
      </div>
      <input id="sb-email-input" type="email" placeholder="you@example.com" style="width:100%;padding:11px 14px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:10px;color:#FAFAFA;font-size:15px;font-family:inherit;outline:none;box-sizing:border-box;margin-bottom:10px" />
      <button id="sb-send-btn" style="width:100%;padding:12px;background:linear-gradient(180deg,#7DD3FC,#5BB5E8);color:#021018;font-size:14px;font-weight:700;border:none;border-radius:10px;cursor:pointer;margin-bottom:8px">Send magic link</button>
      <div id="sb-modal-msg" style="font-size:12px;color:#76746E;text-align:center;min-height:18px"></div>
    `);
    const input = box.querySelector('#sb-email-input');
    const btn   = box.querySelector('#sb-send-btn');
    const msg   = box.querySelector('#sb-modal-msg');
    setTimeout(() => input && input.focus(), 60);

    async function send() {
      const email = input.value.trim();
      if (!email || !email.includes('@')) { msg.textContent = 'Enter a valid email.'; return; }
      btn.disabled = true;
      btn.textContent = 'Sending…';
      msg.textContent = '';
      const redirectTo = window.location.origin + window.location.pathname;
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo },
      });
      if (error) {
        msg.style.color = '#FF8A8A';
        msg.textContent = error.message;
        btn.disabled = false;
        btn.textContent = 'Send magic link';
      } else {
        msg.style.color = '#6BE3A4';
        msg.textContent = '✓ Check your email and tap the link.';
        btn.textContent = 'Sent!';
        setStatus('sent');
        setTimeout(removeModal, 3000);
      }
    }
    btn.addEventListener('click', send);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  }

  function showUserModal() {
    makeModal(`
      <div style="font-size:11px;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;color:#76746E;margin-bottom:16px">Sync account</div>
      <div id="sb-user-email" style="font-size:13px;color:#B8B6B0;margin-bottom:20px;font-family:ui-monospace,monospace">Loading…</div>
      <button id="sb-pull-btn" style="width:100%;padding:12px;background:linear-gradient(180deg,#7DD3FC,#5BB5E8);color:#021018;font-size:14px;font-weight:700;border:none;border-radius:10px;cursor:pointer;margin-bottom:8px">↓ Pull latest from cloud</button>
      <button id="sb-push-btn" style="width:100%;padding:11px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.10);color:#FAFAFA;font-size:13px;font-weight:700;border-radius:10px;cursor:pointer;margin-bottom:14px">↑ Push my data to cloud</button>
      <div id="sb-sync-msg" style="font-size:12px;color:#76746E;text-align:center;min-height:18px;margin-bottom:14px"></div>
      <button id="sb-signout-btn" style="width:100%;padding:11px;background:rgba(255,107,107,0.10);border:1px solid rgba(255,107,107,0.25);color:#FF8A8A;font-size:13px;font-weight:700;border-radius:10px;cursor:pointer;margin-bottom:8px">Sign out</button>
      <button id="sb-close-btn" style="width:100%;padding:11px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.10);color:#B8B6B0;font-size:13px;font-weight:700;border-radius:10px;cursor:pointer">Close</button>
    `);
    supabase.auth.getUser().then(({ data }) => {
      const el = document.getElementById('sb-user-email');
      if (el && data && data.user) el.textContent = '● ' + (data.user.email || 'signed in');
    });
    const msg = document.getElementById('sb-sync-msg');
    document.getElementById('sb-close-btn').addEventListener('click', removeModal);
    document.getElementById('sb-pull-btn').addEventListener('click', async () => {
      msg.style.color = '#76746E';
      msg.textContent = 'Pulling…';
      try {
        await fetchAndHydrate();
        msg.style.color = '#6BE3A4';
        msg.textContent = '✓ Pulled. Reloading…';
        sessionStorage.removeItem('sb_session_reloaded');
        setTimeout(() => window.location.reload(), 500);
      } catch (e) {
        msg.style.color = '#FF8A8A';
        msg.textContent = 'Pull failed: ' + (e.message || e);
      }
    });
    document.getElementById('sb-push-btn').addEventListener('click', async () => {
      msg.style.color = '#76746E';
      msg.textContent = 'Pushing…';
      try {
        await doPush();
        msg.style.color = '#6BE3A4';
        msg.textContent = '✓ Pushed everything on this device to the cloud.';
      } catch (e) {
        msg.style.color = '#FF8A8A';
        msg.textContent = 'Push failed: ' + (e.message || e);
      }
    });
    document.getElementById('sb-signout-btn').addEventListener('click', async () => {
      await supabase.auth.signOut();
      userId = null;
      sessionStorage.removeItem('sb_session_reloaded');
      removeModal();
      window.location.replace('signin.html');
    });
  }

  // ── main init ──────────────────────────────────────────────
  async function init() {
    setStatus('connecting');
    let createClient;
    try {
      ({ createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'));
    } catch (e) {
      console.error('[sync] failed to load supabase-js:', e);
      setStatus('offline');
      return;
    }

    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true, // handles magic-link redirect hash
      },
    });

    // Handle the magic link redirect: Supabase fires onAuthStateChange
    // with SIGNED_IN right after it processes the URL hash.
    supabase.auth.onAuthStateChange(async (event, session) => {
      if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && session) {
        const newId = session.user.id;
        if (newId !== userId) {
          userId = newId;
          setStatus('connecting');
          try {
            await fetchAndHydrate();
            setStatus('synced');
          } catch (e) {
            console.error('[sync] hydrate after sign-in failed:', e);
            setStatus('error');
          }
        }
      }
      if (event === 'SIGNED_OUT') {
        userId = null;
        setStatus('signin');
      }
    });

    // Check for an existing session (returning visitor)
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      userId = session.user.id;
      try {
        await fetchAndHydrate();
        setStatus('synced');
      } catch (e) {
        console.error('[sync] init hydrate failed:', e);
        setStatus('error');
      }
    } else {
      // Not signed in — redirect to sign-in page
      window.location.replace('signin.html');
    }

    if (pushTimer) { clearTimeout(pushTimer); doPush(); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.__sbSync = { flush: doPush, status: () => pillEl && pillEl.textContent };
})();
