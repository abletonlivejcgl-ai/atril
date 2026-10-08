'use strict';
/* Atril: repertorio, setlists y partituras (MusicXML) para el escenario.
   Todo se guarda en este dispositivo (IndexedDB). */

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const byText = (a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' });

/* ---------- Almacenamiento ---------- */
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('atril', 1);
  r.onupgradeneeded = () => {
    ['songs', 'setlists', 'scores'].forEach(n => r.result.createObjectStore(n, { keyPath: 'id' }));
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function run(store, mode, fn) {
  const db = await dbp;
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req ? req.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const dbAll = s => run(s, 'readonly', o => o.getAll());
const dbGet = (s, id) => run(s, 'readonly', o => o.get(id));
const dbPut = (s, v) => run(s, 'readwrite', o => o.put(v));
const dbDel = (s, id) => run(s, 'readwrite', o => o.delete(id));

/* ---------- Estado ---------- */
function loadConcert() {
  try { return localStorage.getItem('atril.concert') === '1'; } catch { return false; }
}
const state = { tab: 'songs', songs: [], setlists: [], q: '', screen: null, stage: null, concert: loadConcert() };
let viewer = null;      // partitura que se está mostrando: { osmd, song }
let scoreRun = 0;       // descarta dibujos antiguos si cambias de pantalla
let installPrompt = null;
let wakeLock = null;

async function refresh() {
  state.songs = (await dbAll('songs')).sort((a, b) => byText(a.title, b.title));
  state.setlists = (await dbAll('setlists')).sort((a, b) => byText(a.name, b.name));
  render();
}
const songById = id => state.songs.find(s => s.id === id);

/* ---------- Utilidades ---------- */
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}
function abToBin(ab) {
  const u = new Uint8Array(ab);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return s;
}
function binToAb(bin) {
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}
const scoreContent = sc => (sc.kind === 'mxl' ? abToBin(sc.data) : sc.data);
const metaLine = s => [s.artist, s.key && 'Tono ' + s.key, s.bpm && s.bpm + ' bpm'].filter(Boolean).join(' · ');

/* ---------- Sonido real (sin transposición) ----------
   En MusicXML cada parte transpositora lleva un bloque <transpose> con lo que hay
   que sumar a la nota escrita para obtener la nota que suena. Aquí lo aplicamos
   a notas y armaduras y quitamos el bloque, para dibujar la partitura en sonido real. */
const STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const STEP_SEMI = [0, 2, 4, 5, 7, 9, 11];
const FIFTHS_OF_STEP = [0, 2, 4, -1, 1, 3, 5];      // armadura mayor sobre cada nota natural
const DIATONIC_OF_SEMI = [0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6];
const concertCache = new Map();                      // id de canción -> MusicXML en sonido real

function transposePitch(step, alter, octave, tr) {
  const i = STEPS.indexOf(step);
  const d = octave * 7 + i + tr.diatonic + 7 * tr.octave;
  const s = octave * 12 + STEP_SEMI[i] + alter + tr.chromatic + 12 * tr.octave;
  const oct = Math.floor(d / 7);
  const ni = ((d % 7) + 7) % 7;
  return { step: STEPS[ni], alter: s - (oct * 12 + STEP_SEMI[ni]), octave: oct };
}

function transposeFifths(f, tr) {
  for (let i = 0; i < 7; i++) {
    const a = (f - FIFTHS_OF_STEP[i]) / 7;           // alteración de la tónica mayor
    if (!Number.isInteger(a)) continue;
    const p = transposePitch(STEPS[i], a, 4, tr);
    let nf = FIFTHS_OF_STEP[STEPS.indexOf(p.step)] + 7 * p.alter;
    while (nf > 7) nf -= 12;                         // evita armaduras con más de 7 alteraciones
    while (nf < -7) nf += 12;
    return nf;
  }
  return f;
}

const directChild = (el, name) => Array.from(el.children).find(c => c.localName === name) || null;
const isActive = tr => !!(tr.diatonic || tr.chromatic || tr.octave);

function readTranspose(t) {
  const num = name => { const c = directChild(t, name); return c ? parseInt(c.textContent, 10) || 0 : 0; };
  const tr = { diatonic: num('diatonic'), chromatic: num('chromatic'), octave: num('octave-change') };
  if (!directChild(t, 'diatonic') && tr.chromatic) {   // el diatónico es opcional en MusicXML
    const c = Math.abs(tr.chromatic);
    tr.diatonic = Math.sign(tr.chromatic) * (DIATONIC_OF_SEMI[c % 12] + 7 * Math.floor(c / 12));
  }
  return tr;
}

function detectTranspose(xml) {
  const re = /<transpose\b[^>]*>([\s\S]*?)<\/transpose>/g;
  let m;
  while ((m = re.exec(xml))) {
    const c = /<chromatic>\s*(-?\d+)/.exec(m[1]);
    const o = /<octave-change>\s*(-?\d+)/.exec(m[1]);
    if ((c && Number(c[1]) !== 0) || (o && Number(o[1]) !== 0)) return true;
  }
  return false;
}

function toConcertPitch(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('XML no válido');
  if (doc.documentElement.localName !== 'score-partwise') throw new Error('Solo se admite score-partwise');
  for (const part of Array.from(doc.documentElement.children)) {
    if (part.localName !== 'part') continue;
    let tr = { diatonic: 0, chromatic: 0, octave: 0 };
    for (const measure of Array.from(part.children)) {
      if (measure.localName !== 'measure') continue;
      for (const el of Array.from(measure.children)) {
        if (el.localName === 'attributes') {
          const ts = Array.from(el.children).filter(c => c.localName === 'transpose');
          if (ts.length) { tr = readTranspose(ts[0]); ts.forEach(t => el.removeChild(t)); }
          if (!isActive(tr)) continue;
          for (const key of Array.from(el.children).filter(c => c.localName === 'key')) {
            const f = directChild(key, 'fifths');
            if (f) f.textContent = String(transposeFifths(parseInt(f.textContent, 10) || 0, tr));
          }
        } else if (el.localName === 'note' && isActive(tr)) {
          const p = directChild(el, 'pitch');
          const stepEl = p && directChild(p, 'step');
          const octEl = p && directChild(p, 'octave');
          if (!stepEl || !octEl) continue;
          const altEl = directChild(p, 'alter');
          const r = transposePitch(stepEl.textContent.trim(), altEl ? parseFloat(altEl.textContent) || 0 : 0,
            parseInt(octEl.textContent, 10), tr);
          stepEl.textContent = r.step;
          octEl.textContent = String(r.octave);
          if (r.alter) {
            if (altEl) altEl.textContent = String(r.alter);
            else { const a = doc.createElement('alter'); a.textContent = String(r.alter); stepEl.after(a); }
          } else if (altEl) p.removeChild(altEl);
          const acc = directChild(el, 'accidental');   // el visor lo recalcula con la nueva armadura
          if (acc) el.removeChild(acc);
        }
      }
    }
  }
  const out = new XMLSerializer().serializeToString(doc);
  return out.startsWith('<?xml') ? out : '<?xml version="1.0" encoding="UTF-8"?>\n' + out;
}

/* Saca el MusicXML de un .mxl (un zip) con las herramientas del navegador. */
async function unzipMxl(ab) {
  const u8 = new Uint8Array(ab), dv = new DataView(ab);
  let e = u8.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('mxl no válido');
  const count = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  const entries = [];
  for (let k = 0; k < count && dv.getUint32(p, true) === 0x02014b50; k++) {
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    entries.push({
      method: dv.getUint16(p + 10, true), csize: dv.getUint32(p + 20, true), off: dv.getUint32(p + 42, true),
      name: new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen))
    });
    p += 46 + nlen + xlen + clen;
  }
  const read = async en => {
    const start = en.off + 30 + dv.getUint16(en.off + 26, true) + dv.getUint16(en.off + 28, true);
    const data = u8.subarray(start, start + en.csize);
    if (en.method === 0) return new TextDecoder().decode(data);
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  };
  let path = null;
  const container = entries.find(x => x.name === 'META-INF/container.xml');
  if (container) { const m = /full-path="([^"]+)"/.exec(await read(container)); if (m) path = m[1]; }
  const main = entries.find(x => x.name === path) ||
    entries.find(x => /\.(xml|musicxml)$/i.test(x.name) && !x.name.startsWith('META-INF/'));
  if (!main) throw new Error('El .mxl no contiene partitura');
  return read(main);
}

