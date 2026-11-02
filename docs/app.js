import { CONFIG } from './config.js';
import { stepLine, pairedBars, hideTip } from './charts.js';

const sb = window.supabase.createClient(CONFIG.url, CONFIG.key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

const app = document.getElementById('app');
const state = { profile: null, view: null };

const TYPES = { allowance: 'Taschengeld', deposit: 'Einzahlung', withdrawal: 'Auszahlung', adjustment: 'Anpassung' };
const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const MONTHS_LONG = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

// ------------------------------------------------------------------ helpers

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cents = (n) => Math.round(Number(n) * 100);
const moneyFmt = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const chf = (c) => `${moneyFmt.format(c / 100)} CHF`;
const signed = (c) => `${c > 0 ? '+' : c < 0 ? '−' : ''}${moneyFmt.format(Math.abs(c) / 100)} CHF`;
const fmtDate = (d) => d.split('-').reverse().join('.');
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(new Date());

function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const weekday = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();

function nextAllowance(setting) {
  if (!setting) return null;
  const from = setting.paid_through > addDays(setting.start_date, -1) ? setting.paid_through : addDays(setting.start_date, -1);
  return addDays(from, 7 - weekday(from));
}

async function q(promise) {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data;
}

function toast(message) {
  const el = document.getElementById('toast');
  el.innerHTML = `<div>${esc(message)}</div>`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.innerHTML = ''; }, 3200);
}

