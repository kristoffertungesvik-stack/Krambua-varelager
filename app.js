/* Krambua – Varelager
 * Lager = siste teljing + mottak etter teljinga − sal frå kassa (PCK) etter teljinga.
 * Data ligg i det private repoet Krambua-varelager-data og vert lese/skrive med GitHub-token.
 */
'use strict';

const CFG = {
  repo: 'kristoffertungesvik-stack/Krambua-varelager-data',
  branch: 'main',
  tokenKey: 'krambua-varelager-token',
  lokalKey: 'krambua-varelager-lokal',
  cacheKey: 'krambua-varelager-cache',
  namnKey: 'krambua-varelager-namn',
  modusKey: 'krambua-varelager-modus',
  temaKey: 'krambua-varelager-tema',
  versjon: '1.0',
};

const DAG = 86400000;
const S = {
  varer: {}, sal: [], app: null, appSha: null, best: { ordrar: [] },
  meta: { salOppdatert: null, bestOppdatert: null },
  lasta: false, feil: null, dirty: false, saving: false, again: false,
  view: 'oversikt', calc: null,
  lager: { q: '', status: 'alle', kat: '', vis: 150, utelatne: false },
  skann: { modus: 'telling', kode: null, vare: null, tal: '', kvar: false, ventande: null, ukjend: null, sist: { kode: '', t: 0 } },
};

/* ---------- små hjelparar ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { } },
};
const nyId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const naa = () => new Date().toISOString();
const fmtTal = (n, d = 0) => n == null || isNaN(n) ? '–' : Number(n).toLocaleString('nb-NO', { maximumFractionDigits: d, minimumFractionDigits: 0 });
const fmtLager = n => n == null ? '–' : (Math.abs(n - Math.round(n)) < 0.005 ? fmtTal(Math.round(n)) : fmtTal(n, 2));
const fmtKr = n => n == null ? '–' : Number(n).toLocaleString('nb-NO', { style: 'currency', currency: 'NOK', maximumFractionDigits: 0 });
const DAGAR = ['sø', 'må', 'ty', 'on', 'to', 'fr', 'la'];
function fmtDato(d, medTid) {
  if (!d) return '–';
  const x = typeof d === 'string' && d.length === 10 ? new Date(d + 'T12:00:00') : new Date(d);
  const s = `${DAGAR[x.getDay()]} ${x.getDate()}.${x.getMonth() + 1}.`;
  return medTid ? `${s} kl. ${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}` : s;
}
const ti = d => new Date(d + 'T10:00:00').getTime(); // start/slutt for salsperiode (10:00 lokal tid)
const norm = s => String(s || '').toLowerCase().normalize('NFC').replace(/\s+/g, ' ').trim();
const katNamn = k => (window.KATEGORI_NAMN || {})[k] || 'Anna';
const getToken = () => ls.get(CFG.tokenKey);
const brukar = () => ls.get(CFG.namnKey) || '';

const IKON = {
  lukk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  sok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  sol: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  maane: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
  kamera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2M7 9v6M10 9v6M13 9v6M17 9v6"/></svg>',
};

/* ---------- reglar for nye varer frå kassa ---------- */
function utelatGrunn(v, namn) {
  const n = Number(v);
  if (v === '10553' || (n >= 100000 && n <= 100025)) return 'generisk';
  if (/^(vask|tørk|dusj)\b|leigeavtale|leieavtale|kompensasjon|natt med båt|^knapphus$|etne kommune|kai ?leige|gåvekort|gavekort/i.test(namn)) return 'teneste';
  if ((n >= 105225 && n <= 105255) || v === '105536') return 'servering';
  return null;
}
function nyServering(namn) {
  return /burger|pommes|pølse m\/|kebabrull|kebabtall|nuggets|softis|kuleis|milkshake|slurp|kaffe (enkel|dobbel)|pizza slice|panini|tallerken/i.test(namn);
}
function gjettKategori(namn) {
  const s = ' ' + norm(namn) + ' ';
  for (const c of window.KATEGORIAR || []) {
    try { if (new RegExp(c.r, 'i').test(s)) return c.k; } catch { }
  }
  return 'anna';
}