/* ---------- Partitura ---------- */
async function loadScoreInto(el, song) {
  const token = ++scoreRun;
  viewer = null;
  let sc;
  try { sc = await dbGet('scores', song.id); } catch { sc = null; }
  if (!sc) {
    el.innerHTML = '<p class="empty">Esta canción no tiene partitura.</p>';
    return null;
  }
  el.innerHTML = '';
  try {
    const osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(el, {
      autoResize: false, backend: 'svg', drawTitle: false, drawComposer: false,
      drawPartNames: true, drawPartAbbreviations: true, drawingParameters: 'compact'
    });
    let content = scoreContent(sc);
    // ¿Hay instrumentos transpositores? Se calcula una vez por canción y se recuerda.
    if (song.hasTranspose === undefined || (state.concert && song.hasTranspose)) {
      try {
        const xml = sc.kind === 'mxl' ? await unzipMxl(sc.data) : sc.data;
        if (song.hasTranspose === undefined) {
          song.hasTranspose = detectTranspose(xml);
          dbPut('songs', song);
        }
        if (state.concert && song.hasTranspose) {
          if (!concertCache.has(song.id)) {
            concertCache.set(song.id, toConcertPitch(xml));
            if (concertCache.size > 4) concertCache.delete(concertCache.keys().next().value);
          }
          content = concertCache.get(song.id);
        }
      } catch (err) {
        console.error(err);
        if (state.concert) toast('No se ha podido pasar esta partitura a sonido real');
      }
    }
    await osmd.load(content);
    if (token !== scoreRun) return null;
    const hidden = song.hiddenParts || [];
    osmd.Sheet.Instruments.forEach((ins, i) => {
      ins.Visible = !hidden.includes(i);
      // Si el archivo no trae abreviatura, se inventa una corta para los sistemas siguientes.
      if (!ins.PartAbbreviation && ins.Name) {
        const n = String(ins.Name).trim();
        ins.PartAbbreviation = n.length > 5 ? n.slice(0, 4).trim() + '.' : n;
        ins.PartAbbreviationPrintObject = true;
      }
    });
    osmd.zoom = song.zoom || 1;
    osmd.render();
    viewer = { osmd, song };
    return osmd;
  } catch (err) {
    console.error(err);
    el.innerHTML = '<p class="empty">No se ha podido dibujar esta partitura. Prueba a exportarla de nuevo desde Sibelius.</p>';
    return null;
  }
}

