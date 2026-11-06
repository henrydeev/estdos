/* store.js: contas e dados do site. Funciona de dois jeitos:
   - "local": contas e dados ficam neste navegador. Funciona sem configurar nada.
   - "supabase": contas e dados ficam num banco online. Ativa sozinho quando
     o config.js tem SUPABASE_URL e SUPABASE_ANON_KEY preenchidos.
   As duas páginas usam só window.Auth, window.Data e window.APP_MODE. */
(function () {
  'use strict';
  var CFG = window.APP_CONFIG || {};
  var hasCfg = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY &&
    !/SEU-PROJETO|SUA-CHAVE/.test(CFG.SUPABASE_URL + CFG.SUPABASE_ANON_KEY) && CFG.MODE !== 'local');
  var mode = hasCfg ? 'supabase' : 'local';

  function todayBR() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }
  function toMin(t) { var m = /^(\d{2}):(\d{2})/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; }
  function err(code, message) { var e = new Error(message); e.code = code; return e; }

  /* ---------------------------------------------------------------- Supabase */
  if (mode === 'supabase') {
    if (!window.supabase) { window.APP_MODE = 'supabase'; window.Auth = null; window.Data = null; return; }
    var sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    var rowToLesson = function (r) {
      return { id: r.id, date: r.lesson_date, subjectId: r.subject_id, start: String(r.start_time).slice(0, 5), end: String(r.end_time).slice(0, 5),
        title: r.title, topic: r.topic || '', notes: r.notes || '', answered: r.answered, correct: r.correct, wrong: r.wrong, status: r.status };
    };
    var lessonToRow = function (l) {
      return { lesson_date: l.date, subject_id: l.subjectId, start_time: l.start, end_time: l.end, title: l.title, topic: l.topic,
        notes: l.notes, answered: l.answered, correct: l.correct, wrong: l.wrong, status: l.status };
    };
    var fetchAll = async function (table) {
      var out = [], from = 0;
      for (;;) {
        var r = await sb.from(table).select('*').order('id', { ascending: true }).range(from, from + 999);
        if (r.error) throw r.error;
        out = out.concat(r.data);
        if (r.data.length < 1000) return out;
        from += 1000;
      }
    };
    var must = function (r) { if (r.error) throw r.error; return r.data; };
    window.APP_MODE = 'supabase';
    window.Auth = sb.auth;
    window.Data = {
      async loadData(user) {
        var res = await Promise.all([sb.from('profiles').select('*').eq('id', user.id).maybeSingle(), fetchAll('subjects'), fetchAll('lessons')]);
        if (res[0].error) throw res[0].error;
        var p = res[0].data || {};
        return {
          name: p.full_name || (user.user_metadata && user.user_metadata.full_name) || user.email || 'Estudante',
          theme: p.theme || null, goalHours: Number(p.goal_hours) > 0 ? Number(p.goal_hours) : 10,
          subjects: res[1].map(function (s) { return { id: s.id, name: s.name, color: s.color }; }),
          lessons: res[2].map(rowToLesson)
        };
      },
      async saveProfile(user, p) {
        var r = await sb.from('profiles').upsert({ id: user.id, full_name: p.name, theme: p.theme || null, goal_hours: p.goalHours || 10 });
        if (r.error) throw r.error;
      },
      async insertSubject(s) { var d = must(await sb.from('subjects').insert({ name: s.name, color: s.color }).select().single()); return { id: d.id, name: d.name, color: d.color }; },
      async updateSubject(id, s) { var d = must(await sb.from('subjects').update({ name: s.name, color: s.color }).eq('id', id).select().single()); return { id: d.id, name: d.name, color: d.color }; },
      async deleteSubject(id) { must(await sb.from('subjects').delete().eq('id', id).select()); },
      async insertLesson(l) { return rowToLesson(must(await sb.from('lessons').insert(lessonToRow(l)).select().single())); },
      async updateLesson(id, l) { return rowToLesson(must(await sb.from('lessons').update(lessonToRow(l)).eq('id', id).select().single())); },
      async deleteLesson(id) { must(await sb.from('lessons').delete().eq('id', id).select()); }
    };
    return;
  }

  /* ------------------------------------------------------------------- Local */
  var ACC = 'mde-accounts-v1', SES = 'mde-session-v1';
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set: function (k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); }
      catch (e) { throw err('storage', 'Não foi possível salvar neste navegador. Verifique se o armazenamento do site não está bloqueado.'); }
    },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  var b64 = function (buf) { var a = new Uint8Array(buf), s = ''; for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); };
  var unb64 = function (s) { var r = atob(s), a = new Uint8Array(r.length); for (var i = 0; i < r.length; i++) a[i] = r.charCodeAt(i); return a; };
  var newSalt = function () { return b64(crypto.getRandomValues(new Uint8Array(16))); };
  var uuid = function () {
    if (crypto.randomUUID) return crypto.randomUUID();
    var a = crypto.getRandomValues(new Uint8Array(16)), h = '';
    for (var i = 0; i < 16; i++) h += (a[i] + 256).toString(16).slice(1);
    return h;
  };
  async function hashPass(pass, salt) {
    if (!(window.crypto && crypto.subtle)) throw err('no_crypto', 'Este navegador não permite criar contas neste modo. Abra o site por https ou localhost.');
    var key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
    var bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt), iterations: 150000 }, key, 256);
    return b64(bits);
  }
  var accounts = function () { return LS.get(ACC, {}); };
  var sessionOf = function (a) { return { user: { id: a.id, email: a.email, user_metadata: { full_name: a.name } } }; };
  var currentAccount = function () {
    var s = LS.get(SES, null); if (!s || !s.id) return null;
    var all = accounts();
    for (var k in all) if (all[k].id === s.id) return all[k];
    return null;
  };
  var listeners = [];
  var emit = function (ev, s) { listeners.slice().forEach(function (f) { try { f(ev, s); } catch (e) {} }); };
  window.addEventListener('storage', function (e) { if (e.key === SES && !e.newValue) emit('SIGNED_OUT', null); });
  var fails = {};

  var Auth = {
    async getSession() { var a = currentAccount(); return { data: { session: a ? sessionOf(a) : null }, error: null }; },
    async signInWithPassword(c) {
      var email = String(c.email || '').trim().toLowerCase(), f = fails[email] || { n: 0, until: 0 };
      if (Date.now() < f.until) return { data: {}, error: { code: 'over_request_rate_limit', status: 429, message: 'Too many requests' } };
      var a = accounts()[email];
      var ok = false;
      if (a) ok = (await hashPass(String(c.password || ''), a.salt)) === a.hash;
      if (!ok) {
        f.n++; if (f.n >= 5) { f.until = Date.now() + 30000; f.n = 0; } fails[email] = f;
        return { data: {}, error: { code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' } };
      }
      delete fails[email];
      LS.set(SES, { id: a.id });
      var s = sessionOf(a); emit('SIGNED_IN', s);
      return { data: { session: s, user: s.user }, error: null };
    },
    async signUp(c) {
      var email = String(c.email || '').trim().toLowerCase(), pass = String(c.password || '');
      var name = String((c.options && c.options.data && c.options.data.full_name) || '').trim().slice(0, 80);
      if (pass.length < 8) return { data: {}, error: { code: 'weak_password', status: 422, message: 'Password should be at least 8 characters' } };
      var all = accounts();
      if (all[email]) return { data: { user: { identities: [] }, session: null }, error: null };
      var salt = newSalt(), hash = await hashPass(pass, salt);
      var a = { id: uuid(), email: email, name: name, salt: salt, hash: hash, createdAt: Date.now() };
      all[email] = a; LS.set(ACC, all); LS.set(SES, { id: a.id });
      var s = sessionOf(a); emit('SIGNED_IN', s);
      return { data: { user: s.user, session: s }, error: null };
    },
    async signOut() { LS.del(SES); emit('SIGNED_OUT', null); return { error: null }; },
    async resetPasswordForEmail() {
      return { data: {}, error: { code: 'local_no_reset', message: 'Neste modo as contas ficam só neste navegador, por isso a senha não pode ser recuperada por e-mail. Crie uma nova conta ou ative o Supabase no config.js.' } };
    },
    async resend() { return { data: {}, error: null }; },
    async updateUser(c) {
      var a = currentAccount();
      if (!a) return { data: {}, error: { code: 'no_session', message: 'session missing' } };
      var pass = String(c.password || '');
      if (pass.length < 8) return { data: {}, error: { code: 'weak_password', message: 'Password should be at least 8 characters' } };
      if ((await hashPass(pass, a.salt)) === a.hash) return { data: {}, error: { code: 'same_password', message: 'New password should be different from the old password.' } };
      var all = accounts(); a.salt = newSalt(); a.hash = await hashPass(pass, a.salt); all[a.email] = a; LS.set(ACC, all);
      return { data: { user: sessionOf(a).user }, error: null };
    },
    onAuthStateChange: function (fn) {
      listeners.push(fn);
      return { data: { subscription: { unsubscribe: function () { listeners = listeners.filter(function (x) { return x !== fn; }); } } } };
    }
  };

  var dk = function (uid) { return 'mde-data-v1-' + uid; };
  var blank = function () { return { profile: { name: '', theme: null, goalHours: 10 }, subjects: [], lessons: [] }; };
  function me() { var a = currentAccount(); if (!a) throw err('PGRST301', 'JWT expired'); return a; }
  function read(a) { var d = LS.get(dk(a.id), null); return d && Array.isArray(d.subjects) && Array.isArray(d.lessons) ? d : blank(); }
  function write(a, d) { LS.set(dk(a.id), d); }
  function check(d, l, id) {
    var today = todayBR();
    if (l.date < today) throw err('P0001', 'Não é possível criar ou mover aulas para datas passadas.');
    if (l.date > today && l.status === 'done') throw err('P0001', 'Aulas futuras só podem ser planejadas.');
    if (!(toMin(l.end) > toMin(l.start))) throw err('23514', 'check');
    if (l.correct + l.wrong !== l.answered) throw err('23514', 'check');
    if (!d.subjects.some(function (s) { return s.id === l.subjectId; })) throw err('23514', 'check');
    if (d.lessons.some(function (x) { return x.id !== id && x.date === l.date && toMin(l.start) < toMin(x.end) && toMin(x.start) < toMin(l.end); })) throw err('23P01', 'overlap');
  }
  var pick = function (l) { return { date: l.date, subjectId: l.subjectId, start: l.start, end: l.end, title: l.title, topic: l.topic || '', notes: l.notes || '', answered: l.answered, correct: l.correct, wrong: l.wrong, status: l.status }; };
  var dup = function (d, name, id) { return d.subjects.some(function (s) { return s.id !== id && s.name.trim().toLowerCase() === name.trim().toLowerCase(); }); };

  /* Levar a conta para outro aparelho: gera um arquivo com a conta (senha só como hash) e os dados. */
  Auth.exportAccount = function () {
    var a = me(), d = read(a);
    return JSON.stringify({ app: 'mde-account', version: 1, exportedAt: new Date().toISOString(),
      account: { id: a.id, email: a.email, name: a.name, salt: a.salt, hash: a.hash, createdAt: a.createdAt }, data: d });
  };
  Auth.importAccount = function (text, opts) {
    var p;
    try { p = JSON.parse(text); } catch (e) { throw err('import', 'Arquivo inválido. Use o arquivo gerado em Conta > Levar para outro aparelho.'); }
    var a = p && p.account, d = p && p.data;
    if (!p || p.app !== 'mde-account' || !a || !a.id || !a.email || !a.salt || !a.hash || !d || !Array.isArray(d.subjects) || !Array.isArray(d.lessons))
      throw err('import', 'Arquivo inválido. Use o arquivo gerado em Conta > Levar para outro aparelho.');
    var email = String(a.email).trim().toLowerCase(), all = accounts();
    if (all[email] && !(opts && opts.replace)) throw err('exists', 'Já existe uma conta com este e-mail neste aparelho. Importar vai substituir os dados dela.');
    if (all[email] && all[email].id !== a.id) { LS.del(dk(all[email].id)); }
    all[email] = { id: String(a.id), email: email, name: String(a.name || ''), salt: String(a.salt), hash: String(a.hash), createdAt: a.createdAt || Date.now() };
    LS.set(ACC, all);
    LS.set(dk(a.id), { profile: d.profile || { name: a.name || '', theme: null, goalHours: 10 }, subjects: d.subjects, lessons: d.lessons });
    return email;
  };

  window.APP_MODE = 'local';
  window.Auth = Auth;
  window.Data = {
    async loadData(user) {
      var a = me(), d = read(a), p = d.profile || {};
      return { name: p.name || a.name || a.email, theme: p.theme || null, goalHours: Number(p.goalHours) > 0 ? Number(p.goalHours) : 10,
        subjects: d.subjects.slice(), lessons: d.lessons.slice() };
    },
    async saveProfile(user, p) { var a = me(), d = read(a); d.profile = { name: p.name, theme: p.theme || null, goalHours: p.goalHours || 10 }; write(a, d); },
    async insertSubject(s) {
      var a = me(), d = read(a);
      if (dup(d, s.name)) throw err('23505', 'duplicate');
      var r = { id: uuid(), name: s.name, color: s.color }; d.subjects.push(r); write(a, d); return r;
    },
    async updateSubject(id, s) {
      var a = me(), d = read(a), o = d.subjects.filter(function (x) { return x.id === id; })[0];
      if (!o) throw err('PGRST116', 'Matéria não encontrada.');
      if (dup(d, s.name, id)) throw err('23505', 'duplicate');
      o.name = s.name; o.color = s.color; write(a, d); return { id: o.id, name: o.name, color: o.color };
    },
    async deleteSubject(id) {
      var a = me(), d = read(a);
      if (d.lessons.some(function (l) { return l.subjectId === id; })) throw err('23503', 'fk');
      d.subjects = d.subjects.filter(function (s) { return s.id !== id; }); write(a, d);
    },
    async insertLesson(l) {
      var a = me(), d = read(a); check(d, l, null);
      var r = Object.assign({ id: uuid() }, pick(l)); d.lessons.push(r); write(a, d); return r;
    },
    async updateLesson(id, l) {
      var a = me(), d = read(a), o = d.lessons.filter(function (x) { return x.id === id; })[0];
      if (!o) throw err('PGRST116', 'Registro não encontrado.');
      if (o.date < todayBR()) throw err('P0001', 'Registro de dia anterior está bloqueado para alterações.');
      check(d, l, id);
      var r = Object.assign({ id: id }, pick(l)); d.lessons[d.lessons.indexOf(o)] = r; write(a, d); return r;
    },
    async deleteLesson(id) {
      var a = me(), d = read(a), o = d.lessons.filter(function (x) { return x.id === id; })[0];
      if (!o) return;
      if (o.date < todayBR()) throw err('P0001', 'Registro de dia anterior está bloqueado para alterações.');
      d.lessons = d.lessons.filter(function (x) { return x.id !== id; }); write(a, d);
    }
  };
})();