/* ---------- GitHub ---------- */
async function gh(sti, opt = {}) {
  const t = getToken();
  if (!t) throw new Error('Appen er ikkje kopla til GitHub enno.');
  const headers = { Authorization: 'Bearer ' + t, Accept: opt.accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (opt.body) headers['Content-Type'] = 'application/json';
  return fetch('https://api.github.com/repos/' + CFG.repo + sti, { method: opt.method || 'GET', body: opt.body, headers, cache: 'no-store' });
}
async function httpFeil(r) {
  let m = '';
  try { m = (await r.json()).message || ''; } catch { }
  if (r.status === 401) return new Error('Tokenet vart avvist av GitHub (401). Lag eit nytt token under Meir.');
  if (r.status === 403) return new Error('GitHub nekta tilgang (403). Sjekk at tokenet har «Contents: Read and write» på Krambua-varelager-data. ' + m);
  if (r.status === 404) return new Error('Fann ikkje datarepoet (404). Sjekk at tokenet gjeld Krambua-varelager-data.');
  return new Error(`GitHub svarte ${r.status}. ${m}`);
}
async function lesRaw(fil) {
  const r = await gh(`/contents/data/${fil}?ref=${CFG.branch}&t=${Date.now()}`, { accept: 'application/vnd.github.raw+json' });
  if (r.status === 404) return null;
  if (!r.ok) throw await httpFeil(r);
  return r.json();
}
async function lesShaar() {
  const r = await gh(`/contents/data?ref=${CFG.branch}&t=${Date.now()}`);
  if (!r.ok) throw await httpFeil(r);
  const o = {};
  for (const f of await r.json()) o[f.name] = f.sha;
  return o;
}
function b64(str) {
  const b = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function skrivFil(fil, obj, sha, melding) {
  const body = { message: melding, content: b64(JSON.stringify(obj)), branch: CFG.branch };
  if (sha) body.sha = sha;
  const r = await gh('/contents/data/' + fil, { method: 'PUT', body: JSON.stringify(body) });
  if (r.status === 409 || r.status === 422) { const e = new Error('konflikt'); e.konflikt = true; throw e; }
  if (!r.ok) throw await httpFeil(r);
  return (await r.json()).content.sha;
}

/* ---------- app.json (teljingar, mottak, koplingar) ---------- */
const tomApp = () => ({ versjon: 1, oppdatert: naa(), teljingar: [], mottak: [], ean: {}, kopling: {}, innst: {}, nye: {}, ordre: {} });
function flettApp(a, b) {
  a = a || tomApp(); b = b || tomApp();
  const ut = tomApp();
  for (const k of ['teljingar', 'mottak']) {
    const m = new Map();
    for (const e of [...(a[k] || []), ...(b[k] || [])]) {
      const f = m.get(e.id);
      if (!f) m.set(e.id, e);
      else if (e.slett && !f.slett) m.set(e.id, e);
      else if ((e.e || e.t) > (f.e || f.t)) m.set(e.id, e);
    }
    ut[k] = [...m.values()].sort((x, y) => x.t < y.t ? -1 : 1);
  }
  for (const k of ['ean', 'kopling', 'innst', 'nye', 'ordre']) {
    const o = { ...(a[k] || {}) };
    for (const [key, val] of Object.entries(b[k] || {})) {
      if (!o[key] || (val.t || '') >= (o[key].t || '')) o[key] = val;
    }
    ut[k] = o;
  }
  return ut;
}
async function lesApp() {
  const r = await gh(`/contents/data/app.json?ref=${CFG.branch}&t=${Date.now()}`);
  if (r.status === 404) return { data: tomApp(), sha: null };
  if (!r.ok) throw await httpFeil(r);
  const j = await r.json();
  const bin = atob(j.content.replace(/\n/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return { data: JSON.parse(new TextDecoder().decode(bytes)), sha: j.sha };
}
function lagreLokalt() {
  ls.set(CFG.lokalKey, JSON.stringify({ app: S.app, dirty: S.dirty, sha: S.appSha }));
}
let pushTimar = null;
function endra() {
  S.dirty = true;
  S.app.oppdatert = naa();
  lagreLokalt();
  S.calc = rekn();
  setSync('lagrar', 'Ikkje lagra enno');
  clearTimeout(pushTimar);
  pushTimar = setTimeout(pushApp, 1800);
}
async function pushApp() {
  if (!S.dirty || !getToken()) return;
  if (S.saving) { S.again = true; return; }
  S.saving = true; setSync('lagrar', 'Lagrar …');
  try {
    for (let forsok = 0; forsok < 4; forsok++) {
      try {
        S.appSha = await skrivFil('app.json', S.app, S.appSha, `Lager: oppdatering frå appen${brukar() ? ' (' + brukar() + ')' : ''}`);
        S.dirty = false; lagreLokalt(); setSync('ok', 'Lagra'); break;
      } catch (e) {
        if (!e.konflikt || forsok === 3) throw e;
        const fjern = await lesApp();
        S.app = flettApp(fjern.data, S.app); S.appSha = fjern.sha;
      }
    }
  } catch (e) {
    setSync('feil', navigator.onLine ? 'Ikkje lagra' : 'Fråkopla – lagrar seinare');
    if (navigator.onLine) toast(e.message, { feil: true });
  } finally {
    S.saving = false;
    if (S.again) { S.again = false; pushApp(); }
  }
}
window.addEventListener('online', () => { if (S.dirty) pushApp(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && S.dirty) pushApp(); });

function setSync(s, tekst) {
  const el = $('#sync');
  el.dataset.s = s;
  el.title = tekst;
  el.querySelector('span').textContent = tekst;
}

/* ---------- tema (lys / mørk) ---------- */
function temaVal() { const t = ls.get(CFG.temaKey); return t === 'lys' || t === 'mork' ? t : 'auto'; }
function effektivtTema() { const t = temaVal(); return t !== 'auto' ? t : (matchMedia('(prefers-color-scheme: dark)').matches ? 'mork' : 'lys'); }
function settTema(t) {
  if (t === 'auto') { ls.del(CFG.temaKey); delete document.documentElement.dataset.theme; }
  else { ls.set(CFG.temaKey, t); document.documentElement.dataset.theme = t === 'lys' ? 'light' : 'dark'; }
  oppdaterTema();
}
function oppdaterTema() {
  const e = effektivtTema();
  const b = $('#tema-knapp');
  if (b) {
    b.innerHTML = e === 'mork' ? IKON.sol : IKON.maane;
    const tekst = e === 'mork' ? 'Byt til lyst tema' : 'Byt til mørkt tema';
    b.setAttribute('aria-label', tekst); b.title = tekst;
  }
  const farge = getComputedStyle(document.documentElement).getPropertyValue('--papir').trim();
  const meta = $('#tema-farge'); if (meta && farge) meta.setAttribute('content', farge);
}
try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', oppdaterTema); } catch { }

/* ---------- lasting ---------- */
async function last() {
  if (!getToken()) { S.lasta = true; render(); return; }
  setSync('lagrar', 'Hentar …');
  // vis mellomlagra data med ein gong om det finst
  const cache = ls.get(CFG.cacheKey);
  const lokal = ls.get(CFG.lokalKey);
  if (cache && !S.lasta) {
    try {
      const c = JSON.parse(cache);
      S.varer = c.varer || {}; S.sal = c.sal || []; S.best = c.best || { ordrar: [] }; S.meta = c.meta || S.meta;
      const l = lokal ? JSON.parse(lokal) : null;
      S.app = l?.app || tomApp(); S.appSha = l?.sha || null; S.dirty = !!l?.dirty;
      S.calc = rekn(); S.lasta = true; render();
    } catch { }
  }
  try {
    const [varer, sal, best, app] = await Promise.all([lesRaw('varer.json'), lesRaw('sal.json'), lesRaw('bestillingar.json'), lesApp()]);
    S.varer = varer?.varer || {}; IDF = null;
    S.sal = (sal?.periodar || []).sort((a, b) => a.f < b.f ? -1 : 1);
    S.best = best || { ordrar: [] };
    S.meta = { salOppdatert: sal?.oppdatert || null, bestOppdatert: best?.oppdatert || null, registerImportert: varer?.registerImportert || null };
    const l = lokal ? JSON.parse(lokal) : null;
    if (l?.dirty && l.app) { S.app = flettApp(app.data, l.app); S.dirty = true; }
    else S.app = app.data;
    S.appSha = app.sha;
    ls.set(CFG.cacheKey, JSON.stringify({ varer: S.varer, sal: S.sal, best: S.best, meta: S.meta }));
    lagreLokalt();
    S.feil = null; S.lasta = true;
    S.calc = rekn();
    setSync(S.dirty ? 'lagrar' : 'ok', S.dirty ? 'Lagrar …' : 'Oppdatert');
    if (S.dirty) pushApp();
  } catch (e) {
    S.feil = e.message; S.lasta = true;
    setSync('feil', 'Kunne ikkje hente');
    if (!S.app) S.app = tomApp();
    if (!S.calc) S.calc = rekn();
  }
  render();
  klarRes();
}

/* ---------- utrekning ---------- */
function teljeGrense(t) {
  // Teljing før kl. 15.30 vert rekna som gjort ved opning (dagens sal vert trekt frå),
  // teljing etter 15.30 som gjort ved stenging (dagens sal er alt med i teljinga).
  const d = new Date(t);
  const opning = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10).getTime();
  const h = d.getHours() + d.getMinutes() / 60;
  if (h < 15.5) return opning;
  return opning + DAG;
}
function erMed(v, rec) {
  const inn = S.app?.innst?.[v];
  if (inn && typeof inn.med === 'boolean') return inn.med;
  return !rec.x;
}
function rekn() {
  const now = Date.now();
  const app = S.app || tomApp();
  const salV = new Map();
  for (const p of S.sal) {
    const f = ti(p.f), t = ti(p.t);
    for (const v in p.v) {
      let a = salV.get(v); if (!a) { a = []; salV.set(v, a); }
      a.push([f, t, p.v[v]]);
    }
  }
  const tel = new Map();
  for (const e of app.teljingar) {
    if (e.slett) continue;
    const f = tel.get(e.v);
    if (!f || e.t > f.t) tel.set(e.v, e);
  }
  const mot = new Map();
  const leggMot = (v, a, tid, kjelde, ref) => { let x = mot.get(v); if (!x) { x = []; mot.set(v, x); } x.push({ a, t: tid, kjelde, ref }); };
  for (const e of app.mottak) if (!e.slett) leggMot(e.v, e.a, new Date(e.t).getTime(), 'manuell', e);
  // ordrar frå e-post
  let utanKopling = 0;
  const kjemInn = [];
  for (const o of S.best.ordrar || []) {
    const st = app.ordre?.[o.id]?.status;
    if (st === 'ikkjelevert') continue;
    const lev = new Date((o.levering || o.dato) + 'T09:00:00').getTime();
    (o.linjer || []).forEach((l, i) => {
      const k = linjeKopling(o, l);
      if (!k) { if (!l.ign) utanKopling++; return; }
      if (k.ign) return;
      const stk = linjeStk(l, k);
      if (lev <= now) leggMot(k.v, stk, lev, 'ordre', { o, l, i });
      else kjemInn.push({ v: k.v, stk, lev, o });
    });
  }
  const varer = {};
  const alle = { ...S.varer };
  for (const [id, n] of Object.entries(app.nye || {})) if (!n.slett) alle[id] = { n: n.n, p: n.p, k: n.k || 'anna', ny: true };
  const sums = { talde: 0, med: 0, tomt: 0, lagt: 0, ikkjetalt: 0, verdi: 0, verdiTalde: 0, verdiInn: 0, medKp: 0 };
  const eanTil = {};
  for (const [ean, x] of Object.entries(app.ean || {})) if (x && x.v && !x.slett) (eanTil[x.v] ||= []).push(ean);
  for (const [v, rec] of Object.entries(alle)) {
    const med = erMed(v, rec);
    const s = salV.get(v) || [];
    let q7 = 0, q30 = 0, q90 = 0, q365 = 0, sist = null;
    for (const [f, t, a] of s) {
      const age = now - t;
      if (age <= 7 * DAG) q7 += a;
      if (age <= 30 * DAG) q30 += a;
      if (age <= 90 * DAG) q90 += a;
      if (age <= 365 * DAG) q365 += a;
      if (a > 0 && (!sist || f > sist)) sist = f;
    }
    const tl = tel.get(v);
    let lager = null, selt = 0, inn = 0;
    if (tl) {
      const T = new Date(tl.t).getTime();
      const C = teljeGrense(tl.t);
      for (const [f, t, a] of s) {
        if (t <= C) continue;
        const frac = Math.min(1, Math.max(0, (t - Math.max(C, f)) / (t - f)));
        selt += a * frac;
      }
      for (const m of mot.get(v) || []) if (m.t > T) inn += m.a;
      lager = tl.a + inn - selt;
    }
    const inst = app.innst?.[v] || {};
    const autoMin = q90 > 0 ? Math.max(1, Math.round(q90 / 90 * 7)) : 0;
    const min = typeof inst.min === 'number' ? inst.min : autoMin;
    let status = 'ok';
    if (lager == null) status = 'ikkjetalt';
    else if (lager <= 0) status = 'tomt';
    else if (min > 0 && lager <= min) status = 'lagt';
    const eans = [...new Set([...(rec.ean || []), ...(eanTil[v] || [])])];
    varer[v] = { v, n: rec.n, p: rec.p, k: rec.k || 'anna', x: rec.x, ny: !!rec.ny, med, lager, selt, inn, tl, q7, q30, q90, q365, sist, min, autoMin: typeof inst.min !== 'number', status, eans };
    if (med) {
      sums.med++;
      if (status === 'ikkjetalt') sums.ikkjetalt++;
      else {
        sums.talde++;
        if (status === 'tomt') sums.tomt++;
        if (status === 'lagt') sums.lagt++;
        if (lager > 0 && rec.p) sums.verdi += lager * rec.p;
        if (lager > 0 && rec.kp) { sums.verdiInn += lager * rec.kp; sums.medKp++; }
      }
    }
  }
  const eanKart = {};
  for (const [v, x] of Object.entries(varer)) for (const e of x.eans) eanKart[e] = v;
  const sistePeriode = S.sal.length ? S.sal[S.sal.length - 1] : null;
  return { varer, sums, utanKopling, kjemInn, eanKart, sistePeriode, mot };
}
function linjeNokkel(o, l) { return (o.leverandor || 'ukjend') + ':' + (l.art || norm(l.namn)); }
function linjeKopling(o, l) { return S.app?.kopling?.[linjeNokkel(o, l)] || null; }
function linjeStk(l, k) {
  const f = k && typeof k.f === 'number' ? k.f : null;
  if (f != null && (l.kolli != null || l.anbr != null)) return (l.kolli || 0) * f + (l.anbr || 0);
  if (typeof l.stk === 'number') return l.stk;
  return (l.kolli || 0) * (l.faktor || 1) + (l.anbr || 0);
}

/* ---------- søk og samanlikning ---------- */
const fold = s => norm(s).replace(/[äáàâ]/g, 'a').replace(/[öóòô]/g, 'o').replace(/[éèêë]/g, 'e').replace(/[üúù]/g, 'u').replace(/[íì]/g, 'i').replace(/`|´|'/g, '');
function einingar(s) {
  return fold(s)
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/(\d+(?:\.\d+)?)\s*(ml|cl|dl|l|ltr|liter|g|gr|kg|stk|pk)\b/g, (m, n, u) => {
      n = parseFloat(n);
      if (u === 'cl') return Math.round(n * 10) + 'ml';
      if (u === 'dl') return Math.round(n * 100) + 'ml';
      if (u === 'l' || u === 'ltr' || u === 'liter') return Math.round(n * 1000) + 'ml';
      if (u === 'kg') return Math.round(n * 1000) + 'g';
      if (u === 'gr') return n + 'g';
      return n + u;
    });
}
const STOPP = new Set(['og', 'med', 'm', 'i', 'til', 'for', 'av', 'fl', 'bx', 'pk', 'stk', 'x', 'the', 'a', 'as', 'norge', 'norway']);
function ord(s) { return einingar(s).split(/[^a-z0-9æøå.]+/).filter(t => t && t.length > 1 && !STOPP.has(t)); }
let IDF = null;
function idf(t) {
  if (!IDF) {
    const df = new Map(); let n = 0;
    for (const r of Object.values(S.varer)) { n++; for (const t of new Set(ord(r.n))) df.set(t, (df.get(t) || 0) + 1); }
    IDF = { df, n };
  }
  return Math.log((IDF.n + 1) / ((IDF.df.get(t) || 0) + 1)) + 0.5;
}
function likskap(a, b) {
  const ta = [...new Set(ord(a))], tb = [...new Set(ord(b))];
  if (!ta.length || !tb.length) return 0;
  const sb = new Set(tb);
  let treff = 0, totA = 0, totB = 0;
  for (const t of ta) {
    const w = idf(t); totA += w;
    if (sb.has(t)) treff += w;
    else if (t.length >= 4 && tb.some(u => u.length >= 4 && (u.startsWith(t) || t.startsWith(u)))) treff += w * 0.6;
  }
  for (const u of tb) totB += idf(u);
  return treff / (totA * 0.6 + totB * 0.4);
}
function foreslaa(tekst, n = 8) {
  const c = S.calc?.varer || {};
  const ut = [];
  for (const x of Object.values(c)) {
    if (x.x === 'generisk' || x.x === 'teneste') continue;
    const sc = likskap(tekst, x.n);
    if (sc > 0.12) ut.push([sc, x]);
  }
  ut.sort((a, b) => b[0] - a[0] || (b[1].q365 - a[1].q365));
  return ut.slice(0, n);
}
function sokVarer(q) {
  const c = S.calc?.varer || {};
  const toks = norm(q).split(' ').filter(Boolean);
  const res = [];
  for (const x of Object.values(c)) {
    if (!S.lager.utelatne && !x.med) continue;
    if (!toks.length) { res.push(x); continue; }
    const hay = norm(x.n) + ' ' + x.v + ' ' + x.eans.join(' ');
    if (toks.every(t => hay.includes(t))) res.push(x);
  }
  return res;
}

/* ---------- ruting og render ---------- */
function rute() {
  const h = (location.hash || '#oversikt').slice(1);
  const v = ['oversikt', 'lager', 'skann', 'mottak', 'meir'].includes(h) ? h : 'oversikt';
  if (S.view === 'skann' && v !== 'skann') stoppKamera();
  S.view = v;
  document.querySelectorAll('.nav a').forEach(a => { if (a.dataset.v === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  render();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', rute);

function render() {
  const m = $('#innhald');
  const merke = $('#mottak-merke');
  if (S.calc?.utanKopling) { merke.textContent = S.calc.utanKopling; merke.classList.remove('skjult'); } else merke.classList.add('skjult');
  if (!S.lasta) return;
  if (!getToken() && S.view !== 'meir') { m.innerHTML = visKomIGang(); return; }
  if (S.view === 'oversikt') m.innerHTML = visOversikt();
  else if (S.view === 'lager') { m.innerHTML = visLager(); bindLager(); }
  else if (S.view === 'skann') { m.innerHTML = visSkann(); bindSkann(); }
  else if (S.view === 'mottak') m.innerHTML = visMottak();
  else if (S.view === 'meir') { m.innerHTML = visMeir(); }
}

function feilBoks() { return S.feil ? `<div class="melding raud"><b>Kunne ikkje hente nye data.</b> ${esc(S.feil)} ${S.calc ? 'Du ser siste lagra utgåve.' : ''} <button class="lenke" data-a="last">Prøv igjen</button></div>` : ''; }

function visKomIGang() {
  return `
  <h1 class="side-tittel">Velkomen</h1>
  <p class="ingress">Varelageret hentar sal frå kassa og bestillingar frå e-posten kvar dag. For å lese og lagre tala treng appen eit GitHub-token på denne eininga.</p>
  ${tokenKort()}`;
}
function tokenKort() {
  const har = !!getToken();
  return `<section class="kort meir-kort">
    <h2>${har ? 'Tilkopla GitHub' : 'Kople til GitHub'}</h2>
    ${har ? `<p>Denne eininga har eit token lagra. Lagerdata ligg i det private repoet <span class="kode">Krambua-varelager-data</span>.</p>
      <div class="val"><button class="knapp liten" data-a="byt-token">Byt token</button><button class="knapp liten stille" data-a="fjern-token">Fjern token frå eininga</button></div>` :
      `<ol class="steg">
        <li>Opne <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub → Fine-grained token</a>.</li>
        <li>Namn: <code>Krambua varelager</code>. Utløp: 1 år (eller «No expiration»).</li>
        <li>Repository access: <b>Only select repositories</b> → <code>Krambua-varelager-data</code>.</li>
        <li>Permissions → Repository permissions → <b>Contents: Read and write</b>.</li>
        <li>Trykk «Generate token», kopier det og lim det inn her.</li>
      </ol>
      <label class="etikett" for="token">Token</label>
      <input class="felt" id="token" type="password" autocomplete="off" placeholder="github_pat_…">
      <div class="val"><button class="knapp primar" data-a="lagre-token">Kople til</button></div>`}
  </section>`;
}

function visOversikt() {
  const c = S.calc;
  if (!c) return feilBoks();
  const s = c.sums;
  const prosent = s.med ? Math.round(s.talde / s.med * 100) : 0;
  const varer = Object.values(c.varer).filter(x => x.med);
  const bor = varer.filter(x => (x.status === 'tomt' || x.status === 'lagt') && x.q90 > 0)
    .sort((a, b) => (a.lager - a.min) - (b.lager - b.min) || b.q30 - a.q30).slice(0, 8);
  const topp = varer.filter(x => x.q7 > 0).sort((a, b) => b.q7 - a.q7).slice(0, 8);
  const sp = c.sistePeriode;
  const oppstart = s.talde < s.med * 0.9;
  const kjem = groupKjem(c.kjemInn);
  return `${feilBoks()}
  <h1 class="side-tittel">${oppstart ? 'Oppstartsteljing' : 'Lageret i dag'}</h1>
  <p class="ingress">${oppstart ? 'Skann kvar vare på hylla og skriv inn kor mange det står. Når ei vare er talt, held appen sjølv styr på sal og mottak.' : 'Sal frå kassa vert trekt frå kvar dag, og bestillingar frå e-posten vert lagde til når dei er leverte.'}</p>
  ${oppstart ? `<section class="kort oppstart">
    <div class="tal">${fmtTal(s.talde)}<small>av ${fmtTal(s.med)} varer er talde</small></div>
    <div class="stolpe" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${prosent}"><i style="width:${prosent}%"></i></div>
    <div class="val"><a class="knapp primar" href="#skann">${IKON.kamera} Start teljing</a><a class="knapp" href="#lager" data-a="filter-ikkjetalt">Sjå kva som manglar</a></div>
  </section>` : ''}
  <div class="seksjon">
    <div class="hyllelapp-rad">
      <button class="hyllelapp tomt" data-a="filter" data-s="tomt"><b>${fmtTal(s.tomt)}</b><span>Tomt</span></button>
      <button class="hyllelapp lagt" data-a="filter" data-s="lagt"><b>${fmtTal(s.lagt)}</b><span>Lågt</span></button>
      <button class="hyllelapp ikkjetalt" data-a="filter" data-s="ikkjetalt"><b>${fmtTal(s.ikkjetalt)}</b><span>Ikkje talt</span></button>
    </div>
    <div class="fakta">
      <span>Lagerverdi (utsalspris, talde varer): <b>${fmtKr(s.verdi)}</b></span>
      ${s.medKp ? `<span>Til innkjøpspris eks. mva: <b>${fmtKr(s.verdiInn)}</b></span>` : ''}
      <span>Sal henta t.o.m.: <b>${sp ? fmtDato(sp.t) + ' kl. 10' : '–'}</b></span>
    </div>
  </div>
  <section class="seksjon">
    <div class="seksjon-hovud"><h2>Bør bestillast</h2><a href="#lager" data-a="filter" data-s="lagt">Sjå alle</a></div>
    <div class="kort"><ul class="liste">${bor.length ? bor.map(radHTML).join('') : `<li class="tom">${s.talde ? 'Ingen talde varer er under minimum.' : 'Når varer er talde, ser du her kva som snart er tomt.'}</li>`}</ul></div>
  </section>
  <section class="seksjon">
    <div class="seksjon-hovud"><h2>Kjem inn</h2><a href="#mottak">Mottak</a></div>
    <div class="kort"><ul class="liste">${kjem.length ? kjem.map(k => `<li><div class="rad"><span class="namn">${esc(k.o.leverandor)} · ordre ${esc(k.o.ordrenr || '')}</span><span class="meta">Levering ${fmtDato(k.o.levering || k.o.dato)} · ${k.n} varelinjer</span><span class="lager"><b>${fmtTal(k.stk)}</b><span class="status ikkjetalt">stk</span></span></div></li>`).join('') : '<li class="tom">Ingen bestillingar på veg.</li>'}</ul></div>
  </section>
  <section class="seksjon">
    <div class="seksjon-hovud"><h2>Mest selt siste 7 dagar</h2></div>
    <div class="kort"><ul class="liste">${topp.length ? topp.map(x => radHTML(x, `Selt ${fmtLager(x.q7)} siste 7 d`)).join('') : '<li class="tom">Ingen sal registrert siste veka.</li>'}</ul></div>
  </section>`;
}
function groupKjem(list) {
  const m = new Map();
  for (const k of list) { const g = m.get(k.o.id) || { o: k.o, stk: 0, n: 0 }; g.stk += k.stk; g.n++; m.set(k.o.id, g); }
  return [...m.values()].sort((a, b) => (a.o.levering || '') < (b.o.levering || '') ? -1 : 1);
}
const STATUS_TEKST = { ok: 'OK', lagt: 'Lågt', tomt: 'Tomt', ikkjetalt: 'Ikkje talt' };
function radHTML(x, metaTekst) {
  const meta = metaTekst || [x.v, katNamn(x.k), x.q30 ? `selt ${fmtLager(x.q30)} siste 30 d` : (x.sist ? 'sist selt ' + fmtDato(new Date(x.sist).toISOString().slice(0, 10)) : '')].filter(Boolean).join(' · ');
  return `<li><button class="rad" data-a="vare" data-v="${esc(x.v)}">
    <span class="namn">${esc(x.n)}</span>
    <span class="meta">${esc(meta)}</span>
    <span class="lager"><b class="${x.lager == null ? 'null' : ''}">${x.lager == null ? '–' : fmtLager(x.lager)}</b><span class="status ${x.status}">${STATUS_TEKST[x.status]}</span></span>
  </button></li>`;
}

/* ---------- Lager ---------- */
function visLager() {
  const c = S.calc; if (!c) return feilBoks();
  const L = S.lager;
  let list = sokVarer(L.q);
  if (L.kat) list = list.filter(x => x.k === L.kat);
  const tel = { alle: list.length, lagt: 0, tomt: 0, ikkjetalt: 0, ok: 0 };
  for (const x of list) tel[x.status]++;
  if (L.status === 'lagt') list = list.filter(x => x.status === 'lagt' || x.status === 'tomt');
  else if (L.status !== 'alle') list = list.filter(x => x.status === L.status);
  list.sort((a, b) => {
    if (L.status === 'lagt') return (a.lager - a.min) - (b.lager - b.min);
    if (L.q) return b.q365 - a.q365;
    return a.n.localeCompare(b.n, 'nb');
  });
  const kat = Object.entries(window.KATEGORI_NAMN || {}).sort((a, b) => a[1].localeCompare(b[1], 'nb'));
  const vis = list.slice(0, L.vis);
  return `${feilBoks()}
  <div class="verktoy">
    <div class="sok">${IKON.sok}<input class="felt" id="lager-sok" type="search" placeholder="Søk på namn, varenummer eller strekkode" value="${esc(L.q)}" autocomplete="off"></div>
    <div class="chips" role="group" aria-label="Filter">
      ${[['alle', 'Alle'], ['lagt', 'Bør bestillast'], ['tomt', 'Tomt'], ['ikkjetalt', 'Ikkje talt'], ['ok', 'OK']].map(([k, t]) => `<button class="chip" data-a="status" data-s="${k}" aria-pressed="${L.status === k}">${t}<small>${fmtTal(k === 'lagt' ? tel.lagt + tel.tomt : tel[k])}</small></button>`).join('')}
      <select class="chip" id="lager-kat" aria-label="Kategori"><option value="">Alle kategoriar</option>${kat.map(([k, n]) => `<option value="${k}" ${L.kat === k ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
    </div>
  </div>
  <div class="kort"><ul class="liste">${vis.length ? vis.map(x => radHTML(x)).join('') : '<li class="tom">Ingen varer passar søket.</li>'}</ul>
  ${list.length > vis.length ? `<div class="meir-rad"><button class="knapp liten" data-a="vis-fleire">Vis fleire (${fmtTal(list.length - vis.length)} til)</button></div>` : ''}</div>`;
}
function bindLager() {
  const inp = $('#lager-sok');
  let t = null;
  inp?.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { S.lager.q = inp.value; S.lager.vis = 150; oppdaterLagerListe(); }, 160); });
  $('#lager-kat')?.addEventListener('change', e => { S.lager.kat = e.target.value; S.lager.vis = 150; oppdaterLagerListe(); });
}
function oppdaterLagerListe() {
  const pos = $('#lager-sok')?.selectionStart;
  const m = $('#innhald'); m.innerHTML = visLager(); bindLager();
  const inp = $('#lager-sok'); if (inp && document.activeElement !== inp && S.lager.q) { inp.focus(); try { inp.setSelectionRange(pos, pos); } catch { } }
}

/* ---------- Vareark ---------- */
function opneVare(v) {
  const x = S.calc?.varer[v]; if (!x) return;
  const hist = historikk(v).slice(0, 40);
  const inst = S.app.innst?.[v] || {};
  visArk(`
    <h2>${esc(x.n)}</h2>
    <div class="sub">${esc(x.v)} · ${esc(katNamn(x.k))}${x.p ? ' · ' + fmtKr(x.p) : ''}${x.x && !x.med ? ' · utelaten (' + esc(x.x) + ')' : ''}</div>
    <div class="ark-lager">
      <div class="storttal ${x.lager == null ? 'null' : ''}">${x.lager == null ? 'Ikkje talt' : fmtLager(x.lager)}<small>${x.lager == null ? 'Skann vara og tel ho for å starte' : 'på lager no'}</small></div>
      <span class="status ${x.status}">${STATUS_TEKST[x.status]}</span>
    </div>
    ${x.tl ? `<div class="sub">Sist talt ${fmtDato(x.tl.t, true)}: ${fmtLager(x.tl.a)} stk${x.tl.av ? ' (' + esc(x.tl.av) + ')' : ''}. Sidan då: +${fmtLager(x.inn)} mottak, −${fmtLager(x.selt)} selt.</div>` : ''}
    <div class="ark-handling">
      <button class="knapp primar" data-a="ark-tel" data-v="${esc(v)}">Tel</button>
      <button class="knapp" data-a="ark-mottak" data-v="${esc(v)}">Mottak</button>
      <button class="knapp" data-a="ark-ean" data-v="${esc(v)}">Strekkode</button>
    </div>
    <div class="tal-rad">
      <div><b>${fmtLager(x.q7)}</b><span>selt 7 d</span></div>
      <div><b>${fmtLager(x.q30)}</b><span>selt 30 d</span></div>
      <div><b>${fmtLager(x.q90)}</b><span>selt 90 d</span></div>
      <div><b>${fmtLager(x.q365)}</b><span>selt 1 år</span></div>
    </div>
    <label class="etikett" for="ark-min">Minimum på lager ${x.autoMin ? '(automatisk: ca. éi vekes sal)' : ''}</label>
    <div class="manuell" style="margin-top:0"><input class="felt" id="ark-min" type="number" inputmode="numeric" min="0" placeholder="${x.autoMin ? x.min : ''}" value="${x.autoMin ? '' : x.min}"><button class="knapp" data-a="ark-min" data-v="${esc(v)}">Lagre</button></div>
    <label class="etikett">Strekkodar</label>
    <div class="strekkodar">${x.eans.length ? x.eans.map(e => `<span>${esc(e)}${S.app.ean?.[e] ? `<button aria-label="Fjern ${esc(e)}" data-a="fjern-ean" data-e="${esc(e)}" data-v="${esc(v)}">×</button>` : ''}</span>`).join('') : '<span style="background:none;padding-left:0;color:var(--blekk-3)">Ingen enno – blir lagt til når du skannar vara.</span>'}</div>
    <label class="brytar"><input type="checkbox" data-a="ark-med" data-v="${esc(v)}" ${x.med ? 'checked' : ''}> Ta med i varelageret</label>
    <label class="etikett">Historikk</label>
    <ul class="hist">${hist.length ? hist.map(h => `<li><time>${fmtDato(h.d, h.tid)}</time><span>${esc(h.tekst)}</span><b class="${h.kl}">${h.tal}</b></li>`).join('') : '<li><span style="grid-column:1/-1;color:var(--blekk-3)">Ingen hendingar enno.</span></li>'}</ul>
  `);
}
function historikk(v) {
  const ut = [];
  for (const e of S.app.teljingar) if (e.v === v && !e.slett) ut.push({ ts: new Date(e.t).getTime(), d: e.t, tid: true, tekst: 'Teljing' + (e.av ? ' (' + e.av + ')' : ''), tal: '= ' + fmtLager(e.a), kl: 'tel' });
  for (const m of S.calc.mot.get(v) || []) ut.push({ ts: m.t, d: new Date(m.t).toISOString(), tid: m.kjelde === 'manuell', tekst: m.kjelde === 'ordre' ? `Mottak ${m.ref.o.leverandor}` : 'Mottak (manuelt)', tal: '+' + fmtLager(m.a), kl: 'pluss' });
  for (const p of S.sal) if (p.v[v]) ut.push({ ts: ti(p.f), d: p.f, tid: false, tekst: p.t > addDag(p.f, 1) ? `Sal ${fmtDato(p.f)}–${fmtDato(p.t)}` : 'Sal', tal: '−' + fmtLager(p.v[v]), kl: 'minus' });
  return ut.sort((a, b) => b.ts - a.ts);
}
function addDag(d, n) { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); }

function visArk(html, opt = {}) {
  const rot = $('#ark-rot');
  rot.innerHTML = `<div class="ark-bak" data-a="lukk-bak"><div class="ark" role="dialog" aria-modal="true"><div class="handtak"></div><button class="lukk" data-a="lukk" aria-label="Lukk">${IKON.lukk}</button>${html}</div></div>`;
  S.arkOpen = opt;
  if (opt.fokus) rot.querySelector(opt.fokus)?.focus();
}
function lukkArk() { $('#ark-rot').innerHTML = ''; S.arkOpen = null; }
document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.arkOpen) lukkArk(); });