const concertButton = (label, compact) =>
  `<button class="toggle${compact ? ' compact' : ''}" data-act="concert" aria-pressed="${state.concert}"
    aria-label="Sonido real, sin transposición" title="Muestra cada parte como suena, sin transposición">
    <span class="sw" aria-hidden="true"></span>${label}</button>`;

function toolsHTML(osmd) {
  const ins = osmd.Sheet.Instruments;
  const concert = viewer && viewer.song.hasTranspose ? concertButton('Sonido real') : '';
  const parts = ins.length > 1
    ? `<div class="chips" role="group" aria-label="Partes visibles">${ins.map((p, i) =>
        `<button class="chip${p.Visible ? ' on' : ''}" data-act="part" data-i="${i}" aria-pressed="${p.Visible}">${esc(p.Name || 'Parte ' + (i + 1))}</button>`).join('')}</div>`
    : '';
  return concert + parts +
    '<button class="txt" data-act="zoom" data-d="-0.1" aria-label="Reducir partitura">A−</button>' +
    '<button class="txt" data-act="zoom" data-d="0.1" aria-label="Ampliar partitura">A+</button>';
}

function setZoom(d) {
  if (!viewer) return;
  const s = viewer.song;
  s.zoom = Math.min(2.5, Math.max(0.5, Math.round(((s.zoom || 1) + d) * 10) / 10));
  viewer.osmd.zoom = s.zoom;
  viewer.osmd.render();
  dbPut('songs', s);
}

function togglePart(i) {
  if (!viewer) return;
  const ins = viewer.osmd.Sheet.Instruments;
  const visible = ins.filter(p => p.Visible).length;
  if (ins[i].Visible && visible === 1) { toast('Tiene que quedar al menos una parte visible'); return; }
  ins[i].Visible = !ins[i].Visible;
  viewer.song.hiddenParts = ins.map((p, k) => (p.Visible ? -1 : k)).filter(k => k >= 0);
  viewer.osmd.render();
  dbPut('songs', viewer.song);
  document.querySelectorAll('.chip').forEach(c => {
    const on = ins[Number(c.dataset.i)].Visible;
    c.classList.toggle('on', on);
    c.setAttribute('aria-pressed', on);
  });
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (viewer) viewer.osmd.render(); }, 200);
});