function parseAmount(raw) {
  const n = Number(String(raw).replace(/['’\s]/g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n === 0) throw new Error('Bitte einen gültigen Betrag eingeben.');
  return Math.round(n * 100) / 100;
}

// Deposits are always positive and withdrawals always negative; other types keep the typed sign.
function signedAmount(type, raw) {
  const n = parseAmount(raw);
  if (type === 'withdrawal') return -Math.abs(n);
  if (type === 'deposit') return Math.abs(n);
  return n;
}

async function fetchTransactions(childId) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const page = await q(sb.from('transactions').select('id,child_id,date,type,description,amount')
      .eq('child_id', childId).order('date', { ascending: false }).order('id', { ascending: false })
      .range(from, from + 999));
    all.push(...page);
    if (page.length < 1000) return all;
  }
}

// ------------------------------------------------------------------ dialogs

function formDialog({ title, intro, fields, submit = 'Speichern', onSubmit }) {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<form class="form-grid" novalidate>
    <h2>${esc(title)}</h2>
    ${intro ? `<p class="hint" style="margin:0">${esc(intro)}</p>` : ''}
    ${fields.map((f) => `<label class="field">${esc(f.label)}
      ${f.options
        ? `<select name="${f.name}">${f.options.map(([v, l]) => `<option value="${esc(v)}" ${String(f.value) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`
        : `<input name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" ${f.inputmode ? `inputmode="${f.inputmode}"` : ''} ${f.autocomplete ? `autocomplete="${f.autocomplete}"` : ''} ${f.maxlength ? `maxlength="${f.maxlength}"` : ''}>`}
      ${f.hint ? `<span class="hint" style="font-weight:400">${esc(f.hint)}</span>` : ''}
    </label>`).join('')}
    <div class="error" hidden></div>
    <div class="dialog-actions">
      <button type="button" class="btn" data-cancel>Abbrechen</button>
      <button type="submit" class="btn primary">${esc(submit)}</button>
    </div>
  </form>`;
  document.body.append(dlg);
  const form = dlg.querySelector('form');
  const err = dlg.querySelector('.error');
  dlg.querySelector('[data-cancel]').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => dlg.remove());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    err.hidden = true;
    try {
      await onSubmit(Object.fromEntries(new FormData(form)));
      dlg.close();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
  dlg.showModal();
}

function confirmDialog(title, text, label, onYes) {
  formDialog({ title, intro: text, fields: [], submit: label, onSubmit: onYes });
}

// ------------------------------------------------------------------ session and routing

async function loadProfile() {
  const { data } = await sb.auth.getSession();
  if (!data.session) return null;
  const uid = data.session.user.id;
  return q(sb.from('profiles').select('user_id,username,role,child_id').eq('user_id', uid).maybeSingle());
}

async function needsMfa() {
  const { data } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  return data && data.nextLevel === 'aal2' && data.currentLevel !== 'aal2';
}

async function route() {
  hideTip();
  try {
    const { data } = await sb.auth.getSession();
    if (!data.session) { state.profile = null; return renderLogin(); }
    if (await needsMfa()) return renderMfa();
    state.profile = await loadProfile();
    if (!state.profile) {
      return renderMessage('Dieses Konto ist noch nicht freigeschaltet. Bitte den Administrator fragen.');
    }
    const [path, arg] = location.hash.replace(/^#\/?/, '').split('/');
    const isChild = state.profile.role === 'child';
    if (path === 'einstellungen') return await renderSettings();
    if (path === 'verwaltung' && state.profile.role === 'admin') return await renderAdmin();
    if (isChild) return await renderChild(state.profile.child_id);
    if (path === 'kind' && arg) return await renderChild(Number(arg));
    return await renderOverview();
  } catch (ex) {
    renderMessage(`Das hat nicht geklappt: ${ex.message}`);
  }
}

function shell(content, active) {
  const p = state.profile;
  const links = p.role === 'child'
    ? [['', 'Mein Konto', 'home']]
    : [['', 'Übersicht', 'home'], ...(p.role === 'admin' ? [['verwaltung', 'Verwaltung', 'admin']] : [])];
  app.innerHTML = `<header class="topbar"><div class="topbar-in">
      <a class="brand" href="#/"><img class="brand-mark" src="icons/icon-192.png" alt="">KidsBank</a>
      <nav style="display:flex;gap:2px">
        ${links.map(([h, l, k]) => `<a class="nav-link ${active === k ? 'on' : ''}" href="#/${h}">${l}</a>`).join('')}
        <a class="nav-link ${active === 'settings' ? 'on' : ''}" href="#/einstellungen">Profil</a>
      </nav>
    </div></header>
    <main>${content}</main>`;
}

function renderMessage(text) {
  app.innerHTML = `<div class="auth"><div class="auth-card">
    <div class="auth-brand"><img class="brand-mark" src="icons/icon-192.png" alt="">KidsBank</div>
    <p>${esc(text)}</p>
    <button class="btn" data-act="logout">Abmelden</button>
  </div></div>`;
}

// ------------------------------------------------------------------ login

function renderLogin() {
  app.innerHTML = `<div class="auth"><form class="auth-card form-grid" id="login">
    <div>
      <div class="auth-brand"><img class="brand-mark" src="icons/icon-192.png" alt="">KidsBank</div>
      <div class="muted small">Das Taschengeld-Konto der Familie</div>
    </div>
    <label class="field">Benutzername<input name="username" autocomplete="username" autocapitalize="none" required></label>
    <label class="field">Passwort<input name="password" type="password" autocomplete="current-password" required></label>
    <div class="error" hidden></div>
    <button class="btn primary">Anmelden</button>
  </form></div>`;
  const form = document.getElementById('login');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { username, password } = Object.fromEntries(new FormData(form));
    const err = form.querySelector('.error');
    const btn = form.querySelector('button');
    btn.disabled = true;
    err.hidden = true;
    const email = `${username.trim().toLowerCase()}@${CONFIG.emailDomain}`;
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      err.textContent = 'Benutzername oder Passwort stimmt nicht.';
      err.hidden = false;
      btn.disabled = false;
      return;
    }
    location.hash = '#/';
    route();
  });
}

function renderMfa() {
  app.innerHTML = `<div class="auth"><form class="auth-card form-grid" id="mfa">
    <div>
      <div class="auth-brand"><img class="brand-mark" src="icons/icon-192.png" alt="">KidsBank</div>
      <div class="muted small">Bitte den 6-stelligen Code aus der Authenticator-App eingeben.</div>
    </div>
    <label class="field">Code<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label>
    <div class="error" hidden></div>
    <button class="btn primary">Bestätigen</button>
    <button type="button" class="btn" data-act="logout">Abmelden</button>
  </form></div>`;
  const form = document.getElementById('mfa');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = form.querySelector('.error');
    err.hidden = true;
    try {
      const factors = await q(sb.auth.mfa.listFactors());
      const factor = factors.totp[0];
      await q(sb.auth.mfa.challengeAndVerify({ factorId: factor.id, code: new FormData(form).get('code').trim() }));
      route();
    } catch {
      err.textContent = 'Der Code stimmt nicht. Bitte erneut versuchen.';
      err.hidden = false;
    }
  });
}

// ------------------------------------------------------------------ overview for parents and admin

async function renderOverview() {
  const [balances, requests, settings] = await Promise.all([
    q(sb.from('child_balances').select('*').order('name')),
    q(sb.from('requests').select('*').eq('status', 'pending').order('created_at')),
    q(sb.from('allowance_settings').select('*')),
  ]);
  const names = Object.fromEntries(balances.map((b) => [b.child_id, b.name]));
  shell(`
    <div class="page-head"><h1>Übersicht</h1></div>
    <div class="grid-2">
      ${balances.map((b) => {
        const s = settings.find((x) => x.child_id === b.child_id);
        const open = requests.filter((r) => r.child_id === b.child_id).length;
        return `<a class="card child-card" href="#/kind/${b.child_id}">
          <div class="child-name">${esc(b.name)}</div>
          <div class="child-balance">${chf(cents(b.balance))}</div>
          <div class="small muted">${s ? `${chf(cents(s.weekly_amount))} pro Woche` : 'Kein Taschengeld eingerichtet'}${open ? ` · ${open} offene ${open === 1 ? 'Anfrage' : 'Anfragen'}` : ''}</div>
        </a>`;
      }).join('') || '<div class="card empty">Keine Kinder zugewiesen.</div>'}
    </div>
    ${requests.length ? `<section class="card"><h2>Offene Anfragen</h2>${requests.map((r) => requestRow(r, names[r.child_id], true)).join('')}</section>` : ''}
  `, 'home');
}