/* ---------- handlingar ---------- */
function nyTeljing(v, a) {
  const e = { id: nyId(), v, a: Math.max(0, Number(a) || 0), t: naa(), av: brukar() || undefined };
  S.app.teljingar.push(e);
  endra();
  return e;
}
function nyttMottak(v, a, notat) {
  const e = { id: nyId(), v, a: Number(a) || 0, t: naa(), av: brukar() || undefined, notat };
  S.app.mottak.push(e);
  endra();
  return e;
}
function angre(type, id) {
  const e = S.app[type].find(x => x.id === id);
  if (e) { e.slett = true; e.e = naa(); endra(); render(); }
}
function koplaEan(ean, v) {
  S.app.ean[ean] = { v, t: naa() };
  endra();
}

document.addEventListener('click', async ev => {
  const el = ev.target.closest('[data-a]');
  if (!el) return;
  const a = el.dataset.a;
  if (a === 'lukk-bak' && ev.target !== el) return;
  switch (a) {
    case 'lukk': case 'lukk-bak': lukkArk(); break;
    case 'tema': settTema(effektivtTema() === 'mork' ? 'lys' : 'mork'); break;
    case 'tema-val': settTema(el.dataset.t); render(); break;
    case 'lukk-res': S.skann.vare = null; S.skann.ukjend = null; S.skann.tal = ''; renderResultat(); break;
    case 'last': last(); break;
    case 'vare': opneVare(el.dataset.v); break;
    case 'filter': case 'filter-ikkjetalt':
      S.lager.status = el.dataset.s || 'ikkjetalt'; S.lager.q = ''; S.lager.kat = ''; S.lager.vis = 150;
      if (location.hash !== '#lager') { ev.preventDefault(); location.hash = '#lager'; } else render();
      break;
    case 'status': S.lager.status = el.dataset.s; S.lager.vis = 150; oppdaterLagerListe(); break;
    case 'vis-fleire': S.lager.vis += 300; oppdaterLagerListe(); break;
    case 'ark-tel': lukkArk(); startSkannFor(el.dataset.v, 'telling'); break;
    case 'ark-mottak': lukkArk(); startSkannFor(el.dataset.v, 'mottak'); break;
    case 'ark-ean': lukkArk(); S.skann.leggTilEanFor = el.dataset.v; S.skann.modus = 'sjekk'; location.hash = '#skann'; toast('Skann strekkoden som skal høyre til vara.'); break;
    case 'ark-min': {
      const v = el.dataset.v, val = $('#ark-min').value.trim();
      S.app.innst[v] = { ...(S.app.innst[v] || {}), t: naa() };
      if (val === '') delete S.app.innst[v].min; else S.app.innst[v].min = Math.max(0, Number(val));
      endra(); render(); opneVare(v); toast('Minimum lagra.');
      break;
    }
    case 'ark-med': {
      const v = el.dataset.v;
      S.app.innst[v] = { ...(S.app.innst[v] || {}), med: el.checked, t: naa() };
      endra(); render();
      break;
    }
    case 'fjern-ean': {
      const e = el.dataset.e;
      S.app.ean[e] = { v: null, slett: true, t: naa() };
      endra(); opneVare(el.dataset.v);
      break;
    }
    case 'lagre-token': {
      const t = $('#token').value.trim();
      if (!t) { toast('Lim inn tokenet først.', { feil: true }); return; }
      ls.set(CFG.tokenKey, t); toast('Koplar til …'); S.lasta = false; await last();
      if (!S.feil) { toast('Tilkopla. Lagerdata er henta.'); location.hash = '#oversikt'; }
      break;
    }
    case 'byt-token': ls.del(CFG.tokenKey); render(); break;
    case 'fjern-token': ls.del(CFG.tokenKey); setSync('av', 'Ikkje tilkopla'); render(); toast('Tokenet er fjerna frå denne eininga.'); break;
    case 'lagre-namn': ls.set(CFG.namnKey, $('#namn').value.trim()); toast('Namnet er lagra.'); break;
    case 'eksport': eksporterCSV(); break;
    case 'nullstill-rest': nullstillRest(); break;
    case 'importer-register': {
      if (!registerUtkast) break;
      el.disabled = true; el.textContent = 'Importerer …';
      try {
        const r = await importerRegister(registerUtkast);
        registerUtkast = null;
        toast(`Ferdig: ${fmtTal(r.oppdatert)} varer oppdaterte, ${fmtTal(r.nye)} nye, ${fmtTal(r.eanTal)} strekkodar.`);
        render();
      } catch (e) { toast(e.message, { feil: true }); el.disabled = false; el.textContent = 'Prøv igjen'; }
      break;
    }
    case 'vis-utelatne': S.lager.utelatne = el.checked; break;
    // skann
    case 'modus': S.skann.modus = el.dataset.m; ls.set(CFG.modusKey, S.skann.modus); S.skann.tal = ''; render(); break;
    case 'kamera-start': startKamera(); break;
    case 'kamera-stopp': stoppKamera(); break;
    case 'lykt': byttLykt(); break;
    case 'manuell-sok': { const v = $('#manuell').value.trim(); if (v) handterKode(v, true); break; }
    case 'tast': tast(el.dataset.k); break;
    case 'lagre-tal': lagreTal(); break;
    case 'legg-til-modus': S.skann.leggTil = el.dataset.m === 'legg'; renderResultat(); break;
    case 'kvar-eining': S.skann.kvar = el.checked; break;
    case 'kople-ean': koplaEan(S.skann.ukjend.kode, el.dataset.v); visVareIResultat(el.dataset.v, S.skann.ukjend.kode); S.skann.ukjend = null; toast('Strekkoden er kopla til vara.'); break;
    case 'ny-vare': nyVareSkjema(); break;
    case 'lagre-ny-vare': lagreNyVare(); break;
    case 'angre': angre(el.dataset.type, el.dataset.id); el.closest('.toast')?.remove(); break;
    // mottak
    case 'kople-linje': opneKopling(el.dataset.o, Number(el.dataset.i)); break;
    case 'ign-linje': { const { o, l } = finnLinje(el.dataset.o, Number(el.dataset.i)); S.app.kopling[linjeNokkel(o, l)] = { ign: true, t: naa() }; endra(); render(); toast('Merkt som ikkje lagervare.'); break; }
    case 'vel-kopling': lagreKopling(el.dataset.v); break;
    case 'stadfest-forslag': {
      const { o, l } = finnLinje(el.dataset.o, Number(el.dataset.i));
      S.app.kopling[linjeNokkel(o, l)] = { v: l.forslag, f: l.faktor || 1, t: naa() };
      endra(); render(); toast(`Kopla til ${S.calc.varer[l.forslag]?.n || l.forslag}.`);
      break;
    }
    case 'ordre-status': {
      const id = el.dataset.o, st = el.dataset.s;
      S.app.ordre[id] = { status: st, t: naa() }; endra(); render();
      break;
    }
    case 'manuelt-mottak': S.skann.modus = 'mottak'; location.hash = '#skann'; break;
  }
});