/* ---------- Pantallas ---------- */
const navHTML = () => `<nav class="nav" aria-label="Secciones">
  <button data-act="tab" data-tab="songs" ${state.tab === 'songs' ? 'aria-current="page"' : ''}>Canciones</button>
  <button data-act="tab" data-tab="setlists" ${state.tab === 'setlists' ? 'aria-current="page"' : ''}>Setlists</button>
</nav>`;

function songRows() {
  const q = state.q.trim().toLowerCase();
  const list = state.songs.filter(s => !q || (s.title + ' ' + (s.artist || '')).toLowerCase().includes(q));
  if (!state.songs.length) {
    return '<li class="empty">Aún no tienes canciones. Toca «Nueva canción» y añade la partitura exportada desde Sibelius.</li>';
  }
  if (!list.length) return '<li class="empty">Ninguna canción coincide con la búsqueda.</li>';
  return list.map(s => `<li><button class="row" data-act="open-song" data-id="${s.id}">
      <span class="t">${esc(s.title)}</span>
      <span class="m">${esc(metaLine(s)) || '&nbsp;'}</span>
      ${s.hasScore ? '<span class="tag">partitura</span>' : ''}
    </button></li>`).join('');
}

function songsView() {
  return `<header class="top"><h1 class="grow">Atril</h1>
      <button class="icon" data-act="menu" aria-label="Más opciones">⋯</button></header>
    <div class="searchbar"><input id="q" type="search" placeholder="Buscar canción o artista" value="${esc(state.q)}" aria-label="Buscar"></div>
    <ul class="rows" id="songlist">${songRows()}</ul>
    <button class="fab" data-act="new-song">Nueva canción</button>` + navHTML();
}

function setlistsView() {
  const rows = state.setlists.length
    ? state.setlists.map(l => {
        const n = l.songIds.filter(id => songById(id)).length;
        return `<li><button class="row" data-act="open-setlist" data-id="${l.id}">
          <span class="t">${esc(l.name)}</span>
          <span class="m">${n} ${n === 1 ? 'canción' : 'canciones'}</span></button></li>`;
      }).join('')
    : '<li class="empty">Aún no tienes setlists. Crea uno para ordenar las canciones de un concierto.</li>';
  return `<header class="top"><h1 class="grow">Setlists</h1>
      <button class="icon" data-act="menu" aria-label="Más opciones">⋯</button></header>
    <ul class="rows">${rows}</ul>
    <button class="fab" data-act="new-setlist">Nuevo setlist</button>` + navHTML();
}

async function songScreen(app, id) {
  const s = songById(id);
  if (!s) { state.screen = null; return render(); }
  app.innerHTML = `<header class="top">
      <button class="icon" data-act="back" aria-label="Volver">←</button>
      <h1 class="grow">${esc(s.title)}</h1>
      <button class="txt" data-act="edit-song" data-id="${s.id}">Editar</button></header>
    <div class="meta">${esc(metaLine(s))}</div>
    ${s.notes ? `<p class="notes">${esc(s.notes)}</p>` : ''}
    <div class="tools" id="tools"></div>
    <div id="score" class="paper"></div>`;
  if (!s.hasScore) {
    $('#score').innerHTML = '<p class="empty">Esta canción no tiene partitura. Toca «Editar» para importar un archivo MusicXML.</p>';
    return;
  }
  const osmd = await loadScoreInto($('#score'), s);
  if (!osmd) return;
  $('#tools').innerHTML = '<button class="solid" data-act="stage-song" data-id="' + s.id + '">Modo escenario</button>' + toolsHTML(osmd);
}

