// Fake in-memory Supabase client for local screen tests. Only fake people and fake amounts.
(() => {
  const iso = (d) => d.toISOString().slice(0, 10);
  const db = {
    children: [{ id: 1, name: 'Mia' }, { id: 2, name: 'Leo' }],
    profiles: [
      { user_id: 'u-admin', username: 'admin', role: 'admin', child_id: null },
      { user_id: 'u-parent', username: 'mama', role: 'parent', child_id: null },
      { user_id: 'u-mia', username: 'mia', role: 'child', child_id: 1 },
      { user_id: 'u-leo', username: 'leo', role: 'child', child_id: 2 },
    ],
    transactions: [],
    allowance_settings: [
      { child_id: 1, weekly_amount: 12, start_date: '2025-01-01', paid_through: '2026-11-01' },
      { child_id: 2, weekly_amount: 16, start_date: '2025-01-01', paid_through: '2026-11-01' },
    ],
    requests: [{ id: 1, child_id: 1, kind: 'withdrawal', amount: 35, description: 'Kinobesuch mit Freundinnen', status: 'pending', created_at: '2026-10-30T10:00:00Z' }],
    goals: [{ id: 1, child_id: 1, name: 'Neue Kopfhörer', target_amount: 180, created_at: '2026-09-01T10:00:00Z' }],
  };
  let id = 1000;
  const spend = ['Shopping', 'Kino', 'Essen mit Freunden', 'Hose', 'Buch', 'Twint', 'Geschenk'];
  for (const c of [1, 2]) {
    let n = 0;
    for (let d = new Date('2025-01-05T12:00:00Z'); d <= new Date('2026-11-01T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 7)) {
      const amount = c === 1 ? 12 : 16;
      db.transactions.push({ id: id++, child_id: c, date: iso(d), type: 'allowance', description: `Wöchentliches Taschengeld - ${iso(d).split('-').reverse().join('.')}`, amount });
      if (++n % 3 === 0) {
        db.transactions.push({ id: id++, child_id: c, date: iso(d), type: 'withdrawal', description: spend[n % spend.length], amount: -(15 + (n * 7) % 40) });
      }
      if (n % 26 === 0) db.transactions.push({ id: id++, child_id: c, date: iso(d), type: 'deposit', description: 'Geburtstagsgeld', amount: 50 });
    }
  }
  db.transactions.sort((a, b) => (a.date < b.date ? 1 : -1));

  let session = JSON.parse(sessionStorage.getItem('mock-session') || 'null');
  const as = new URLSearchParams(location.search).get('as');
  if (as) session = { user: { id: `u-${as}` } };
  const scope = () => {
    const p = session && db.profiles.find((x) => x.user_id === session.user.id);
    if (!p) return () => false;
    if (p.role === 'child') return (cid) => cid === p.child_id;
    return () => true;
  };

  class Query {
    constructor(table) { this.table = table; this.filters = []; this.op = 'select'; this.one = false; }
    select() { return this; }
    eq(k, v) { this.filters.push((r) => String(r[k]) === String(v)); return this; }
    order(k, o = {}) { (this.orders ||= []).push([k, o.ascending !== false]); return this; }
    range(a, b) { this.rng = [a, b]; return this; }
    maybeSingle() { this.one = true; return this; }
    insert(row) { this.op = 'insert'; this.row = row; return this; }
    update(row) { this.op = 'update'; this.row = row; return this; }
    delete() { this.op = 'delete'; return this; }
    rows() {
      const can = scope();
      if (this.table === 'child_balances') {
        return db.children.filter((c) => can(c.id)).map((c) => ({
          child_id: c.id, name: c.name,
          balance: db.transactions.filter((t) => t.child_id === c.id).reduce((s, t) => s + t.amount, 0),
        }));
      }
      return db[this.table].filter((r) => {
        const cid = this.table === 'children' ? r.id : r.child_id;
        if (this.table === 'profiles') return true;
        return can(cid);
      });
    }
    then(ok, fail) {
      try {
        let data = null;
        if (this.op === 'insert') {
          db[this.table].unshift({ id: id++, status: 'pending', created_at: new Date().toISOString(), paid_through: '2026-11-01', ...this.row });
        } else if (this.op === 'update') {
          db[this.table].filter((r) => this.filters.every((f) => f(r))).forEach((r) => Object.assign(r, this.row));
        } else if (this.op === 'delete') {
          db[this.table] = db[this.table].filter((r) => !this.filters.every((f) => f(r)));
        } else {
          data = this.rows().filter((r) => this.filters.every((f) => f(r)));
          for (const [k, asc] of [...(this.orders || [])].reverse()) {
            data = [...data].sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (asc ? 1 : -1));
          }
          if (this.rng) data = data.slice(this.rng[0], this.rng[1] + 1);
          if (this.one) data = data[0] || null;
        }
        return Promise.resolve({ data, error: null }).then(ok, fail);
      } catch (e) {
        return Promise.resolve({ data: null, error: { message: e.message } }).then(ok, fail);
      }
    }
  }

  window.supabase = {
    createClient: () => ({
      from: (t) => new Query(t),
      rpc: async (name, args) => {
        if (name === 'decide_request') {
          const r = db.requests.find((x) => x.id === args.request_id);
          r.status = args.approve ? 'approved' : 'rejected';
          if (args.approve) {
            db.transactions.unshift({ id: id++, child_id: r.child_id, date: iso(new Date()), type: r.kind, description: r.description, amount: r.kind === 'withdrawal' ? -r.amount : r.amount });
          }
        }
        return { data: null, error: null };
      },
      auth: {
        getSession: async () => ({ data: { session } }),
        signInWithPassword: async ({ email }) => {
          const p = db.profiles.find((x) => x.username === email.split('@')[0]);
          if (!p) return { error: { message: 'bad login' } };
          session = { user: { id: p.user_id } };
          sessionStorage.setItem('mock-session', JSON.stringify(session));
          return { data: { session }, error: null };
        },
        signOut: async () => { session = null; sessionStorage.removeItem('mock-session'); },
        updateUser: async () => ({ data: {}, error: null }),
        refreshSession: async () => ({ data: {}, error: null }),
        mfa: {
          getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1', nextLevel: 'aal1' } }),
          listFactors: async () => ({ data: { totp: [], all: [] }, error: null }),
          enroll: async () => ({ data: { id: 'f1', totp: { qr_code: 'icons/icon-192.png', secret: 'FAKESECRET' } }, error: null }),
          challengeAndVerify: async () => ({ data: {}, error: null }),
          unenroll: async () => ({ data: {}, error: null }),
        },
      },
    }),
  };
})();