/* ---------- Skann ---------- */
function visSkann() {
  const sk = S.skann;
  const tekst = { telling: 'Skann vara og skriv kor mange som står på hylla. Talet erstattar det appen trur er på lager.', mottak: 'Skann varer som kjem inn utan e-postbestilling, og skriv kor mange.', sjekk: 'Skann ei vare for å sjå lagerstatus og historikk.' }[sk.modus];
  return `${feilBoks()}<div class="skann-side">
  <div class="modus" role="group" aria-label="Kva vil du gjere">
    ${[['telling', 'Tel'], ['mottak', 'Mottak'], ['sjekk', 'Sjekk']].map(([k, t]) => `<button data-a="modus" data-m="${k}" aria-pressed="${sk.modus === k}">${t}</button>`).join('')}
  </div>
  <p class="modus-tekst">${sk.leggTilEanFor ? '<b>Legg til strekkode:</b> skann strekkoden til ' + esc(S.calc?.varer[sk.leggTilEanFor]?.n || '') : tekst}</p>
  <div class="kamera-boks ${kamera.aktiv ? 'aktiv' : ''}" id="kamera-boks">
    <div id="kamera"></div>
    <div class="sikte" aria-hidden="true"><i></i><i></i><i></i><i></i><div class="laser"></div></div>
    <div class="kamera-knappar">${kameraKnappar()}</div>
    ${kamera.aktiv ? '' : `<div class="start">${IKON.kamera}<button class="knapp primar" data-a="kamera-start">Start kamera</button><span style="font-size:13px">Hald telefonen 15–25 cm frå strekkoden. Handskannar eller å skrive inn nummeret under fungerer òg.</span></div>`}
  </div>
  <form class="manuell" id="manuell-form" autocomplete="off">
    <input class="felt" id="manuell" inputmode="search" placeholder="Strekkode, varenummer eller namn" aria-label="Strekkode, varenummer eller namn">
    <button class="knapp" data-a="manuell-sok" type="submit">Finn</button>
  </form>
  <div id="resultat"></div></div>`;
}
function bindSkann() {
  $('#manuell-form')?.addEventListener('submit', e => { e.preventDefault(); });
  renderResultat();
  // kamera-elementet vart teikna på nytt: flytt den same videoen inn att i staden for å starte kameraet på nytt
  if (kamera.aktiv && kamera.video) $('#kamera')?.replaceChildren(kamera.video);
}

/* Eige kameraoppsett: video med object-fit: cover, og vi les berre utsnittet som faktisk er synleg i sikteramma.
   Strekkodar vert lesne med telefonen sin innebygde BarcodeDetector (Android) eller zxing-wasm (iPhone m.fl.). */