function requestRow(r, childName, canDecide) {
  const own = state.profile.role === 'child';
  const c = r.kind === 'withdrawal' ? -cents(r.amount) : cents(r.amount);
  return `<div class="row">
    <div class="row-main">
      <div class="row-title">${esc(r.description)}</div>
      <div class="row-sub">${childName ? `${esc(childName)} · ` : ''}${TYPES[r.kind]} · ${fmtDate(r.created_at.slice(0, 10))}</div>
    </div>
    <div class="amount">${signed(c)}</div>
    <div class="btns">
      ${canDecide ? `<button class="btn sm primary" data-act="approve" data-id="${r.id}">Genehmigen</button>
        <button class="btn sm" data-act="reject" data-id="${r.id}">Ablehnen</button>` : ''}
      ${own ? `<button class="btn sm" data-act="withdraw-request" data-id="${r.id}">Zurückziehen</button>` : ''}
    </div>
  </div>`;
}

// ------------------------------------------------------------------ child account

async function renderChild(childId) {
  const [child, txs, settings, requests, goals] = await Promise.all([
    q(sb.from('children').select('*').eq('id', childId).maybeSingle()),
    fetchTransactions(childId),
    q(sb.from('allowance_settings').select('*').eq('child_id', childId).maybeSingle()),
    q(sb.from('requests').select('*').eq('child_id', childId).eq('status', 'pending').order('created_at')),
    q(sb.from('goals').select('*').eq('child_id', childId).order('created_at')),
  ]);
  if (!child) return renderMessage('Dieses Konto wurde nicht gefunden.');
  const years = [...new Set(txs.map((t) => t.date.slice(0, 4)))];
  const prev = state.view?.childId === childId ? state.view : {};
  state.view = {
    childId, child, txs, settings, requests, goals, years,
    balance: txs.reduce((sum, t) => sum + cents(t.amount), 0),
    tab: prev.tab || 'verlauf',
    filter: prev.filter || { year: '', type: '', dir: '' },
    statYear: prev.statYear || years[0] || today().slice(0, 4),
  };
  paintChild();
}

function paintChild() {
  const v = state.view;
  const { role } = state.profile;
  const isChild = role === 'child';
  const isAdmin = role === 'admin';
  const next = nextAllowance(v.settings);
  shell(`
    ${isChild ? '' : `<a href="#/" class="small" style="text-decoration:none">← Übersicht</a>`}
    <section class="hero">
      <div>
        <div class="hero-label">${isChild ? 'Mein Guthaben' : `Guthaben von ${esc(v.child.name)}`}</div>
        <div class="hero-amount">${chf(v.balance)}</div>
        <div class="hero-sub">${next ? `Nächstes Taschengeld: ${signed(cents(v.settings.weekly_amount))} am Sonntag, ${fmtDate(next)}` : 'Kein Taschengeld eingerichtet'}</div>
      </div>
      <div class="btns">
        ${isChild ? '<button class="btn" data-act="new-request">Geld anfragen</button>' : ''}
        ${isAdmin ? '<button class="btn" data-act="new-tx">Buchung hinzufügen</button>' : ''}
      </div>
    </section>
    ${v.requests.length ? `<section class="card"><h2>Offene Anfragen</h2>
      ${v.requests.map((r) => requestRow(r, null, !isChild)).join('')}</section>` : ''}
    ${goalsCard(isChild || isAdmin)}
    <div class="tabs" role="tablist">
      <button class="tab ${v.tab === 'verlauf' ? 'on' : ''}" data-act="tab" data-tab="verlauf">Verlauf</button>
      <button class="tab ${v.tab === 'statistik' ? 'on' : ''}" data-act="tab" data-tab="statistik">Statistik</button>
    </div>
    <div id="tab-body"></div>
  `, 'home');
  if (v.tab === 'verlauf') paintHistory(); else paintStats();
}

function goalsCard(canEdit) {
  const v = state.view;
  if (!v.goals.length && !canEdit) return '';
  const weekly = v.settings ? cents(v.settings.weekly_amount) : 0;
  return `<section class="card">
    <div class="card-head" style="${v.goals.length ? '' : 'margin-bottom:0'}"><h2>Sparziele</h2>
      ${canEdit ? '<button class="btn sm" data-act="new-goal">Ziel hinzufügen</button>' : ''}</div>
    ${v.goals.map((g) => {
      const target = cents(g.target_amount);
      const have = Math.max(0, Math.min(v.balance, target));
      const missing = target - v.balance;
      const weeks = missing > 0 && weekly ? Math.ceil(missing / weekly) : null;
      return `<div class="row"><div class="row-main">
          <div style="display:flex;justify-content:space-between;gap:12px">
            <span class="row-title">${esc(g.name)}</span>
            <span class="amount" style="font-weight:520">${chf(have)} / ${chf(target)}</span>
          </div>
          <div class="progress"><i style="width:${(have / target * 100).toFixed(1)}%"></i></div>
          <div class="row-sub" style="margin-top:4px">${missing <= 0 ? 'Ziel erreicht' : `Noch ${chf(missing)}${weeks ? `, mit Taschengeld etwa ${weeks} ${weeks === 1 ? 'Woche' : 'Wochen'}` : ''}`}</div>
        </div>
        ${canEdit ? `<button class="icon-btn" data-act="delete-goal" data-id="${g.id}" aria-label="Ziel löschen">Löschen</button>` : ''}
      </div>`;
    }).join('')}
  </section>`;
}