function setlistScreen(app, id) {
  const l = state.setlists.find(x => x.id === id);
  if (!l) { state.screen = null; return render(); }
  const songs = l.songIds.map(songById).filter(Boolean);
  const rows = songs.length
    ? songs.map((s, i) => `<li class="ord">
        <span class="n">${i + 1}</span>
        <button class="row" data-act="stage-from" data-i="${i}"><span class="t">${esc(s.title)}</span><span class="m">${esc(metaLine(s)) || '&nbsp;'}</span></button>
        <button class="icon" data-act="sl-up" data-i="${i}" aria-label="Subir" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="icon" data-act="sl-down" data-i="${i}" aria-label="Bajar" ${i === songs.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="icon" data-act="sl-remove" data-i="${i}" aria-label="Quitar del setlist">✕</button></li>`).join('')
    : '<li class="empty">Este setlist está vacío. Toca «Añadir canciones».</li>';
  app.innerHTML = `<header class="top">
      <button class="icon" data-act="back" aria-label="Volver">←</button>
      <h1 class="grow">${esc(l.name)}</h1>
      <button class="txt" data-act="rename-setlist">Renombrar</button></header>
    <div class="bar">
      <button class="solid" data-act="stage-setlist" ${songs.length ? '' : 'disabled'}>Modo escenario</button>
      <button class="txt" data-act="add-songs">Añadir canciones</button></div>
    <ul class="rows">${rows}</ul>
    <div class="bar"><button class="txt danger" data-act="delete-setlist">Eliminar setlist</button></div>`;
}

function render() {
  const app = $('#app');
  const sc = state.screen;
  if (sc && sc.type === 'song') return songScreen(app, sc.id);
  if (sc && sc.type === 'setlist') return setlistScreen(app, sc.id);
  viewer = null;
  app.innerHTML = state.tab === 'songs' ? songsView() : setlistsView();
}

/* ---------- Navegación (el botón Atrás de Android funciona) ---------- */
function openScreen(s) {
  state.screen = s;
  history.pushState({ k: 'screen' }, '');
  render();
  window.scrollTo(0, 0);
}
window.addEventListener('popstate', () => {
  if (state.stage) closeStage();
  else if (state.screen) { state.screen = null; render(); }
});

/* ---------- Modo escenario ---------- */
async function keepAwake(on) {
  try {
    if (on) wakeLock = await navigator.wakeLock?.request('screen');
    else { await wakeLock?.release(); wakeLock = null; }
  } catch { /* no es imprescindible */ }
}
document.addEventListener('visibilitychange', () => {
  if (state.stage && document.visibilityState === 'visible') keepAwake(true);
});

function openStage(ids, i = 0) {
  ids = ids.filter(songById);
  if (!ids.length) return;
  state.stage = { ids, i };
  history.pushState({ k: 'stage' }, '');
  keepAwake(true);
  drawStage();
}
function closeStage() {
  state.stage = null;
  $('#stage')?.remove();
  keepAwake(false);
  render();
}
function stageGo(d) {
  const st = state.stage;
  if (!st) return;
  const n = st.i + d;
  if (n < 0 || n >= st.ids.length) return;
  st.i = n;
  drawStage();
}

async function drawStage() {
  const { ids, i } = state.stage;
  const song = songById(ids[i]);
  let el = $('#stage');
  if (!el) { el = document.createElement('div'); el.id = 'stage'; document.body.append(el); }
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Modo escenario');
  el.innerHTML = `<div class="stage-top">
      <button class="icon" data-act="close-stage" aria-label="Cerrar modo escenario">✕</button>
      <div class="stage-title"><strong>${esc(song.title)}</strong><span>${esc(metaLine(song))}</span></div>
      <span class="count">${i + 1} de ${ids.length}</span>
      <span id="stagetools"></span>
      <button class="txt" data-act="zoom" data-d="-0.1" aria-label="Reducir partitura">A−</button>
      <button class="txt" data-act="zoom" data-d="0.1" aria-label="Ampliar partitura">A+</button></div>
    <div id="stagescore" class="paper stage-paper"></div>
    <div class="stage-bottom">
      <button class="big" data-act="prev" ${i === 0 ? 'disabled' : ''}>Anterior</button>
      <button class="big primary" data-act="next" ${i === ids.length - 1 ? 'disabled' : ''}>Siguiente</button></div>`;
  const box = $('#stagescore');
  let x0 = 0, y0 = 0;
  box.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  box.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 90 && Math.abs(dy) < 60) stageGo(dx < 0 ? 1 : -1);
  }, { passive: true });
  if (song.hasScore) {
    await loadScoreInto(box, song);
    const tools = $('#stagetools');
    if (tools && song.hasTranspose && viewer && viewer.song === song) tools.innerHTML = concertButton('Real', true);
  } else box.innerHTML = `<p class="stage-note">${esc(song.notes || 'Esta canción no tiene partitura.')}</p>`;
}