const kamera = { aktiv: false, lastar: false, straum: null, video: null, detektor: null, lopar: false, lykt: false, lyktPaa: false, kandidat: { kode: '', n: 0, t: 0 } };
const FORMAT = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];
function lastSkript(src) {
  return new Promise((ok, feil) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok();
    const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => feil(new Error('Kunne ikkje laste strekkodelesaren.'));
    document.head.appendChild(s);
  });
}
async function hentDetektor() {
  if (kamera.detektor) return kamera.detektor;
  if ('BarcodeDetector' in window && !/[?&]zxing=1/.test(location.search)) {
    try {
      const st = await window.BarcodeDetector.getSupportedFormats();
      if (st.includes('ean_13')) return (kamera.detektor = new window.BarcodeDetector({ formats: FORMAT.filter(f => st.includes(f)) }));
    } catch { }
  }
  await lastSkript('lib/strekkode.js?v=1');
  kamera.detektor = new window.KrambuaBarcodeDetector({ formats: FORMAT });
  return kamera.detektor;
}
function kameraKnappar() {
  if (!kamera.aktiv) return '';
  return `${kamera.lykt ? `<button class="kamera-knapp" data-a="lykt" aria-pressed="${kamera.lyktPaa}">${kamera.lyktPaa ? 'Lykt av' : 'Lykt'}</button>` : ''}<button class="kamera-knapp" data-a="kamera-stopp">Stopp kamera</button>`;
}
function oppdaterKameraBoks() {
  const boks = $('#kamera-boks'); if (!boks) return;
  boks.classList.toggle('aktiv', kamera.aktiv);
  const k = boks.querySelector('.kamera-knappar'); if (k) k.innerHTML = kameraKnappar();
  const st = boks.querySelector('.start'); if (st && kamera.aktiv) st.remove();
}
function kameraFeil(e) {
  const n = e?.name || '', m = String(e?.message || e);
  if (n === 'NotAllowedError' || /denied|not allowed|permission/i.test(m)) return 'Appen fekk ikkje bruke kameraet. På iPhone: Innstillingar → Safari → Kamera → «Tillat», og last sida på nytt.';
  if (n === 'NotFoundError') return 'Fann ikkje noko kamera på denne eininga.';
  if (n === 'NotReadableError') return 'Kameraet er i bruk av ein annan app. Lukk den og prøv igjen.';
  if (!navigator.mediaDevices) return 'Kameraet er ikkje tilgjengeleg her. Opne appen direkte i Safari eller Chrome (ikkje inne i ein annan app).';
  return 'Kameraet kunne ikkje startast: ' + m;
}
async function startKamera() {
  if (kamera.lastar || kamera.aktiv) return;
  kamera.lastar = true;
  const detP = hentDetektor().catch(e => e);
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('mediaDevices manglar');
    let straum;
    try {
      straum = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
    } catch (e) {
      if (e?.name !== 'OverconstrainedError' && e?.name !== 'TypeError') throw e;
      straum = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'environment' } });
    }
    kamera.straum = straum;
    const v = document.createElement('video');
    v.setAttribute('playsinline', ''); v.setAttribute('muted', ''); v.muted = true; v.autoplay = true;
    v.srcObject = straum;
    $('#kamera')?.replaceChildren(v);
    kamera.video = v;
    await v.play().catch(() => { });
    const spor = straum.getVideoTracks()[0];
    try {
      const cap = spor.getCapabilities ? spor.getCapabilities() : {};
      if (cap.focusMode && cap.focusMode.includes('continuous')) await spor.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
      kamera.lykt = !!cap.torch;
    } catch { }
    const det = await detP;
    if (det instanceof Error) throw det;
    kamera.aktiv = true; kamera.lyktPaa = false;
    oppdaterKameraBoks();
    lesLoop();
  } catch (e) {
    stoppKamera();
    toast(kameraFeil(e), { feil: true });
  } finally { kamera.lastar = false; }
}
function stoppKamera() {
  kamera.aktiv = false;
  try { kamera.straum?.getTracks().forEach(t => t.stop()); } catch { }
  kamera.straum = null;
  if (kamera.video) { kamera.video.srcObject = null; kamera.video.remove(); }
  kamera.video = null; kamera.lyktPaa = false;
  oppdaterKameraBoks();
  return Promise.resolve();
}
async function byttLykt() {
  const spor = kamera.straum?.getVideoTracks()[0]; if (!spor) return;
  try { await spor.applyConstraints({ advanced: [{ torch: !kamera.lyktPaa }] }); kamera.lyktPaa = !kamera.lyktPaa; oppdaterKameraBoks(); } catch { toast('Lykta kunne ikkje slåast på.', { feil: true }); }
}
// Kva del av videoen som er synleg i boksen (object-fit: cover), i videopikslar
function synlegUtsnitt(v, heile) {
  const vw = v.videoWidth, vh = v.videoHeight;
  const r = v.getBoundingClientRect();
  const cw = r.width || vw, ch = r.height || vh;
  const sc = Math.max(cw / vw, ch / vh);
  let sw = cw / sc, sh = ch / sc;
  let sx = (vw - sw) / 2, sy = (vh - sh) / 2;
  if (!heile) { const bh = sh * 0.62; sy += (sh - bh) / 2; sh = bh; }
  const k = Math.min(1, 1600 / sw);
  return { sx, sy, sw, sh, w: Math.max(1, Math.round(sw * k)), h: Math.max(1, Math.round(sh * k)) };
}
const lerret = document.createElement('canvas');
const lerretCtx = lerret.getContext('2d', { willReadFrequently: true });
async function lesLoop() {
  if (kamera.lopar) return;
  kamera.lopar = true;
  let n = 0;
  try {
    while (kamera.aktiv) {
      const v = kamera.video;
      if (v && v.readyState >= 2 && v.videoWidth && document.visibilityState === 'visible') {
        try {
          const u = synlegUtsnitt(v, n % 3 === 2);
          if (lerret.width !== u.w || lerret.height !== u.h) { lerret.width = u.w; lerret.height = u.h; }
          lerretCtx.drawImage(v, u.sx, u.sy, u.sw, u.sh, 0, 0, u.w, u.h);
          const res = await kamera.detektor.detect(lerret);
          const treff = res.find(r => r.rawValue);
          if (treff) godtaKode(treff.rawValue.trim(), treff.format);
        } catch { }
        n++;
      }
      await new Promise(r => setTimeout(r, 70));
    }
  } finally { kamera.lopar = false; }
}
// EAN/UPC har kontrollsiffer og vert godtekne med ein gong; andre format må lesast likt to gonger
function godtaKode(kode, format) {
  if (!kode) return;
  const sikker = /^(ean_13|ean_8|upc_a|upc_e)$/.test(format || '') && /^\d{8,13}$/.test(kode);
  const c = kamera.kandidat, now = Date.now();
  if (!sikker) {
    if (c.kode === kode && now - c.t < 1500) c.n++; else { c.kode = kode; c.n = 1; }
    c.t = now;
    if (c.n < 2) return;
  }
  handterKode(kode);
}

let lyd = null;
function pip(ok = true) {
  try {
    lyd ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = lyd.createOscillator(), g = lyd.createGain();
    o.frequency.value = ok ? 1320 : 330; g.gain.value = 0.06;
    o.connect(g); g.connect(lyd.destination); o.start(); o.stop(lyd.currentTime + (ok ? 0.07 : 0.18));
  } catch { }
  try { navigator.vibrate?.(ok ? 30 : [60, 40, 60]); } catch { }
}