function paintHistory() {
  const v = state.view;
  const f = v.filter;
  const isAdmin = state.profile.role === 'admin';
  const list = v.txs.filter((t) => (!f.year || t.date.startsWith(f.year))
    && (!f.type || t.type === f.type)
    && (!f.dir || (f.dir === 'in' ? t.amount > 0 : t.amount < 0)));
  const sel = (name, value, opts) => `<select data-filter="${name}" aria-label="${name}">
    ${opts.map(([val, label]) => `<option value="${val}" ${val === value ? 'selected' : ''}>${label}</option>`).join('')}</select>`;

  let lastMonth = '';
  const shown = list.slice(0, v.showAll ? list.length : 100);
  const rows = shown.map((t) => {
    const month = t.date.slice(0, 7);
    let head = '';
    if (month !== lastMonth) {
      lastMonth = month;
      const m = Number(month.slice(5)) - 1;
      head = `<div class="month-head"><span>${MONTHS_LONG[m]} ${month.slice(0, 4)}</span></div>`;
    }
    const c = cents(t.amount);
    return `${head}<div class="row">
      <div class="row-main">
        <div class="row-title">${esc(t.description.replace(/ - \d{2}\.\d{2}\.\d{4}$/, ''))}</div>
        <div class="row-sub">${fmtDate(t.date)} · ${TYPES[t.type]}</div>
      </div>
      <div class="amount ${c > 0 ? 'pos' : ''}">${signed(c)}</div>
      ${isAdmin ? `<div class="row-actions">
        <button class="icon-btn" data-act="edit-tx" data-id="${t.id}">Ändern</button>
        <button class="icon-btn" data-act="delete-tx" data-id="${t.id}">Löschen</button>
      </div>` : ''}
    </div>`;
  }).join('');

  document.getElementById('tab-body').innerHTML = `<section class="card">
    <div class="filters">
      ${sel('year', f.year, [['', 'Alle Jahre'], ...v.years.map((y) => [y, y])])}
      ${sel('type', f.type, [['', 'Alle Arten'], ...Object.entries(TYPES)])}
      ${sel('dir', f.dir, [['', 'Alle Beträge'], ['in', 'Nur Eingänge'], ['out', 'Nur Ausgaben']])}
    </div>
    ${rows || '<div class="empty">Keine Buchungen gefunden.</div>'}
    ${list.length > shown.length ? `<div style="text-align:center;margin-top:12px"><button class="btn sm" data-act="show-all">Alle ${list.length} Buchungen anzeigen</button></div>` : ''}
    <div style="margin-top:12px"><button class="btn sm" data-act="export-csv">Als CSV herunterladen</button></div>
  </section>`;
}