document.addEventListener('keydown', e => {
  if (!state.stage) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); stageGo(1); }
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); stageGo(-1); }
});

/* ---------- Diálogos ---------- */
function askText(title, value = '') {
  return new Promise(resolve => {
    const d = $('#dlg');
    d.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2>
      <input id="a-text" type="text" required maxlength="80" value="${esc(value)}" aria-label="${esc(title)}">
      <div class="actions"><span class="grow"></span>
        <button type="button" class="txt" id="a-no">Cancelar</button>
        <button class="solid">Aceptar</button></div></form>`;
    let out = null;
    d.onclose = () => resolve(out);
    $('#a-no', d).onclick = () => d.close();
    $('form', d).onsubmit = () => { out = $('#a-text', d).value.trim() || null; };
    d.showModal();
    $('#a-text', d).select();
  });
}

async function readScoreFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'mxl') {
    const data = await file.arrayBuffer();
    const head = new Uint8Array(data.slice(0, 2));
    if (head[0] !== 0x50 || head[1] !== 0x4b) throw new Error('mxl no válido');
    return { kind: 'mxl', name: file.name, data };
  }
  const text = await file.text();
  if (!text.includes('<score-partwise') && !text.includes('<score-timewise')) throw new Error('no es MusicXML');
  return { kind: 'xml', name: file.name, data: text };
}

async function probeScore(p) {
  const o = new opensheetmusicdisplay.OpenSheetMusicDisplay(document.createElement('div'), {});
  await o.load(scoreContent(p));
  return {
    title: (o.Sheet.TitleString || '').trim(),
    composer: (o.Sheet.ComposerString || '').trim(),
    parts: o.Sheet.Instruments.length,
    measures: o.Sheet.SourceMeasures.length
  };
}

function openSongDialog(song) {
  const d = $('#songdlg');
  let pending = null;
  d.innerHTML = `<form id="songform" method="dialog">
    <h2>${song ? 'Editar canción' : 'Nueva canción'}</h2>
    <label for="f-file">${song && song.hasScore ? 'Reemplazar partitura (MusicXML)' : 'Partitura de Sibelius (MusicXML)'}</label>
    <input id="f-file" type="file" accept=".musicxml,.xml,.mxl,.sib">
    <p id="f-msg" class="hint">En Sibelius: Archivo → Exportar → MusicXML. Los archivos .sib no se pueden leer directamente.</p>
    <label for="f-title">Título</label>
    <input id="f-title" type="text" required maxlength="120" value="${esc(song?.title)}">
    <label for="f-artist">Artista</label>
    <input id="f-artist" type="text" maxlength="120" value="${esc(song?.artist)}">
    <div class="two">
      <div><label for="f-key">Tono</label><input id="f-key" type="text" maxlength="12" value="${esc(song?.key)}"></div>
      <div><label for="f-bpm">BPM</label><input id="f-bpm" type="number" inputmode="numeric" min="30" max="300" value="${esc(song?.bpm)}"></div>
    </div>
    <label for="f-notes">Notas</label>
    <textarea id="f-notes" rows="3">${esc(song?.notes)}</textarea>
    <div class="actions">
      ${song ? '<button type="button" class="txt danger" id="f-del">Eliminar</button>' : ''}
      <span class="grow"></span>
      <button type="button" class="txt" id="f-cancel">Cancelar</button>
      <button type="submit" class="solid">Guardar</button>
    </div></form>`;

  const msg = (t, cls = '') => { const m = $('#f-msg', d); m.textContent = t; m.className = 'hint ' + cls; };

  $('#f-file', d).onchange = async e => {
    const f = e.target.files[0];
    pending = null;
    if (!f) return;
    if (f.name.toLowerCase().endsWith('.sib')) {
      msg('Sibelius guarda en un formato propio que el navegador no puede abrir. Expórtalo desde Sibelius como MusicXML (Archivo → Exportar → MusicXML) y elige ese archivo.', 'bad');
      e.target.value = '';
      return;
    }
    try {
      const p = await readScoreFile(f);
      const info = await probeScore(p);
      pending = p;
      if (!$('#f-title', d).value.trim()) $('#f-title', d).value = info.title || f.name.replace(/\.[^.]+$/, '');
      if (!$('#f-artist', d).value.trim() && info.composer) $('#f-artist', d).value = info.composer;
      msg(`Partitura lista: ${info.parts} ${info.parts === 1 ? 'parte' : 'partes'}, ${info.measures} compases.`, 'ok');
    } catch (err) {
      console.error(err);
      msg('No he podido leer ese archivo. Exporta de nuevo desde Sibelius como MusicXML (.musicxml, .xml o .mxl).', 'bad');
      e.target.value = '';
    }
  };

  $('#f-cancel', d).onclick = () => d.close();

  if (song) {
    $('#f-del', d).onclick = async () => {
      if (!confirm(`¿Eliminar «${song.title}»? Esta acción no se puede deshacer.`)) return;
      await dbDel('songs', song.id);
      await dbDel('scores', song.id);
      for (const l of state.setlists) {
        if (l.songIds.includes(song.id)) { l.songIds = l.songIds.filter(x => x !== song.id); await dbPut('setlists', l); }
      }
      d.close();
      const wasOpen = !!state.screen;
      state.screen = null;
      if (wasOpen) history.back();
      await refresh();
      toast('Canción eliminada');
    };
  }

  $('#songform', d).onsubmit = async e => {
    e.preventDefault();
    const s = song ? { ...song } : { id: uid(), hiddenParts: [], zoom: 1, hasScore: false, added: Date.now() };
    s.title = $('#f-title', d).value.trim() || 'Sin título';
    s.artist = $('#f-artist', d).value.trim();
    s.key = $('#f-key', d).value.trim();
    s.bpm = Number($('#f-bpm', d).value) || '';
    s.notes = $('#f-notes', d).value.trim();
    try {
      if (pending) {
        await dbPut('scores', { id: s.id, kind: pending.kind, name: pending.name, data: pending.data });
        s.hasScore = true;
        s.hiddenParts = [];
        delete s.hasTranspose;
        concertCache.delete(s.id);
      }
      await dbPut('songs', s);
    } catch (err) {
      console.error(err);
      toast('No se ha podido guardar. Revisa el espacio del dispositivo.');
      return;
    }
    d.close();
    await refresh();
    toast('Guardado');
  };

  d.showModal();
}

function pickSongs(l) {
  const avail = state.songs.filter(s => !l.songIds.includes(s.id));
  if (!avail.length) { toast('Todas las canciones ya están en este setlist'); return; }
  const d = $('#dlg');
  d.onclose = null;
  d.innerHTML = `<form method="dialog"><h2>Añadir canciones</h2>
    <ul class="pick">${avail.map(s => `<li><label class="check"><input type="checkbox" value="${s.id}">
      <span>${esc(s.title)}<small>${esc(s.artist || '')}</small></span></label></li>`).join('')}</ul>
    <div class="actions"><span class="grow"></span>
      <button type="button" class="txt" id="p-no">Cancelar</button>
      <button class="solid">Añadir</button></div></form>`;
  $('#p-no', d).onclick = () => d.close();
  $('form', d).onsubmit = async () => {
    const ids = [...d.querySelectorAll('input:checked')].map(i => i.value);
    if (!ids.length) return;
    l.songIds.push(...ids);
    await dbPut('setlists', l);
    await refresh();
  };
  d.showModal();
}

function openMenu() {
  const d = $('#dlg');
  d.onclose = null;
  d.innerHTML = `<form method="dialog"><h2>Atril</h2>
    <p class="hint">Todo se guarda en este dispositivo. Si borras los datos del navegador se pierde: haz copias de vez en cuando.</p>
    <div class="menu-list">
      ${installPrompt ? '<button type="button" class="txt" id="m-install">Instalar app</button>' : ''}
      <button type="button" class="txt" id="m-export">Exportar copia de seguridad</button>
      <button type="button" class="txt" id="m-import">Importar copia de seguridad</button>
    </div>
    <div class="actions"><span class="grow"></span><button class="solid">Cerrar</button></div></form>
    <input id="m-file" type="file" accept=".json,application/json" hidden>`;
  $('#m-install', d)?.addEventListener('click', async () => {
    d.close();
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
  });
  $('#m-export', d).onclick = exportBackup;
  $('#m-import', d).onclick = () => $('#m-file', d).click();
  $('#m-file', d).onchange = e => importBackup(e.target.files[0]);
  d.showModal();
}

window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; });

/* ---------- Copias de seguridad ---------- */
async function exportBackup() {
  const scores = (await dbAll('scores')).map(s => ({
    id: s.id, kind: s.kind, name: s.name,
    data: s.kind === 'mxl' ? btoa(abToBin(s.data)) : s.data
  }));
  const blob = new Blob([JSON.stringify({ app: 'atril', version: 1, songs: state.songs, setlists: state.setlists, scores })],
    { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `atril-copia-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('Copia exportada');
}

async function importBackup(file) {
  if (!file) return;
  try {
    const b = JSON.parse(await file.text());
    if (b.app !== 'atril') throw new Error('no es una copia de Atril');
    for (const s of b.songs || []) await dbPut('songs', s);
    for (const l of b.setlists || []) await dbPut('setlists', l);
    for (const s of b.scores || []) {
      await dbPut('scores', { id: s.id, kind: s.kind, name: s.name, data: s.kind === 'mxl' ? binToAb(atob(s.data)) : s.data });
    }
    $('#dlg').close();
    await refresh();
    toast('Copia importada');
  } catch (err) {
    console.error(err);
    toast('Ese archivo no es una copia válida de Atril');
  }
}

/* ---------- Acciones ---------- */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { act, id, i, d, tab } = el.dataset;
  const idx = Number(i);
  const sl = () => state.setlists.find(x => x.id === state.screen?.id);
  switch (act) {
    case 'tab': state.tab = tab; state.screen = null; render(); break;
    case 'menu': openMenu(); break;
    case 'new-song': openSongDialog(null); break;
    case 'edit-song': openSongDialog(songById(id)); break;
    case 'open-song': openScreen({ type: 'song', id }); break;
    case 'back': history.back(); break;
    case 'zoom': setZoom(Number(d)); break;
    case 'part': togglePart(idx); break;
    case 'concert':
      state.concert = !state.concert;
      try { localStorage.setItem('atril.concert', state.concert ? '1' : '0'); } catch { /* no es imprescindible */ }
      toast(state.concert ? 'Sonido real: cada parte se ve como suena' : 'Notas escritas para cada instrumento');
      if (state.stage) drawStage(); else render();
      break;
    case 'stage-song': openStage([id], 0); break;
    case 'new-setlist': {
      const name = await askText('Nombre del setlist');
      if (!name) break;
      const l = { id: uid(), name, songIds: [] };
      await dbPut('setlists', l);
      await refresh();
      openScreen({ type: 'setlist', id: l.id });
      break;
    }
    case 'open-setlist': openScreen({ type: 'setlist', id }); break;
    case 'rename-setlist': {
      const l = sl();
      const name = l && await askText('Nombre del setlist', l.name);
      if (name) { l.name = name; await dbPut('setlists', l); await refresh(); }
      break;
    }
    case 'delete-setlist': {
      const l = sl();
      if (l && confirm(`¿Eliminar el setlist «${l.name}»? Las canciones no se borran.`)) {
        await dbDel('setlists', l.id);
        state.screen = null;
        history.back();
        await refresh();
      }
      break;
    }
    case 'add-songs': { const l = sl(); if (l) pickSongs(l); break; }
    case 'sl-up': case 'sl-down': {
      const l = sl();
      const ids = l.songIds.filter(songById);
      const j = act === 'sl-up' ? idx - 1 : idx + 1;
      if (j < 0 || j >= ids.length) break;
      [ids[idx], ids[j]] = [ids[j], ids[idx]];
      l.songIds = ids;
      await dbPut('setlists', l);
      await refresh();
      break;
    }
    case 'sl-remove': {
      const l = sl();
      const ids = l.songIds.filter(songById);
      ids.splice(idx, 1);
      l.songIds = ids;
      await dbPut('setlists', l);
      await refresh();
      break;
    }
    case 'stage-setlist': { const l = sl(); if (l) openStage(l.songIds, 0); break; }
    case 'stage-from': { const l = sl(); if (l) openStage(l.songIds, idx); break; }
    case 'prev': stageGo(-1); break;
    case 'next': stageGo(1); break;
    case 'close-stage': history.back(); break;
  }
});

document.addEventListener('input', e => {
  if (e.target.id !== 'q') return;
  state.q = e.target.value;
  $('#songlist').innerHTML = songRows();
});

/* ---------- Inicio ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
refresh().catch(err => {
  console.error(err);
  $('#app').innerHTML = '<p class="empty">No se puede guardar nada en este navegador (¿modo privado?). Abre Atril en una pestaña normal de Chrome.</p>';
});