function finnVareForKode(kode) {
  const c = S.calc; if (!c) return null;
  const k = String(kode).trim();
  const varianter = [k];
  if (/^\d{12}$/.test(k)) varianter.push('0' + k);
  if (/^0\d{12}$/.test(k)) varianter.push(k.slice(1));
  for (const x of varianter) {
    if (c.eanKart[x]) return c.eanKart[x];
    if (c.varer[x]) return x;
  }
  return null;
}
function handterKode(raw, manuell) {
  const kode = String(raw).trim();
  if (!kode) return;
  const sk = S.skann, now = Date.now();
  const same = kode === sk.sist.kode && now - sk.sist.t < 1400;
  if (!manuell && same) return;
  sk.sist = { kode, t: now };
  const boks = $('#kamera-boks'); if (boks && !manuell) { boks.classList.remove('blink'); void boks.offsetWidth; boks.classList.add('blink'); }

  // legg til strekkode på ei bestemt vare
  if (sk.leggTilEanFor) {
    const v = sk.leggTilEanFor; sk.leggTilEanFor = null;
    koplaEan(kode, v); pip(); toast(`Strekkode ${kode} er lagt til ${S.calc.varer[v]?.n || v}.`);
    visVareIResultat(v, kode);
    return;
  }
  let v = finnVareForKode(kode);
  if (!v && manuell && !/^\d{6,}$/.test(kode)) {
    // namnesøk
    const treff = sokVarer(kode).sort((a, b) => b.q365 - a.q365).slice(0, 8);
    if (treff.length === 1) v = treff[0].v;
    else { sk.ukjend = null; visNamnetreff(kode, treff); return; }
  }
  if (!v) { pip(false); visUkjend(kode); return; }
  pip();
  // same vare skanna igjen med «kvar eining»: +1
  if (sk.vare === v && sk.kvar && S.skann.modus !== 'sjekk') {
    sk.tal = String((Number(sk.tal) || 0) + 1);
    renderResultat();
    return;
  }
  autoLagreVentande();
  visVareIResultat(v, kode);
  if (S.skann.modus === 'sjekk') opneVare(v);
  const m = $('#manuell'); if (m && manuell) m.value = '';
}
function autoLagreVentande() {
  const sk = S.skann;
  if (sk.vare && sk.tal !== '' && !sk.lagra && sk.modus !== 'sjekk') lagreTal(true);
}
function visVareIResultat(v, kode) {
  const sk = S.skann;
  sk.vare = v; sk.kode = kode || null; sk.ukjend = null; sk.lagra = false;
  sk.tal = sk.kvar && sk.modus !== 'sjekk' ? '1' : '';
  const x = S.calc.varer[v];
  const nyleg = sk.modus === 'telling' && x?.tl && Date.now() - new Date(x.tl.t).getTime() < 12 * 3600000;
  sk.leggTil = !!nyleg;
  renderResultat();
}
function startSkannFor(v, modus) {
  S.skann.modus = modus; location.hash = '#skann';
  setTimeout(() => visVareIResultat(v), 0);
}
function renderResultat() {
  const el = $('#resultat'); if (!el) return;
  const sk = S.skann;
  const side = $('.skann-side');
  const har = !!(sk.ukjend || (sk.vare && S.calc?.varer[sk.vare]));
  side?.classList.toggle('har-resultat', har);
  if (har) requestAnimationFrame(() => { const r = el.firstElementChild; if (r) r.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); });
  if (sk.ukjend) { el.innerHTML = sk.ukjend.html; return; }
  if (!sk.vare) { el.innerHTML = ''; return; }
  const x = S.calc.varer[sk.vare]; if (!x) { el.innerHTML = ''; return; }
  const nyleg = x.tl && Date.now() - new Date(x.tl.t).getTime() < 12 * 3600000;
  let panel = '';
  if (sk.modus === 'telling' || sk.modus === 'mottak') {
    const sporsmal = sk.modus === 'telling' ? (nyleg && sk.leggTil ? `Kor mange fann du her? (vert lagt til ${fmtLager(x.tl.a)})` : 'Kor mange står på hylla?') : 'Kor mange kom inn?';
    panel = `
      ${sk.modus === 'telling' && nyleg ? `<div class="val" role="group" aria-label="Teljemåte">
        <button class="knapp liten ${sk.leggTil ? 'primar' : ''}" data-a="legg-til-modus" data-m="legg">Legg til (anna hylle)</button>
        <button class="knapp liten ${!sk.leggTil ? 'primar' : ''}" data-a="legg-til-modus" data-m="erstatt">Erstatt</button></div>` : ''}
      <div class="tastatur-skjerm"><span>${sporsmal}</span><b aria-live="polite">${sk.tal === '' ? '·' : esc(sk.tal)}</b></div>
      <div class="tastatur">
        ${['1', '2', '3', 'minus', '4', '5', '6', 'pluss', '7', '8', '9', '', 'slett', '0', 'komma'].map(k => {
          if (k === '') return '';
          if (k === 'minus') return '<button class="fn" data-a="tast" data-k="minus" aria-label="Minus éin">−1</button>';
          if (k === 'pluss') return '<button class="fn" data-a="tast" data-k="pluss" aria-label="Pluss éin">+1</button>';
          if (k === 'slett') return '<button class="fn" data-a="tast" data-k="slett" aria-label="Slett siste siffer">⌫</button>';
          if (k === 'komma') return '<button class="fn" data-a="tast" data-k="komma" aria-label="Desimalkomma">,</button>';
          return `<button data-a="tast" data-k="${k}">${k}</button>`;
        }).join('')}
        <button class="ok" data-a="lagre-tal">Lagre</button>
      </div>
      <label class="brytar"><input type="checkbox" data-a="kvar-eining" ${sk.kvar ? 'checked' : ''}> Skann kvar eining (+1 per skann)</label>`;
  }
  el.innerHTML = `<section class="kort resultat">
    <button class="lukk-res" data-a="lukk-res" aria-label="Lukk">${IKON.lukk}</button>
    <div class="hovud">
      <div><h3>${esc(x.n)}</h3><div class="sub">${esc(x.v)}${sk.kode && sk.kode !== x.v ? ' · ' + esc(sk.kode) : ''} · ${esc(katNamn(x.k))}${x.p ? ' · ' + fmtKr(x.p) : ''}</div></div>
      <div class="storttal ${x.lager == null ? 'null' : ''}">${x.lager == null ? 'Ikkje talt' : fmtLager(x.lager)}<small>${x.lager == null ? '' : 'på lager'}</small></div>
    </div>
    ${!x.med ? '<div class="melding" style="margin:12px 0 0">Denne vara er utelaten frå lageret. Opne vara for å ta henne med.</div>' : ''}
    ${panel}
    ${sk.modus === 'sjekk' ? `<div class="val"><button class="knapp" data-a="vare" data-v="${esc(x.v)}">Opne vara</button></div>` : ''}
  </section>`;
}
function tast(k) {
  const sk = S.skann;
  let t = sk.tal;
  if (k === 'slett') t = t.slice(0, -1);
  else if (k === 'pluss') t = String(Math.round(((Number(t.replace(',', '.')) || 0) + 1) * 100) / 100).replace('.', ',');
  else if (k === 'minus') t = String(Math.max(0, Math.round(((Number(t.replace(',', '.')) || 0) - 1) * 100) / 100)).replace('.', ',');
  else if (k === 'komma') { if (!t.includes(',')) t = (t || '0') + ','; }
  else if (t.length < 7) t = (t === '0' ? '' : t) + k;
  sk.tal = t; sk.lagra = false;
  const b = $('.tastatur-skjerm b'); if (b) b.textContent = t === '' ? '·' : t;
}
function lagreTal(auto) {
  const sk = S.skann;
  const v = sk.vare; if (!v) return;
  if (sk.tal === '') { toast('Skriv inn eit tal først.', { feil: true }); return; }
  const n = Number(sk.tal.replace(',', '.'));
  if (!isFinite(n) || n < 0) { toast('Ugyldig tal.', { feil: true }); return; }
  const x = S.calc.varer[v];
  if (sk.modus === 'telling') {
    const nyleg = x.tl && Date.now() - new Date(x.tl.t).getTime() < 12 * 3600000;
    const total = nyleg && sk.leggTil ? x.tl.a + n : n;
    const e = nyTeljing(v, total);
    toast(`${auto ? 'Lagra automatisk: ' : ''}${x.n} = ${fmtLager(total)} stk`, { angre: ['teljingar', e.id] });
  } else if (sk.modus === 'mottak') {
    const e = nyttMottak(v, n);
    toast(`${auto ? 'Lagra automatisk: ' : ''}+${fmtLager(n)} ${x.n}`, { angre: ['mottak', e.id] });
  }
  sk.lagra = true;
  if (!auto) { sk.vare = null; sk.tal = ''; }
  renderResultat();
  const m = $('#manuell'); if (m && !kamera.aktiv) m.focus();
}
async function visUkjend(kode) {
  const sk = S.skann;
  sk.vare = null;
  const teikn = (namn, treff) => {
    sk.ukjend = {
      kode, html: `<section class="kort resultat">
      <button class="lukk-res" data-a="lukk-res" aria-label="Lukk">${IKON.lukk}</button>
      <h3 style="padding-right:40px">Ukjend strekkode</h3>
      <div class="sub">${esc(kode)}${namn ? ' · Open Food Facts: ' + esc(namn) : ''}</div>
      <p style="margin:12px 0 4px">Kva vare i kassa er dette? Vel frå lista eller søk. Koplinga vert hugsa.</p>
      <div class="sok">${IKON.sok}<input class="felt" id="ukjend-sok" placeholder="Søk på namn eller varenummer" value="${esc(namn || '')}"></div>
      <ul class="forslag" id="ukjend-liste">${forslagHTML(treff, 'kople-ean')}</ul>
      <div class="val"><button class="knapp liten stille" data-a="ny-vare">Vara finst ikkje i kassa – lag ny</button></div>
    </section>` };
    renderResultat();
    const inp = $('#ukjend-sok');
    inp?.addEventListener('input', () => {
      const q = inp.value.trim();
      const t = /^\d+$/.test(q) ? sokVarer(q).slice(0, 8).map(x => [1, x]) : foreslaa(q, 10);
      $('#ukjend-liste').innerHTML = forslagHTML(t, 'kople-ean');
    });
  };
  teikn('', []);
  const namn = await offNamn(kode);
  if (sk.ukjend?.kode !== kode) return;
  teikn(namn, namn ? foreslaa(namn, 10) : []);
  if (!namn) $('#ukjend-sok')?.focus();
}
function visNamnetreff(q, treff) {
  S.skann.vare = null;
  S.skann.ukjend = {
    kode: q, html: `<section class="kort resultat"><button class="lukk-res" data-a="lukk-res" aria-label="Lukk">${IKON.lukk}</button><h3 style="padding-right:40px">Vel vare</h3><div class="sub">Søk: ${esc(q)}</div>
    <ul class="forslag">${forslagHTML(treff.map(x => [1, x]), 'vel-namn')}</ul></section>` };
  renderResultat();
  document.querySelectorAll('[data-a="vel-namn"]').forEach(b => b.addEventListener('click', () => { const v = b.dataset.v; S.skann.ukjend = null; visVareIResultat(v); if (S.skann.modus === 'sjekk') opneVare(v); }));
}
function forslagHTML(treff, handling, ekstra = '') {
  if (!treff.length) return '<li class="tom">Ingen forslag – prøv å søkje.</li>';
  return treff.map(([sc, x]) => `<li><button data-a="${handling}" data-v="${esc(x.v)}" ${ekstra}>
    <span class="namn">${esc(x.n)}</span><span class="meta">${esc(x.v)} · ${esc(katNamn(x.k))}${x.q365 ? ' · selt ' + fmtLager(x.q365) + ' siste år' : ''}</span>
    ${x.eans.length ? `<span class="treff">${x.eans.length} kode${x.eans.length > 1 ? 'r' : ''}</span>` : ''}</button></li>`).join('');
}
async function offNamn(kode) {
  if (!/^\d{8,14}$/.test(kode)) return '';
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${kode}.json?fields=product_name,brands,quantity`, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return '';
    const j = await r.json();
    const p = j.product || {};
    return [p.brands?.split(',')[0], p.product_name, p.quantity].filter(Boolean).join(' ').trim();
  } catch { return ''; }
}
function nyVareSkjema() {
  const kode = S.skann.ukjend?.kode || '';
  visArk(`<h2>Ny vare</h2><div class="sub">For varer som står på hylla, men ikkje finst i kassa. Sal vert ikkje trekt frå automatisk.</div>
    <label class="etikett" for="ny-namn">Namn</label><input class="felt" id="ny-namn" value="${esc($('#ukjend-sok')?.value || '')}">
    <label class="etikett" for="ny-pris">Utsalspris (kr, valfritt)</label><input class="felt" id="ny-pris" type="number" inputmode="decimal">
    <div class="val"><button class="knapp primar" data-a="lagre-ny-vare" data-k="${esc(kode)}">Lagre vare</button></div>`, { fokus: '#ny-namn' });
}
function lagreNyVare() {
  const namn = $('#ny-namn').value.trim(); if (!namn) { toast('Skriv inn eit namn.', { feil: true }); return; }
  const pris = Number($('#ny-pris').value) || undefined;
  const id = 'N' + Date.now().toString(36).toUpperCase();
  S.app.nye[id] = { n: namn, p: pris, k: gjettKategori(namn), t: naa() };
  const kode = $('[data-a="lagre-ny-vare"]').dataset.k;
  if (kode) S.app.ean[kode] = { v: id, t: naa() };
  endra(); lukkArk(); S.skann.ukjend = null; visVareIResultat(id, kode);
  toast('Vara er lagra.');
}

/* ---------- Mottak ---------- */
function finnLinje(oid, i) { const o = (S.best.ordrar || []).find(x => x.id === oid); return { o, l: o?.linjer?.[i] }; }
function visMottak() {
  const ordrar = [...(S.best.ordrar || [])].sort((a, b) => (b.levering || b.dato || '') < (a.levering || a.dato || '') ? -1 : 1);
  const now = Date.now();
  const n = S.calc?.utanKopling || 0;
  return `${feilBoks()}
  <h1 class="side-tittel">Varemottak</h1>
  <p class="ingress">Ordrebekreftingar frå e-posten vert henta kvar dag. Varene vert lagde til lageret på leveringsdagen. Første gong ei vare dukkar opp må du kople henne til rett vare i kassa – etter det går det av seg sjølv.</p>
  <div class="val" style="margin-bottom:16px"><button class="knapp" data-a="manuelt-mottak">${IKON.kamera} Skann inn mottak manuelt</button></div>
  ${n ? `<div class="melding"><b>${n} varelinjer treng kopling.</b> Trykk «Kople» for å seie kva vare i kassa dei høyrer til, eller «Ikkje lagervare» for emballasje, råvarer til kjøkkenet o.l.</div>` : ''}
  ${ordrar.length ? ordrar.map(o => {
    const st = S.app.ordre?.[o.id]?.status;
    const lev = new Date((o.levering || o.dato) + 'T09:00:00').getTime();
    const stTekst = st === 'ikkjelevert' ? ['ikkjetalt', 'Ikkje levert'] : lev <= now ? ['ok', 'På lager'] : ['lagt', 'Kjem ' + fmtDato(o.levering || o.dato)];
    const linjer = o.linjer || [];
    const sortert = linjer.map((l, i) => ({ l, i, k: linjeKopling(o, l) })).sort((a, b) => (!!a.k - !!b.k));
    return `<section class="kort ordre">
      <div class="ordre-hovud"><h3>${esc(o.leverandor)}${o.ordrenr ? ' · ' + esc(o.ordrenr) : ''}</h3>
        <span class="sub">Bestilt ${fmtDato(o.dato)}${o.levering ? ' · levering ' + fmtDato(o.levering) : ''} · ${linjer.length} linjer${o.merknad ? ' · ' + esc(o.merknad) : ''}</span>
        <span class="status ${stTekst[0]}">${stTekst[1]}</span></div>
      ${linjer.length ? sortert.map(({ l, i, k }) => {
        const x = k && !k.ign ? S.calc.varer[k.v] : null;
        const stk = linjeStk(l, k);
        return `<div class="linje">
          <span class="lev">${esc(l.namn)}${l.art ? ' · ' + esc(l.art) : ''}</span>
          <span class="kopla ${!k ? (l.ign ? 'ign' : 'manglar') : k.ign ? 'ign' : ''}">${!k ? (l.ign ? 'Ikkje lagervare (forslag)' : 'Ikkje kopla') : k.ign ? 'Ikkje lagervare' : esc(x?.n || k.v)}</span>
          <span class="stk">${fmtLager(stk)}<small>${l.kolli ? `${fmtLager(l.kolli)} × ${fmtLager(k?.f ?? l.faktor ?? 1)}${l.anbr ? ' + ' + fmtLager(l.anbr) : ''}` : 'stk'}</small></span>
          ${!k && l.forslag && S.calc.varer[l.forslag] ? `<span class="handl forslag-boks">Forslag: <b>${esc(S.calc.varer[l.forslag].n)}</b><button class="knapp liten primar" data-a="stadfest-forslag" data-o="${esc(o.id)}" data-i="${i}">Stadfest</button><button class="knapp liten" data-a="kople-linje" data-o="${esc(o.id)}" data-i="${i}">Vel anna</button></span>`
            : !k && !l.ign ? `<span class="handl"><button class="knapp liten primar" data-a="kople-linje" data-o="${esc(o.id)}" data-i="${i}">Kople</button><button class="knapp liten" data-a="ign-linje" data-o="${esc(o.id)}" data-i="${i}">Ikkje lagervare</button></span>`
            : `<span class="handl"><button class="lenke" style="font-size:13px" data-a="kople-linje" data-o="${esc(o.id)}" data-i="${i}">Endre</button></span>`}
        </div>`;
      }).join('') : `<div class="linje"><span class="lev">${o.varedetaljerManglar ? 'E-posten hadde ingen varelinjer (berre kolli/pall). Skann inn varene manuelt.' : 'Ingen varelinjer.'}</span></div>`}
      <div class="ordre-fot">${st === 'ikkjelevert' ? `<button class="knapp liten" data-a="ordre-status" data-o="${esc(o.id)}" data-s="levert">Angre – ordren er levert</button>` : `<button class="knapp liten stille" data-a="ordre-status" data-o="${esc(o.id)}" data-s="ikkjelevert">Ikkje levert</button>`}</div>
    </section>`;
  }).join('') : '<div class="kort tom">Ingen ordrar er henta frå e-posten enno. Den daglege oppdateringa legg dei inn her.</div>'}`;
}
function opneKopling(oid, i) {
  const { o, l } = finnLinje(oid, i); if (!l) return;
  const k = linjeKopling(o, l);
  S.kopler = { oid, i };
  const treff = foreslaa(l.namn, 10);
  visArk(`<h2>Kople varelinje</h2>
    <div class="sub">${esc(o.leverandor)} · ${esc(l.namn)}${l.art ? ' · art.nr ' + esc(l.art) : ''}${l.storr ? ' · ' + esc(l.storr) : ''}</div>
    <label class="etikett" for="kople-faktor">Sals-einingar per innkjøpseining (${esc(l.eining || 'kolli')})</label>
    <input class="felt" id="kople-faktor" type="number" inputmode="decimal" min="0" value="${k?.f ?? l.faktor ?? 1}">
    <label class="etikett" for="kople-sok">Kva vare i kassa er dette?</label>
    <div class="sok">${IKON.sok}<input class="felt" id="kople-sok" placeholder="Søk på namn eller varenummer"></div>
    <ul class="forslag" id="kople-liste">${forslagHTML(treff, 'vel-kopling')}</ul>
    <div class="val"><button class="knapp liten stille" data-a="ign-linje" data-o="${esc(oid)}" data-i="${i}">Ikkje lagervare</button></div>`);
  const inp = $('#kople-sok');
  inp.addEventListener('input', () => {
    const q = inp.value.trim();
    const t = !q ? treff : /^\d+$/.test(q) ? sokVarer(q).slice(0, 10).map(x => [1, x]) : foreslaa(q, 10);
    $('#kople-liste').innerHTML = forslagHTML(t, 'vel-kopling');
  });
}
function lagreKopling(v) {
  const { oid, i } = S.kopler || {};
  const { o, l } = finnLinje(oid, i); if (!l) return;
  const f = Number($('#kople-faktor').value);
  S.app.kopling[linjeNokkel(o, l)] = { v, f: isFinite(f) && f > 0 ? f : 1, t: naa() };
  endra(); lukkArk(); render();
  toast(`Kopla til ${S.calc.varer[v]?.n || v}. Same vare vert kopla automatisk neste gong.`);
}

/* ---------- Meir ---------- */
function visMeir() {
  const c = S.calc, s = c?.sums;
  const sp = c?.sistePeriode;
  return `${feilBoks()}
  <h1 class="side-tittel">Meir</h1>
  ${tokenKort()}
  <section class="kort meir-kort">
    <h2>Utsjånad</h2>
    <p>Vel lyst eller mørkt tema. «Auto» følgjer innstillinga på telefonen. Du kan òg byte med knappen oppe til høgre.</p>
    <div class="modus" role="group" aria-label="Tema" style="margin-top:10px">
      ${[['auto', 'Auto'], ['lys', 'Lys'], ['mork', 'Mørk']].map(([k, t]) => `<button data-a="tema-val" data-t="${k}" aria-pressed="${temaVal() === k}">${t}</button>`).join('')}
    </div>
  </section>
  <section class="kort meir-kort">
    <h2>Namnet ditt</h2>
    <p>Vert lagra saman med teljingar og mottak, så de ser kven som har gjort kva.</p>
    <div class="manuell"><input class="felt" id="namn" value="${esc(brukar())}" placeholder="T.d. Kristoffer"><button class="knapp" data-a="lagre-namn">Lagre</button></div>
  </section>
  ${c ? `<section class="kort meir-kort">
    <h2>Dagleg oppdatering</h2>
    <p>Kvar morgon hentar Claude salet frå kassa (min.pckasse.no) og nye ordrebekreftingar frå e-posten, og legg dei inn her.</p>
    <table class="tabell">
      <tr><td>Sal henta t.o.m.</td><td>${sp ? fmtDato(sp.t) + ' kl. 10' : '–'}</td></tr>
      <tr><td>Sist oppdatert (sal)</td><td>${S.meta.salOppdatert ? fmtDato(S.meta.salOppdatert, true) : '–'}</td></tr>
      <tr><td>Ordrar frå e-post</td><td>${fmtTal((S.best.ordrar || []).length)}</td></tr>
      <tr><td>Varer i lageret</td><td>${fmtTal(s.med)}</td></tr>
      <tr><td>Talde varer</td><td>${fmtTal(s.talde)}</td></tr>
      <tr><td>Strekkodar kopla</td><td>${fmtTal(Object.values(S.app.ean || {}).filter(e => e.v && !e.slett).length)}</td></tr>
    </table>
  </section>
  <section class="kort meir-kort" id="vareregister">
    <h2>Vareregister med strekkodar frå PCKasse</h2>
    <p>Hent inn alle varene i kassa med strekkode, så kjenner appen att varene første gong du skannar dei. Gjer dette på kasse-PC-en:</p>
    <ol class="steg">
      <li>PCKasse → <b>Varer</b> → <b>Vareliste</b>.</li>
      <li>Høgreklikk i lista → <b>Velg kolonner</b>. Legg til <b>Varenummer, Varenavn, Strekkode/EAN, Utsalgspris</b> (gjerne òg <b>Innkjøpspris</b> og <b>Varegruppe</b>) → OK.</li>
      <li>Høgreklikk igjen → <b>Skriv til fil</b> → vel semikolon som skiljeteikn og lagre fila.</li>
      <li>Vel fila her, eller send henne til Claude.</li>
    </ol>
    <label class="etikett" for="vr-fil">Fil frå PCKasse (.txt, .csv eller .xlsx)</label>
    <input class="felt" id="vr-fil" type="file" accept=".txt,.csv,.tsv,.xlsx,.xls,text/plain,text/csv">
    <div id="vr-forhand"></div>
    ${S.meta.registerImportert ? `<p style="font-size:14px">Sist importert: ${fmtDato(S.meta.registerImportert, true)}.</p>` : ''}
  </section>
  <section class="kort meir-kort">
    <h2>Avslutt oppstartsteljinga</h2>
    <p>Når du har skanna alt du finn i butikken og på lageret, kan du setje dei ${fmtTal(s.ikkjetalt)} varene som framleis ikkje er talde til 0. Dei dukkar då opp som «Tomt» om dei vert selde eller bestilte igjen.</p>
    <div class="val"><button class="knapp" data-a="nullstill-rest" ${s.ikkjetalt ? '' : 'disabled'}>Set ${fmtTal(s.ikkjetalt)} ikkje-talde varer til 0</button></div>
  </section>
  <section class="kort meir-kort">
    <h2>Eksport</h2>
    <p>Last ned lagerlista som CSV (opnar i Excel), t.d. til varetelling ved årsskiftet.</p>
    <div class="val"><button class="knapp" data-a="eksport">Last ned lagerliste</button></div>
    <label class="brytar"><input type="checkbox" data-a="vis-utelatne" ${S.lager.utelatne ? 'checked' : ''}> Vis utelatne varer (servering, tenester, lausvekt) i lagerlista</label>
  </section>
  <section class="kort meir-kort">
    <h2>Slik reknar appen</h2>
    <p>Lager = siste teljing + mottak etter teljinga − sal i kassa etter teljinga. Kassa deler salet i periodar frå kl. 10 til kl. 10. Ei teljing før kl. 15.30 vert rekna som gjort ved opning (dagens sal vert trekt frå), ei teljing etter 15.30 som gjort ved stenging. Tel helst før opning eller etter stenging for heilt nøyaktige tal.</p>
    <p style="font-size:13px;color:var(--blekk-3)">Versjon ${CFG.versjon}. Data: ${esc(CFG.repo)}.</p>
  </section>` : ''}`;
}
function nullstillRest() {
  const c = S.calc; if (!c) return;
  const rest = Object.values(c.varer).filter(x => x.med && x.status === 'ikkjetalt');
  if (!rest.length) return;
  if (!confirm(`Set ${rest.length} varer som ikkje er talde til 0?`)) return;
  const t = naa();
  for (const x of rest) S.app.teljingar.push({ id: nyId(), v: x.v, a: 0, t, av: (brukar() ? brukar() + ', ' : '') + 'oppstart' });
  endra(); render(); toast(`${rest.length} varer er sette til 0.`);
}
function eksporterCSV() {
  const c = S.calc; if (!c) return;
  const rad = [['Varenummer', 'Namn', 'Kategori', 'Lager', 'Status', 'Utsalspris', 'Verdi utsal', 'Minimum', 'Selt 30 d', 'Selt 365 d', 'Sist talt', 'Strekkodar']];
  for (const x of Object.values(c.varer).filter(x => x.med).sort((a, b) => a.n.localeCompare(b.n, 'nb'))) {
    rad.push([x.v, x.n, katNamn(x.k), x.lager == null ? '' : fmtLager(x.lager), STATUS_TEKST[x.status], x.p ? String(x.p).replace('.', ',') : '', x.lager > 0 && x.p ? String(Math.round(x.lager * x.p * 100) / 100).replace('.', ',') : '', x.min, fmtLager(x.q30), fmtLager(x.q365), x.tl ? x.tl.t.slice(0, 10) : '', x.eans.join(' ')]);
  }
  const csv = '﻿' + rad.map(r => r.map(v => /[;"\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `krambua-lager-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
}