function paintStats() {
  const v = state.view;
  const year = v.statYear;
  const asc = [...v.txs].reverse();
  const inYear = asc.filter((t) => t.date.startsWith(year));
  const carry = asc.filter((t) => t.date < `${year}-01-01`).reduce((s, t) => s + cents(t.amount), 0);
  const income = inYear.filter((t) => t.amount > 0).reduce((s, t) => s + cents(t.amount), 0);
  const spending = -inYear.filter((t) => t.amount < 0).reduce((s, t) => s + cents(t.amount), 0);

  const months = MONTHS.map((label, i) => ({ label, income: 0, spending: 0, i }));
  inYear.forEach((t) => {
    const m = months[Number(t.date.slice(5, 7)) - 1];
    if (t.amount > 0) m.income += cents(t.amount); else m.spending -= cents(t.amount);
  });

  document.getElementById('tab-body').innerHTML = `
    <div class="form-grid">
      <label class="field" style="max-width:160px">Jahr
        <select data-stat-year>${v.years.map((y) => `<option ${y === year ? 'selected' : ''}>${y}</option>`).join('')}</select>
      </label>
      <div class="stats">
        <div class="card"><div class="stat-label">Eingänge ${year}</div><div class="stat-value">${chf(income)}</div></div>
        <div class="card"><div class="stat-label">Ausgaben ${year}</div><div class="stat-value">${chf(spending)}</div></div>
        <div class="card"><div class="stat-label">Veränderung ${year}</div><div class="stat-value">${signed(income - spending)}</div></div>
      </div>
      <section class="card"><h2>Guthaben im Verlauf</h2><div class="chart" id="c-line"></div></section>
      <section class="card">
        <h2>Eingänge und Ausgaben pro Monat</h2>
        <div class="legend"><span><i style="background:var(--series-1)"></i>Eingänge</span><span><i style="background:var(--series-2)"></i>Ausgaben</span></div>
        <div class="chart" id="c-bars"></div>
        <details><summary>Als Tabelle anzeigen</summary>
          <table class="data"><thead><tr><th>Monat</th><th>Eingänge</th><th>Ausgaben</th></tr></thead><tbody>
            ${months.map((m) => `<tr><td>${MONTHS_LONG[m.i]}</td><td>${chf(m.income)}</td><td>${chf(m.spending)}</td></tr>`).join('')}
          </tbody></table>
        </details>
      </section>
    </div>`;

  if (!inYear.length) {
    document.getElementById('c-line').innerHTML = '<div class="empty">Keine Buchungen in diesem Jahr.</div>';
    document.getElementById('c-bars').innerHTML = '<div class="empty">Keine Buchungen in diesem Jahr.</div>';
    return;
  }

  const start = Date.UTC(Number(year), 0, 1);
  const span = Date.UTC(Number(year) + 1, 0, 1) - start;
  const pos = (iso) => (Date.parse(`${iso}T00:00:00Z`) - start) / span;
  let run = carry;
  const points = [{ x: 0, y: carry / 100, label: `<b>${chf(carry)}</b><br>Übertrag aus dem Vorjahr` }];
  const seen = new Map();
  inYear.forEach((t) => {
    run += cents(t.amount);
    seen.set(t.date, run);
  });
  seen.forEach((value, date) => {
    points.push({ x: pos(date), y: value / 100, label: `<b>${chf(value)}</b><br>${fmtDate(date)}` });
  });
  const xLabels = MONTHS.map((label, i) => ({ label, x: (Date.UTC(Number(year), i, 15) - start) / span }))
    .filter((_, i) => window.innerWidth > 520 || i % 2 === 0);
  stepLine(document.getElementById('c-line'), points, xLabels);
  pairedBars(document.getElementById('c-bars'), months.map((m) => ({
    label: window.innerWidth > 520 ? m.label : m.label[0],
    income: m.income / 100,
    spending: m.spending / 100,
    tip: `<b>${MONTHS_LONG[m.i]} ${year}</b><br>Eingänge ${chf(m.income)}<br>Ausgaben ${chf(m.spending)}`,
  })));
}

