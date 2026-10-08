'use strict';
/* Sincronización con Google Drive (carpeta oculta de la app, permiso drive.appdata).
   Cada canción, setlist y partitura es un archivo; gana siempre el cambio más reciente. */
const atrilSync = (() => {
  const CLIENT_ID = '459168317629-g0rbg6tn3c6c3o2el70h3t8dd8485t6v.apps.googleusercontent.com';
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const API = 'https://www.googleapis.com/drive/v3/files';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  const K_ON = 'atril.drive.on', K_TOKEN = 'atril.drive.token', K_LAST = 'atril.drive.last';

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* sin almacenamiento */ } }
  };

  let busy = false, again = false, timer = null, tokenClient = null, gisLoading = null;
  let info = { error: '' };

  /* ---------- Acceso a Google ---------- */
  const isOn = () => store.get(K_ON) === '1';
  function validToken() {
    try {
      const t = JSON.parse(store.get(K_TOKEN));
      return t && t.exp > Date.now() + 60000 ? t.token : null;
    } catch { return null; }
  }
  function loadGis() {
    if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
    if (!gisLoading) {
      gisLoading = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.onload = res;
        s.onerror = () => { gisLoading = null; rej(new Error('offline')); };
        document.head.appendChild(s);
      });
    }
    return gisLoading;
  }
  /* Debe llamarse desde un toque del usuario, porque Google abre una ventana. */
  async function signIn(prompt) {
    await loadGis();
    return new Promise((res, rej) => {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        callback: r => {
          if (r.error || !r.access_token) { rej(new Error(r.error || 'sin acceso')); return; }
          store.set(K_TOKEN, JSON.stringify({ token: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 }));
          store.set(K_ON, '1');
          res(r.access_token);
        },
        error_callback: e => rej(new Error((e && e.type) || 'cancelado'))
      });
      tokenClient.requestAccessToken({ prompt });
    });
  }
  function signOut() {
    const t = validToken();
    store.del(K_ON); store.del(K_TOKEN); store.del(K_LAST);
    if (t && window.google && google.accounts) { try { google.accounts.oauth2.revoke(t, () => {}); } catch { /* da igual */ } }
  }

  /* ---------- Drive ---------- */
  async function api(url, opts = {}, token) {
    const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token } });
    if (r.status === 401) { store.del(K_TOKEN); throw new Error('auth'); }
    if (!r.ok) throw new Error('drive ' + r.status);
    return r;
  }
  async function listRemote(token) {
    const map = {};
    let page = '';
    do {
      const u = `${API}?spaces=appDataFolder&pageSize=1000&q=${encodeURIComponent('trashed=false')}` +
        `&fields=${encodeURIComponent('nextPageToken,files(id,name,appProperties)')}` + (page ? '&pageToken=' + page : '');
      const j = await (await api(u, {}, token)).json();
      for (const f of j.files || []) map[f.name] = { id: f.id, u: Number((f.appProperties || {}).u) || 0 };
      page = j.nextPageToken || '';
    } while (page);
    return map;
  }
  async function put(token, name, obj, u, existing) {
    const meta = { name, appProperties: { u: String(u) } };
    if (!existing) meta.parents = ['appDataFolder'];
    const b = '----atril' + Math.random().toString(36).slice(2);
    const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
      `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(obj)}\r\n--${b}--`;
    const url = existing ? `${UPLOAD}/${existing.id}?uploadType=multipart` : `${UPLOAD}?uploadType=multipart`;
    const r = await api(url, { method: existing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body }, token);
    const j = await r.json();
    return { id: j.id, u };
  }
  const get = async (token, f) => (await api(`${API}/${f.id}?alt=media`, {}, token)).json();
  const del = (token, f) => api(`${API}/${f.id}`, { method: 'DELETE' }, token);

  /* ---------- Sincronización ---------- */
  const scoreOut = sc => ({ kind: sc.kind, name: sc.name, at: sc.at, data: sc.kind === 'mxl' ? btoa(abToBin(sc.data)) : sc.data });
  const scoreIn = (id, o) => ({ id, kind: o.kind, name: o.name, at: o.at, data: o.kind === 'mxl' ? binToAb(atob(o.data)) : o.data });

  async function pullScoreIfNewer(token, song, remote, changed) {
    const rc = remote['c-' + song.id];
    const local = await dbGet('scores', song.id);
    const localAt = (local && local.at) || 0;
    if (!song.hasScore) return;
    if (rc && rc.u > localAt) {
      const o = await get(token, rc);
      await dbPut('scores', scoreIn(song.id, { ...o, at: rc.u }), true);
      if (song.hasTranspose !== undefined) { delete song.hasTranspose; await dbPut('songs', song, true); }
      concertCache.delete(song.id);
      changed.n++;
    } else if (local && (!rc || localAt > rc.u)) {
      remote['c-' + song.id] = await put(token, 'c-' + song.id, scoreOut(local), localAt, rc);
    }
  }

  async function run(token) {
    const changed = { n: 0 };
    const tombs = loadTombs();
    const songs = await dbAll('songs'), lists = await dbAll('setlists');
    // Datos antiguos sin sello: se les da uno para poder compararlos.
    for (const s of songs) {
      let dirty = false;
      if (!s.updated) { s.updated = s.added || 1; dirty = true; }
      if (s.hasScore && !s.scoreAt) {
        s.scoreAt = s.added || 1; dirty = true;
        const sc = await dbGet('scores', s.id);
        if (sc && !sc.at) await dbPut('scores', { ...sc, at: s.scoreAt }, true);
      }
      if (dirty) await dbPut('songs', s, true);
    }
    for (const l of lists) if (!l.updated) { l.updated = 1; await dbPut('setlists', l, true); }

    let remote = await listRemote(token);

    // 1. Borrados (propios y de otros dispositivos)
    for (const [key, ts] of Object.entries(tombs)) {
      const rt = remote['x-' + key];
      const rf = remote[key + '.json'];
      if (rf && rf.u > ts) { delete tombs[key]; continue; }      // alguien lo editó después de borrarlo aquí
      if (rf) { await del(token, rf); delete remote[key + '.json']; }
      if (key.startsWith('s-') && remote['c-' + key.slice(2)]) { await del(token, remote['c-' + key.slice(2)]); delete remote['c-' + key.slice(2)]; }
      if (!rt || rt.u < ts) remote['x-' + key] = await put(token, 'x-' + key, {}, ts, rt);
      delete tombs[key];
    }
    saveTombs(tombs);
    const localMap = { s: Object.fromEntries(songs.map(x => [x.id, x])), l: Object.fromEntries(lists.map(x => [x.id, x])) };
    for (const [name, rt] of Object.entries(remote)) {
      if (!name.startsWith('x-')) continue;
      const key = name.slice(2);
      const id = key.slice(2);
      const rec = localMap[key[0]][id];
      if (rec && rec.updated > rt.u) { await del(token, rt); delete remote[name]; continue; }   // se recuperó después
      if (rec) {
        await dbDel(key[0] === 's' ? 'songs' : 'setlists', id, true);
        if (key[0] === 's') await dbDel('scores', id, true);
        delete localMap[key[0]][id];
        changed.n++;
      }
      const rf = remote[key + '.json'];
      if (rf && rf.u <= rt.u) { await del(token, rf); delete remote[key + '.json']; }
    }

    // 2. Canciones y setlists
    for (const [kind, store_, prefix] of [['s', 'songs', 's-'], ['l', 'setlists', 'l-']]) {
      const ids = new Set(Object.keys(localMap[kind]));
      for (const name of Object.keys(remote)) {
        if (name.startsWith(prefix) && name.endsWith('.json') && !remote['x-' + name.slice(0, -5)]) ids.add(name.slice(2, -5));
      }
      for (const id of ids) {
        const rf = remote[prefix + id + '.json'];
        let rec = localMap[kind][id];
        if (rf && (!rec || rf.u > rec.updated)) {
          rec = await get(token, rf);
          rec.updated = rf.u;
          await dbPut(store_, rec, true);
          changed.n++;
        } else if (rec && (!rf || rec.updated > rf.u)) {
          remote[prefix + id + '.json'] = await put(token, prefix + id + '.json', rec, rec.updated, rf);
        }
        if (kind === 's' && rec) await pullScoreIfNewer(token, rec, remote, changed);
      }
    }
    store.set(K_LAST, String(Date.now()));
    return changed.n;
  }

  async function sync(manual) {
    if (!isOn()) return;
    if (busy) { again = true; return; }
    const token = validToken();
    if (!token) { info.error = 'Toca para reconectar'; armGesture(); return; }
    busy = true; info.error = '';
    try {
      const n = await run(token);
      if (n) {
        if (state.stage) {
          state.songs = (await dbAll('songs')).sort((a, b) => byText(a.title, b.title));
          state.setlists = (await dbAll('setlists')).sort((a, b) => byText(a.name, b.name));
        } else await refresh();
      }
      if (manual) toast(n ? 'Sincronizado: ' + n + (n === 1 ? ' cambio recibido' : ' cambios recibidos') : 'Todo al día con Drive');
    } catch (err) {
      console.error(err);
      info.error = err.message === 'auth' ? 'Toca para reconectar' : 'No se pudo sincronizar (¿sin conexión?)';
      if (err.message === 'auth') armGesture();
      if (manual) toast(info.error);
    } finally {
      busy = false;
      if (again) { again = false; schedule(); }
    }
  }

  /* Sin ventana emergente no se puede renovar el acceso: se espera al siguiente toque. */
  let armed = false;
  function armGesture() {
    if (armed || !isOn()) return;
    armed = true;
    document.addEventListener('click', async function once() {
      document.removeEventListener('click', once, true);
      armed = false;
      try { await signIn(''); sync(false); } catch { /* el usuario cerró la ventana */ }
    }, true);
  }

  function schedule() {
    if (!isOn()) return;
    clearTimeout(timer);
    timer = setTimeout(() => sync(false), 4000);
  }

  /* ---------- Menú ---------- */
  function ago() {
    const t = Number(store.get(K_LAST));
    if (!t) return 'aún no sincronizado';
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? 'hace un momento' : m < 60 ? `hace ${m} min` : `hace ${Math.round(m / 60)} h`;
  }
  function menuHTML() {
    if (!isOn()) {
      return `<button type="button" class="txt" id="m-drive">Conectar con Google Drive</button>
        <p class="hint">Así tus canciones y partituras aparecen en todos tus dispositivos.</p>`;
    }
    return `<p class="hint ${info.error ? 'bad' : 'ok'}" id="m-dstatus">${info.error || 'Drive conectado · ' + ago()}</p>
      <button type="button" class="txt" id="m-sync">Sincronizar ahora</button>
      <button type="button" class="txt" id="m-unlink">Desconectar Drive</button>`;
  }
  function bindMenu(d) {
    const redraw = () => { d.close(); openMenu(); };
    const c = $('#m-drive', d);
    if (c) c.onclick = async () => {
      try {
        await signIn('');
        info.error = '';
        redraw();
        await sync(true);
        if (d.open) redraw();
      } catch (err) {
        console.error(err);
        toast(err.message === 'offline' ? 'Necesitas conexión para conectar con Drive' : 'No se pudo conectar con Google');
      }
    };
    const s = $('#m-sync', d);
    if (s) s.onclick = async () => {
      if (!validToken()) {
        try { await signIn(''); } catch { toast('No se pudo conectar con Google'); return; }
      }
      s.disabled = true;
      await sync(true);
      if (d.open) redraw();
    };
    const u = $('#m-unlink', d);
    if (u) u.onclick = () => { signOut(); toast('Drive desconectado. Tus datos siguen en este dispositivo.'); redraw(); };
  }

  /* ---------- Arranque ---------- */
  if (isOn()) {
    if (validToken()) sync(false); else armGesture();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && validToken()) schedule(); });
  }

  return { schedule, menuHTML, bindMenu, sync, isOn };
})();
window.atrilSync = atrilSync;