/* ---------- Import av vareregister frå PCKasse ---------- */
function dekodTekst(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf);
  if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\ufeff/, ''); }
  catch { return new TextDecoder('windows-1252').decode(buf); }
}
function delTekst(t) {
  const linjer = t.split(/\r?\n/).filter(l => l.trim());
  if (!linjer.length) return [];
  const f = linjer[0];
  const sk = [['\t', (f.match(/\t/g) || []).length], [';', (f.match(/;/g) || []).length], [',', (f.match(/,/g) || []).length]].sort((a, b) => b[1] - a[1])[0][0];
  return linjer.map(l => {
    const ut = []; let cur = '', q = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (c === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === sk && !q) { ut.push(cur); cur = ''; }
      else cur += c;
    }
    ut.push(cur);
    return ut.map(x => x.trim());
  });
}
async function lesRegisterFil(fil) {
  const buf = await fil.arrayBuffer();
  if (/\.xlsx?$/i.test(fil.name)) {
    await lastSkript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
    const wb = window.XLSX.read(buf, { type: 'array' });
    return window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' }).map(r => r.map(x => String(x).trim()));
  }
  return delTekst(dekodTekst(buf));
}
function finnKolonner(rader) {
  const reg = {
    v: /^(vare ?nr\.?|varenummer|artikkel ?nr\.?|artikkelnummer|art\.? ?nr\.?|nummer|nr\.?)$/i,
    n: /^(vare ?navn|varenamn|navn|namn|beskrivelse|varetekst|tekst)$/i,
    ean: /ean|strekkode|barcode|gtin/i,
    p: /utsalg|salgspris|pris ink|pris$/i,
    kp: /innkj|kjøpspris|kostpris|inntakspris/i,
    g: /^varegruppe ?1?$|^varegruppe$/i,
    st: /varestatus|^status$/i,
  };
  for (let r = 0; r < Math.min(rader.length, 8); r++) {
    const h = rader[r].map(x => x.replace(/[«»"]/g, '').trim());
    const k = {};
    h.forEach((c, i) => {
      for (const [nam, rx] of Object.entries(reg)) {
        if (k[nam] != null) continue;
        if (nam === 'p' && /innkj|kjøp|kost|eks/i.test(c)) continue;
        if (nam === 'n' && /leverand|produsent|kunde/i.test(c)) continue;
        if (rx.test(c)) { k[nam] = i; break; }
      }
    });
    if (k.v != null && (k.n != null || k.ean != null)) return { rad: r, k, hovud: h };
  }
  return null;
}
const talFraTekst = x => { const t = String(x || '').replace(/\s|kr/gi, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'); const n = parseFloat(t); return isFinite(n) ? n : null; };
let registerUtkast = null;
async function forhandsvisRegister(fil) {
  const boks = $('#vr-forhand'); if (!boks) return;
  boks.innerHTML = '<p>Les fila …</p>';
  try {
    const rader = await lesRegisterFil(fil);
    const m = finnKolonner(rader);
    if (!m) { boks.innerHTML = '<div class="melding raud" style="margin-top:12px">Fann ikkje kolonnene for varenummer og varenamn/strekkode i fila. Sjekk at overskriftsrada er med (høgreklikk → Skriv til fil).</div>'; return; }
    const varer = [];
    for (const r of rader.slice(m.rad + 1)) {
      const v = String(r[m.k.v] || '').trim(); if (!v) continue;
      const eans = m.k.ean != null ? [...new Set(String(r[m.k.ean] || '').split(/[^0-9]+/).filter(x => x.length >= 8 && x.length <= 14))] : [];
      varer.push({ v, n: m.k.n != null ? String(r[m.k.n] || '').trim() : '', ean: eans, p: m.k.p != null ? talFraTekst(r[m.k.p]) : null, kp: m.k.kp != null ? talFraTekst(r[m.k.kp]) : null, g: m.k.g != null ? String(r[m.k.g] || '').trim() : '', st: m.k.st != null ? String(r[m.k.st] || '').trim() : '' });
    }
    const medEan = varer.filter(x => x.ean.length).length;
    const nye = varer.filter(x => !S.varer[x.v]).length;
    registerUtkast = varer;
    const namnK = (i) => i == null ? '–' : esc(m.hovud[i]);
    boks.innerHTML = `<table class="tabell">
      <tr><td>Varer i fila</td><td>${fmtTal(varer.length)}</td></tr>
      <tr><td>Med strekkode</td><td>${fmtTal(medEan)}</td></tr>
      <tr><td>Nye (ikkje selde siste 2 år)</td><td>${fmtTal(nye)}</td></tr>
    </table>
    <p style="font-size:13px">Kolonner: varenr = ${namnK(m.k.v)}, namn = ${namnK(m.k.n)}, strekkode = ${namnK(m.k.ean)}, pris = ${namnK(m.k.p)}, innkjøp = ${namnK(m.k.kp)}, gruppe = ${namnK(m.k.g)}</p>
    ${m.k.ean == null ? '<div class="melding">Fila manglar strekkode-kolonne. Legg til «Strekkode»/«EAN» under «Velg kolonner» og lag fila på nytt.</div>' : ''}
    <div class="val"><button class="knapp primar" data-a="importer-register" ${varer.length ? '' : 'disabled'}>Importer ${fmtTal(varer.length)} varer</button></div>`;
  } catch (e) {
    boks.innerHTML = `<div class="melding raud" style="margin-top:12px">Kunne ikkje lese fila: ${esc(e.message)}</div>`;
  }
}
async function importerRegister(rader) {
  if (!getToken()) throw new Error('Manglar token på denne eininga.');
  for (let forsok = 0; forsok < 3; forsok++) {
    const sha = await lesShaar();
    const vf = (await lesRaw('varer.json')) || { varer: {} };
    let nye = 0, oppdatert = 0, eanTal = 0;
    for (const r of rader) {
      let rec = vf.varer[r.v];
      if (!rec) {
        const n = r.n || r.v;
        rec = { n };
        const g = utelatGrunn(r.v, n) || (nyServering(n) ? 'servering' : null);
        if (g) rec.x = g; else rec.k = gjettKategori(n);
        vf.varer[r.v] = rec; nye++;
      } else oppdatert++;
      if (r.n) rec.n = r.n;
      if (r.p != null && r.p > 0) rec.p = Math.round(r.p * 100) / 100;
      if (r.kp != null && r.kp > 0) rec.kp = Math.round(r.kp * 100) / 100;
      if (r.g) rec.g = r.g;
      if (r.st) rec.st = r.st;
      if (r.ean.length) { rec.ean = [...new Set([...(rec.ean || []), ...r.ean])]; eanTal += r.ean.length; }
      rec.r = 1;
    }
    vf.oppdatert = naa(); vf.registerImportert = naa();
    try {
      await skrivFil('varer.json', vf, sha['varer.json'], `Vareregister frå PCKasse: ${rader.length} varer, ${nye} nye`);
      S.varer = vf.varer; IDF = null; S.meta.registerImportert = vf.registerImportert;
      ls.set(CFG.cacheKey, JSON.stringify({ varer: S.varer, sal: S.sal, best: S.best, meta: S.meta }));
      S.calc = rekn();
      return { nye, oppdatert, eanTal };
    } catch (e) { if (!e.konflikt || forsok === 2) throw e; }
  }
}
document.addEventListener('change', ev => {
  if (ev.target?.id === 'vr-fil' && ev.target.files?.[0]) forhandsvisRegister(ev.target.files[0]);
});

/* ---------- Toast ---------- */
function toast(tekst, opt = {}) {
  const boks = $('#toastar');
  const el = document.createElement('div');
  el.className = 'toast' + (opt.feil ? ' feil' : '');
  el.innerHTML = `<span>${esc(tekst)}</span>${opt.angre ? `<button data-a="angre" data-type="${opt.angre[0]}" data-id="${opt.angre[1]}">Angre</button>` : ''}`;
  boks.appendChild(el);
  while (boks.children.length > 3) boks.firstChild.remove();
  setTimeout(() => el.remove(), opt.angre ? 6000 : opt.feil ? 6000 : 3200);
}

/* ---------- API for den daglege oppdateringa ---------- */
let klarRes; const klar = new Promise(r => { klarRes = r; });
window.KrambuaLager = {
  klar,
  async status() {
    await klar;
    const sp = S.calc?.sistePeriode;
    return { token: !!getToken(), feil: S.feil, sistePeriode: sp ? { f: sp.f, t: sp.t } : null, ordrar: (S.best.ordrar || []).map(o => o.id), varer: Object.keys(S.varer).length };
  },
  /** Forslag til kassevare for eit leverandørnamn: [{v, n, score}] */
  async foreslaa(namn, n = 3) {
    await klar;
    return foreslaa(namn, n).map(([sc, x]) => ({ v: x.v, n: x.n, score: Math.round(sc * 100) / 100 }));
  },
  /** periodar: [{f:'YYYY-MM-DD', t:'YYYY-MM-DD', v:{varenr: antal}}], namn: {varenr: {n, p}}, sjekk: {rader, sum} frå skrapinga */
  async importerSal(periodar, namn = {}, sjekk = null) {
    await klar;
    if (!getToken()) throw new Error('Manglar token på denne eininga.');
    if (sjekk) {
      let rader = 0, sum = 0;
      for (const p of periodar) for (const a of Object.values(p.v || {})) { rader++; sum += a; }
      if (rader !== sjekk.rader || Math.abs(sum - sjekk.sum) > 0.01) throw new Error(`Kontrollsum stemmer ikkje (fekk ${rader} rader / ${sum.toFixed(3)}, venta ${sjekk.rader} / ${sjekk.sum}). Ingenting er lagra.`);
    }
    for (let forsok = 0; forsok < 3; forsok++) {
      const sha = await lesShaar();
      const sal = (await lesRaw('sal.json')) || { periodar: [] };
      const vf = (await lesRaw('varer.json')) || { varer: {} };
      const m = new Map(sal.periodar.map(p => [p.f, p]));
      for (const p of periodar) {
        const v = {};
        for (const [k, a] of Object.entries(p.v || {})) {
          const rec = vf.varer[k];
          const g = rec?.x || utelatGrunn(k, namn[k]?.n || rec?.n || '');
          if (g === 'generisk' || g === 'teneste') continue;
          v[k] = Math.round(a * 1000) / 1000;
        }
        m.set(p.f, { f: p.f, t: p.t, v });
      }
      const grense = addDag(new Date().toISOString().slice(0, 10), -800);
      sal.periodar = [...m.values()].filter(p => p.f >= grense).sort((a, b) => a.f < b.f ? -1 : 1);
      sal.oppdatert = naa();
      const nye = [];
      for (const p of periodar) for (const k of Object.keys(p.v || {})) {
        const info = namn[k] || {};
        let rec = vf.varer[k];
        if (!rec) {
          const n = (info.n || k).trim();
          rec = { n, s: p.f, f: p.f };
          const g = utelatGrunn(k, n) || (nyServering(n) ? 'servering' : null);
          if (g) rec.x = g; else rec.k = gjettKategori(n);
          if (/^\d{8}$|^\d{12,14}$/.test(k)) rec.ean = [k];
          vf.varer[k] = rec; nye.push(k + ' ' + n);
        }
        if (info.n && info.n.trim() !== rec.n) rec.n = info.n.trim();
        if (info.p) rec.p = Math.round(info.p * 100) / 100;
        if (!rec.s || p.f > rec.s) rec.s = p.f;
      }
      vf.oppdatert = naa();
      try {
        await skrivFil('sal.json', sal, sha['sal.json'], `Sal frå kassa t.o.m. ${periodar.map(p => p.t).sort().pop()} (automatisk)`);
        await skrivFil('varer.json', vf, sha['varer.json'], `Varer oppdatert frå kassa${nye.length ? ' (' + nye.length + ' nye)' : ''} (automatisk)`);
        S.sal = sal.periodar; S.varer = vf.varer; IDF = null; S.meta.salOppdatert = sal.oppdatert;
        ls.set(CFG.cacheKey, JSON.stringify({ varer: S.varer, sal: S.sal, best: S.best, meta: S.meta }));
        S.calc = rekn(); render();
        return { ok: true, periodar: periodar.length, nyeVarer: nye, sistePeriode: sal.periodar[sal.periodar.length - 1] && { f: sal.periodar[sal.periodar.length - 1].f, t: sal.periodar[sal.periodar.length - 1].t } };
      } catch (e) { if (!e.konflikt || forsok === 2) throw e; }
    }
  },
  /** ordrar: [{id, leverandor, ordrenr, dato, levering, kjelde, linjer:[{art, namn, faktor, eining, storr, kolli, anbr, stk, pris}]}] */
  async importerBestillingar(ordrar) {
    await klar;
    if (!getToken()) throw new Error('Manglar token på denne eininga.');
    for (let forsok = 0; forsok < 3; forsok++) {
      const sha = await lesShaar();
      const b = (await lesRaw('bestillingar.json')) || { ordrar: [] };
      const m = new Map(b.ordrar.map(o => [o.id, o]));
      const nye = [];
      for (const o of ordrar) { if (!o.id) continue; if (!m.has(o.id)) nye.push(o.id); m.set(o.id, { ...m.get(o.id), ...o, henta: m.get(o.id)?.henta || naa() }); }
      b.ordrar = [...m.values()].sort((x, y) => (y.dato || '') < (x.dato || '') ? -1 : 1);
      b.oppdatert = naa();
      try {
        await skrivFil('bestillingar.json', b, sha['bestillingar.json'], `Bestillingar frå e-post: ${nye.length} nye (automatisk)`);
        S.best = b; S.meta.bestOppdatert = b.oppdatert;
        ls.set(CFG.cacheKey, JSON.stringify({ varer: S.varer, sal: S.sal, best: S.best, meta: S.meta }));
        S.calc = rekn(); render();
        const utan = [];
        for (const o of ordrar) (o.linjer || []).forEach(l => { if (!linjeKopling(o, l)) utan.push(o.leverandor + ': ' + l.namn); });
        return { ok: true, nye, utanKopling: utan };
      } catch (e) { if (!e.konflikt || forsok === 2) throw e; }
    }
  },
};

/* ---------- start ---------- */
S.skann.modus = ls.get(CFG.modusKey) || 'telling';
oppdaterTema();
rute();
last();
if (!getToken()) klarRes();