function exportCsv() {
  const v = state.view;
  const quote = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const lines = [['Datum', 'Art', 'Beschreibung', 'Betrag CHF'].join(';')];
  v.txs.forEach((t) => lines.push([fmtDate(t.date), TYPES[t.type], quote(t.description), Number(t.amount).toFixed(2)].join(';')));
  const url = URL.createObjectURL(new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `kidsbank-${v.child.name}-${today()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function txForm(tx) {
  const v = state.view;
  const isEdit = Boolean(tx);
  formDialog({
    title: isEdit ? 'Buchung ändern' : 'Buchung hinzufügen',
    submit: isEdit ? 'Speichern' : 'Hinzufügen',
    fields: [
      { name: 'type', label: 'Art', value: tx?.type || 'withdrawal', options: Object.entries(TYPES) },
      { name: 'description', label: 'Beschreibung', value: tx?.description, maxlength: 200 },
      { name: 'amount', label: 'Betrag in CHF', value: tx ? Math.abs(tx.amount).toFixed(2) : '', inputmode: 'decimal', hint: 'Auszahlungen werden automatisch abgezogen. Bei Anpassungen und Taschengeld zählt das eingegebene Vorzeichen.' },
      { name: 'date', label: 'Datum', type: 'date', value: tx?.date || today() },
    ],
    onSubmit: async (d) => {
      if (!d.description.trim()) throw new Error('Bitte eine Beschreibung eingeben.');
      if (!d.date) throw new Error('Bitte ein Datum wählen.');
      let amount = signedAmount(d.type, d.amount);
      // Editing a correction entry must not flip its sign when the amount field shows the absolute value.
      if (isEdit && tx.amount < 0 && amount > 0 && ['allowance', 'adjustment'].includes(d.type)) amount = -amount;
      const row = { type: d.type, description: d.description.trim(), amount, date: d.date };
      if (isEdit) await q(sb.from('transactions').update(row).eq('id', tx.id));
      else await q(sb.from('transactions').insert({ ...row, child_id: v.childId }));
      toast('Gespeichert');
      route();
    },
  });
}

// ------------------------------------------------------------------ admin

async function renderAdmin() {
  const [children, settings, users, balances, security, notes] = await Promise.all([
    q(sb.from('children').select('*').order('name')),
    q(sb.from('allowance_settings').select('*')),
    q(sb.from('profiles').select('*').order('username')),
    q(sb.from('child_balances').select('*')),
    q(sb.rpc('admin_user_security')),
    q(sb.from('notifications').select('id,status,sent_via,created_at,last_error').order('id', { ascending: false }).range(0, 19)),
  ]);
  const factors = await q(sb.auth.mfa.listFactors());
  const has2fa = factors.totp.some((f) => f.status === 'verified');
  state.adminData = { children, settings, users, balances };
  const twoFa = new Set((security || []).filter((x) => x.has_2fa).map((x) => x.user_id));
  const failed = notes.filter((n) => n.status === 'failed');
  const waiting = notes.filter((n) => n.status === 'pending' || n.status === 'sending');
  const last = notes.find((n) => n.status === 'sent');
  shell(`
    <div class="page-head"><h1>Verwaltung</h1></div>
    ${has2fa ? '' : `<section class="card" style="border-color:var(--gold)">
      <div class="card-head" style="margin:0"><div><h2>Zwei-Faktor-Schutz fehlt</h2>
      <div class="small muted">Schütze das Admin-Konto mit einem Code aus der Authenticator-App.</div></div>
      <a class="btn" href="#/einstellungen" style="text-decoration:none">Einrichten</a></div></section>`}
    <section class="card"><h2>Taschengeld</h2>
      ${children.map((c) => {
        const s = settings.find((x) => x.child_id === c.id);
        return `<div class="row"><div class="row-main">
            <div class="row-title">${esc(c.name)}</div>
            <div class="row-sub">${s ? `${chf(cents(s.weekly_amount))} pro Woche, jeweils sonntags, nächste Zahlung ${fmtDate(nextAllowance(s))}` : 'Pausiert'}</div>
          </div>
          <div class="btns">
            <button class="btn sm" data-act="edit-allowance" data-id="${c.id}">${s ? 'Ändern' : 'Einrichten'}</button>
            ${s ? `<button class="btn sm danger" data-act="stop-allowance" data-id="${c.id}">Pausieren</button>` : ''}
          </div></div>`;
      }).join('')}
    </section>
    <section class="card"><h2>Benutzer</h2>
      ${users.map((u) => `<div class="row"><div class="row-main">
          <div class="row-title">${esc(u.username)}</div>
          <div class="row-sub">${{ admin: 'Administrator', parent: 'Elternteil', child: 'Kind' }[u.role]} · ${u.phone ? esc(u.phone) : 'Keine WhatsApp-Nummer'} · 2FA ${twoFa.has(u.user_id) ? 'aktiv' : 'aus'}</div>
        </div>
        <div class="btns">
          <button class="btn sm" data-act="edit-phone" data-id="${u.user_id}">Nummer</button>
          ${u.user_id === state.profile.user_id ? '' : `<button class="btn sm" data-act="reset-password" data-id="${u.user_id}">Passwort</button>`}
          ${u.user_id !== state.profile.user_id && twoFa.has(u.user_id) ? `<button class="btn sm danger" data-act="reset-2fa" data-id="${u.user_id}">2FA zurücksetzen</button>` : ''}
        </div>
      </div>`).join('')}
      <p class="hint" style="margin:12px 0 0">Neue Benutzer werden im Supabase-Dashboard angelegt.</p>
    </section>
    <section class="card"><h2>WhatsApp-Nachrichten</h2>
      <p class="small" style="margin:0">${last ? `Zuletzt gesendet am ${fmtDate(last.created_at.slice(0, 10))} über ${esc(last.sent_via)}.` : 'Noch nichts gesendet.'}${waiting.length ? ` ${waiting.length} warten auf den Versand.` : ''}</p>
      ${failed.length ? `<p class="error" style="margin:8px 0 0">${failed.length} von den letzten ${notes.length} konnten nicht gesendet werden.</p>` : ''}
    </section>
  `, 'admin');
}

// ------------------------------------------------------------------ account settings

async function renderSettings() {
  const { role } = state.profile;
  const factors = await q(sb.auth.mfa.listFactors());
  const active = factors.totp.find((f) => f.status === 'verified');
  const advice = { admin: 'Für das Admin-Konto dringend empfohlen.', parent: 'Empfohlen, weil dieses Konto Anfragen genehmigen kann.', child: 'Freiwillig. Wenn dein Handy verloren geht, kann der Administrator den Schutz zurücksetzen.' }[role];
  const mfa = `<section class="card"><h2>Zwei-Faktor-Schutz</h2>
    ${active
      ? `<p class="small" style="margin:0 0 12px">Aktiv. Beim Anmelden wird ein Code aus der Authenticator-App verlangt.</p>
         <button class="btn danger" data-act="mfa-off" data-id="${active.id}">Deaktivieren</button>`
      : `<p class="small" style="margin:0 0 12px">Nicht aktiv. ${advice}</p>
         <button class="btn primary" data-act="mfa-on">Einrichten</button>`}
  </section>`;
  shell(`
    <div class="page-head"><h1>Profil</h1></div>
    <section class="card">
      <div class="card-head" style="margin:0">
        <div><h2>${esc(state.profile.username)}</h2></div>
        <div class="btns">
          <button class="btn" data-act="change-password">Passwort ändern</button>
          <button class="btn" data-act="logout">Abmelden</button>
        </div>
      </div>
    </section>
    ${mfa}
  `, 'settings');
}

async function startMfaEnroll() {
  // Clean up an earlier setup that was never finished, otherwise enrolling fails.
  const factors = await q(sb.auth.mfa.listFactors());
  for (const f of factors.all.filter((x) => x.status === 'unverified')) {
    await q(sb.auth.mfa.unenroll({ factorId: f.id }));
  }
  const enrolled = await q(sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'KidsBank' }));
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<form class="form-grid" novalidate>
    <h2>Zwei-Faktor-Schutz einrichten</h2>
    <p class="hint" style="margin:0">QR-Code mit der Authenticator-App scannen und den Code eingeben.</p>
    <img class="qr" alt="QR-Code für die Authenticator-App" src="${esc(enrolled.totp.qr_code)}">
    <p class="hint" style="margin:0">Oder manuell: <code class="secret">${esc(enrolled.totp.secret)}</code></p>
    <label class="field">Code<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></label>
    <div class="error" hidden></div>
    <div class="dialog-actions">
      <button type="button" class="btn" data-cancel>Abbrechen</button>
      <button type="submit" class="btn primary">Aktivieren</button>
    </div></form>`;
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.querySelector('[data-cancel]').addEventListener('click', () => dlg.close());
  dlg.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = dlg.querySelector('.error');
    try {
      await q(sb.auth.mfa.challengeAndVerify({ factorId: enrolled.id, code: new FormData(e.target).get('code').trim() }));
      dlg.close();
      toast('Zwei-Faktor-Schutz ist aktiv');
      route();
    } catch {
      err.textContent = 'Der Code stimmt nicht. Bitte erneut versuchen.';
      err.hidden = false;
    }
  });
  dlg.showModal();
}

// ------------------------------------------------------------------ actions

const actions = {
  logout: async () => { await sb.auth.signOut(); state.view = null; location.hash = '#/'; route(); },
  tab: (el) => { state.view.tab = el.dataset.tab; hideTip(); paintChild(); },
  'show-all': () => { state.view.showAll = true; paintHistory(); },
  'export-csv': exportCsv,
  'new-tx': () => txForm(null),
  'edit-tx': (el) => txForm(state.view.txs.find((t) => String(t.id) === el.dataset.id)),
  'delete-tx': (el) => {
    const t = state.view.txs.find((x) => String(x.id) === el.dataset.id);
    confirmDialog('Buchung löschen?', `${t.description} (${signed(cents(t.amount))}) wird endgültig gelöscht.`, 'Löschen', async () => {
      await q(sb.from('transactions').delete().eq('id', t.id));
      toast('Gelöscht');
      route();
    });
  },
  'new-request': () => formDialog({
    title: 'Geld anfragen',
    intro: 'Deine Eltern sehen die Anfrage und können sie genehmigen.',
    submit: 'Anfrage senden',
    fields: [
      { name: 'kind', label: 'Art', value: 'withdrawal', options: [['withdrawal', 'Auszahlung (Geld bekommen)'], ['deposit', 'Einzahlung (Geld einzahlen)']] },
      { name: 'amount', label: 'Betrag in CHF', inputmode: 'decimal' },
      { name: 'description', label: 'Wofür?', maxlength: 200 },
    ],
    onSubmit: async (d) => {
      if (!d.description.trim()) throw new Error('Bitte angeben, wofür das Geld ist.');
      const amount = Math.abs(parseAmount(d.amount));
      await q(sb.from('requests').insert({ child_id: state.view.childId, kind: d.kind, amount, description: d.description.trim() }));
      toast('Anfrage gesendet');
      route();
    },
  }),
  approve: async (el) => {
    el.disabled = true;
    await q(sb.rpc('decide_request', { request_id: Number(el.dataset.id), approve: true }));
    toast('Genehmigt und gebucht');
    route();
  },
  reject: async (el) => {
    el.disabled = true;
    await q(sb.rpc('decide_request', { request_id: Number(el.dataset.id), approve: false }));
    toast('Abgelehnt');
    route();
  },
  'withdraw-request': async (el) => {
    await q(sb.from('requests').delete().eq('id', Number(el.dataset.id)));
    toast('Anfrage zurückgezogen');
    route();
  },
  'new-goal': () => formDialog({
    title: 'Sparziel hinzufügen',
    fields: [
      { name: 'name', label: 'Wofür sparst du?', maxlength: 80 },
      { name: 'target', label: 'Zielbetrag in CHF', inputmode: 'decimal' },
    ],
    onSubmit: async (d) => {
      if (!d.name.trim()) throw new Error('Bitte einen Namen eingeben.');
      await q(sb.from('goals').insert({ child_id: state.view.childId, name: d.name.trim(), target_amount: Math.abs(parseAmount(d.target)) }));
      route();
    },
  }),
  'delete-goal': async (el) => {
    await q(sb.from('goals').delete().eq('id', Number(el.dataset.id)));
    route();
  },
  'edit-allowance': (el) => {
    const id = Number(el.dataset.id);
    const { children, settings } = state.adminData;
    const s = settings.find((x) => x.child_id === id);
    formDialog({
      title: `Taschengeld für ${children.find((c) => c.id === id).name}`,
      intro: 'Wird jeden Sonntag automatisch gebucht. Ein geänderter Betrag gilt ab der nächsten Zahlung.',
      fields: [
        { name: 'amount', label: 'Betrag pro Woche in CHF', value: s ? Number(s.weekly_amount).toFixed(2) : '', inputmode: 'decimal' },
        { name: 'start', label: 'Gültig ab', type: 'date', value: s?.start_date || today() },
      ],
      onSubmit: async (d) => {
        if (!d.start) throw new Error('Bitte ein Datum wählen.');
        const weekly_amount = Math.abs(parseAmount(d.amount));
        if (s) await q(sb.from('allowance_settings').update({ weekly_amount, start_date: d.start }).eq('child_id', id));
        else await q(sb.from('allowance_settings').insert({ child_id: id, weekly_amount, start_date: d.start }));
        toast('Gespeichert');
        route();
      },
    });
  },
  'stop-allowance': (el) => confirmDialog('Taschengeld pausieren?', 'Ab sofort wird für dieses Kind nichts mehr automatisch gebucht. Bisherige Buchungen bleiben.', 'Pausieren', async () => {
    await q(sb.from('allowance_settings').delete().eq('child_id', Number(el.dataset.id)));
    route();
  }),
  'reset-password': (el) => formDialog({
    title: 'Passwort zurücksetzen',
    fields: [{ name: 'pw', label: 'Neues Passwort', type: 'password', autocomplete: 'new-password', hint: 'Mindestens 8 Zeichen' }],
    onSubmit: async (d) => {
      await q(sb.rpc('admin_set_password', { target: el.dataset.id, new_password: d.pw }));
      toast('Passwort geändert');
    },
  }),
  'edit-phone': (el) => {
    const u = state.adminData.users.find((x) => x.user_id === el.dataset.id);
    formDialog({
      title: `WhatsApp-Nummer von ${u.username}`,
      fields: [{ name: 'phone', label: 'Nummer mit Ländervorwahl', value: u.phone || '', inputmode: 'tel', hint: 'Zum Beispiel +41 79 123 45 67. Leer lassen, um keine Nachrichten zu senden.' }],
      onSubmit: async (d) => {
        const phone = d.phone.replace(/[\s()/-]/g, '') || null;
        if (phone && !/^\+[0-9]{8,15}$/.test(phone)) throw new Error('Bitte die Nummer mit + und Ländervorwahl eingeben.');
        await q(sb.from('profiles').update({ phone }).eq('user_id', u.user_id));
        toast('Gespeichert');
        route();
      },
    });
  },
  'reset-2fa': (el) => confirmDialog('2FA zurücksetzen?', 'Das Konto kann sich danach wieder nur mit dem Passwort anmelden und den Schutz neu einrichten.', 'Zurücksetzen', async () => {
    await q(sb.rpc('admin_reset_2fa', { target: el.dataset.id }));
    toast('2FA zurückgesetzt');
    route();
  }),
  'change-password': () => formDialog({
    title: 'Passwort ändern',
    fields: [
      { name: 'pw', label: 'Neues Passwort', type: 'password', autocomplete: 'new-password', hint: 'Mindestens 8 Zeichen' },
      { name: 'pw2', label: 'Wiederholen', type: 'password', autocomplete: 'new-password' },
    ],
    onSubmit: async (d) => {
      if (d.pw.length < 8) throw new Error('Mindestens 8 Zeichen.');
      if (d.pw !== d.pw2) throw new Error('Die Passwörter stimmen nicht überein.');
      await q(sb.auth.updateUser({ password: d.pw }));
      toast('Passwort geändert');
    },
  }),
  'mfa-on': startMfaEnroll,
  'mfa-off': (el) => confirmDialog('Zwei-Faktor-Schutz deaktivieren?', 'Das Konto ist dann nur noch mit dem Passwort geschützt.', 'Deaktivieren', async () => {
    await q(sb.auth.mfa.unenroll({ factorId: el.dataset.id }));
    await sb.auth.refreshSession();
    route();
  }),
};

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  try {
    await actions[el.dataset.act](el);
  } catch (ex) {
    el.disabled = false;
    toast(ex.message);
  }
});

document.addEventListener('change', (e) => {
  const v = state.view;
  if (e.target.dataset.filter) { v.filter[e.target.dataset.filter] = e.target.value; paintHistory(); }
  if ('statYear' in e.target.dataset) { v.statYear = e.target.value; paintStats(); }
});

window.addEventListener('hashchange', route);
if ('serviceWorker' in navigator && location.hostname !== 'localhost') navigator.serviceWorker.register('sw.js');
route();
