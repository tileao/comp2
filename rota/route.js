/* Plano de rota (lab) — lógica sem DOM: rota, pernas, vento por nível e combustível.
 *
 * Base: nav-data.js (bases, UM e Bacia de Santos, de fontes públicas).
 * Vento e temperatura: Open-Meteo (previsão de modelo nos níveis de pressão; não é produto oficial).
 * Consumo: motor do fluxo Combustível (../combustivel/engine.js, cartas Cruise AEO do RFM, Seção 9).
 */
(function (root) {
  'use strict';

  const R_NM = 3440.065; // raio da Terra em NM
  const D2R = Math.PI / 180;
  const LEVELS = [1000, 975, 950, 925, 900, 850, 800, 700]; // hPa: cobre de ~0 a ~10.000 ft
  const SAMPLE_NM = 30; // perna longa: um ponto de vento a cada ~30 NM

  // ---------- base ----------
  function norm(s) { return String(s).toUpperCase().replace(/[\s\-_.]/g, ''); }

  // Coordenada digitada como no FMS: 2501S04240W ou 2501.4S04240.1W (graus e minutos).
  function parseLatLon(tok) {
    const m = /^(\d{2})(\d{2}(?:\.\d+)?)([NS])(\d{3})(\d{2}(?:\.\d+)?)([EW])$/.exec(tok);
    if (!m) return null;
    const lat = (+m[1] + +m[2] / 60) * (m[3] === 'S' ? -1 : 1);
    const lon = (+m[4] + +m[5] / 60) * (m[6] === 'W' ? -1 : 1);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || +m[2] >= 60 || +m[5] >= 60) return null;
    return { id: tok, lat, lon, k: 'coord' };
  }

  function createNav(data) {
    const byKey = {};
    for (const [id, p] of Object.entries(data.pts)) {
      const pt = { id, ...p };
      byKey[norm(id)] = pt;
      if (p.nome && p.k === 'um') byKey[norm(p.nome)] = pt;
    }
    const awy = data.awy;
    function lookup(tok) {
      return byKey[norm(tok)] || parseLatLon(String(tok).toUpperCase()) || null;
    }
    // Ponto dentro da área offshore da Bacia de Santos (CIRCEA 100-109)
    function inSantos(lat, lon) { return pointInPoly(lat, lon, data.santos.area); }
    return { data, lookup, awy, inSantos, niveis: data.santos.niveis };
  }

  function pointInPoly(lat, lon, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [yi, xi] = poly[i], [yj, xj] = poly[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // ---------- rota ----------
  // Texto como no FMS: "SBJR DIBIL KZ204 BS072 9PMO". Aerovia entre dois pontos dela, no sentido dela.
  function parseRoute(nav, text) {
    const toks = String(text || '').toUpperCase().split(/[\s,;]+/).filter(Boolean);
    const pts = [], errors = [], airways = [];
    for (let i = 0; i < toks.length; i++) {
      const tok = toks[i];
      const aw = nav.awy[tok];
      if (aw) {
        const prev = pts[pts.length - 1];
        const next = toks[i + 1];
        if (!prev) { errors.push(`${tok}: falta o ponto de entrada antes da aerovia.`); continue; }
        if (!next) { errors.push(`${tok}: falta o ponto de saída depois da aerovia.`); continue; }
        const a = aw.pts.indexOf(prev.id);
        if (a < 0) { errors.push(`${prev.id} não está na ${tok}.`); continue; }
        const bi = aw.pts.indexOf(next);
        if (bi < 0) { errors.push(`${next} não está na ${tok}.`); i++; continue; }
        if (bi <= a) {
          errors.push(`${tok} é de mão única (${aw.sentido}): de ${prev.id} não se chega a ${next} por ela.`);
          i++;
          continue;
        }
        for (const id of aw.pts.slice(a + 1, bi + 1)) pts.push({ ...nav.lookup(id), via: tok });
        airways.push(tok);
        i++; // o ponto de saída já entrou
        continue;
      }
      const p = nav.lookup(tok);
      if (!p) { errors.push(`${tok}: ponto não encontrado na base.`); continue; }
      if (pts.length && pts[pts.length - 1].id === p.id) continue;
      pts.push({ ...p });
    }
    if (pts.length < 2 && !errors.length) errors.push('A rota precisa de pelo menos dois pontos.');
    const santos = airways.length > 0 || pts.some((p) => p.k === 'santos' || (p.k === 'um' && p.bacia === 'Santos'));
    return { pts, errors, airways, santos };
  }

  function reverseRoute(r) {
    return { pts: r.pts.slice().reverse().map((p) => ({ ...p, via: undefined })), errors: [], airways: [], santos: r.santos, reversed: true };
  }

  // ---------- geometria ----------
  function gcDist(a, b) {
    const f1 = a.lat * D2R, f2 = b.lat * D2R, dl = (b.lon - a.lon) * D2R;
    const h = Math.sin((f2 - f1) / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
    return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function gcCourse(a, b) {
    const f1 = a.lat * D2R, f2 = b.lat * D2R, dl = (b.lon - a.lon) * D2R;
    const y = Math.sin(dl) * Math.cos(f2);
    const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
    return (Math.atan2(y, x) / D2R + 360) % 360;
  }
  function interpPt(a, b, f) {
    // pernas curtas: interpolação em lat/lon basta para amostrar o vento
    return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
  }

  // Pernas com distância (ortodrômica), rumo verdadeiro no meio da perna e pontos de amostra do vento.
  function buildLegs(pts) {
    const legs = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const dist = gcDist(a, b);
      if (dist < 0.05) continue;
      const n = Math.max(1, Math.ceil(dist / SAMPLE_NM));
      const samples = [];
      for (let k = 0; k < n; k++) samples.push({ ...interpPt(a, b, (k + 0.5) / n), frac: (k + 0.5) / n });
      const mid = interpPt(a, b, 0.5);
      legs.push({ from: a, to: b, dist, crs: gcCourse(mid, b), samples, via: b.via || null });
    }
    return legs;
  }

  // ---------- vento (Open-Meteo) ----------
  function isoHour(ms) { return new Date(ms).toISOString().slice(0, 13) + ':00'; }

  function windUrl(samples, t0ms, t1ms) {
    const vars = [];
    for (const p of LEVELS) vars.push(`wind_speed_${p}hPa`, `wind_direction_${p}hPa`, `temperature_${p}hPa`);
    const lat = samples.map((s) => s.lat.toFixed(3)).join(',');
    const lon = samples.map((s) => s.lon.toFixed(3)).join(',');
    const start = isoHour(Math.floor(t0ms / 3600e3) * 3600e3);
    const end = isoHour(Math.ceil(t1ms / 3600e3) * 3600e3);
    return 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
      '&hourly=' + vars.join(',') + '&wind_speed_unit=kn&timezone=GMT&start_hour=' + start + '&end_hour=' + end;
  }

  // Resposta → um campo por ponto: tempos (ms) e, por nível, u/v (kt, vetor "para onde vai") e temperatura.
  function parseWind(json, n) {
    const list = Array.isArray(json) ? json : [json];
    if (list.length !== n) throw new Error(`Vento: ${list.length} pontos na resposta, ${n} pedidos.`);
    return list.map((loc) => {
      const h = loc.hourly;
      if (!h || !h.time) throw new Error('Vento: resposta sem dados horários.');
      const times = h.time.map((t) => Date.parse(t + 'Z'));
      const lv = {};
      for (const p of LEVELS) {
        const spd = h[`wind_speed_${p}hPa`], dir = h[`wind_direction_${p}hPa`], tmp = h[`temperature_${p}hPa`];
        if (!spd || !dir || !tmp) continue;
        lv[p] = spd.map((s, i) => {
          if (s == null || dir[i] == null || tmp[i] == null) return null;
          const d = dir[i] * D2R;
          return { u: -s * Math.sin(d), v: -s * Math.cos(d), t: tmp[i] };
        });
      }
      return { lat: loc.latitude, lon: loc.longitude, times, lv };
    });
  }

  // Pressão da atmosfera padrão para uma altitude-pressão (ft).
  function paToHpa(pa) { return 1013.25 * Math.pow(1 - 6.8756e-6 * pa, 5.2559); }

  // Vento e temperatura num ponto amostrado, na hora e na pressão pedidas.
  function windAt(field, tMs, hpa) {
    const { times, lv } = field;
    let i = 0;
    while (i < times.length - 2 && times[i + 1] < tMs) i++;
    const fT = times.length < 2 ? 0 : Math.min(1, Math.max(0, (tMs - times[i]) / (times[i + 1] - times[i])));
    const atLevel = (p) => {
      const a = lv[p] && lv[p][i], b = lv[p] && lv[p][Math.min(i + 1, times.length - 1)];
      if (!a || !b) return null;
      return { u: a.u + (b.u - a.u) * fT, v: a.v + (b.v - a.v) * fT, t: a.t + (b.t - a.t) * fT };
    };
    const ps = LEVELS.filter((p) => lv[p]);
    if (!ps.length) return null;
    if (hpa >= ps[0]) return atLevel(ps[0]);
    if (hpa <= ps[ps.length - 1]) return hpa < ps[ps.length - 1] - 25 ? null : atLevel(ps[ps.length - 1]);
    for (let k = 0; k < ps.length - 1; k++) {
      const p1 = ps[k], p2 = ps[k + 1];
      if (hpa <= p1 && hpa >= p2) {
        const a = atLevel(p1), b = atLevel(p2);
        if (!a || !b) return null;
        const f = (Math.log(p1) - Math.log(hpa)) / (Math.log(p1) - Math.log(p2));
        return { u: a.u + (b.u - a.u) * f, v: a.v + (b.v - a.v) * f, t: a.t + (b.t - a.t) * f };
      }
    }
    return null;
  }

  function windToDirSpd(u, v) {
    const spd = Math.hypot(u, v);
    const dir = (Math.atan2(-u, -v) / D2R + 360) % 360;
    return { dir, spd };
  }

  // ---------- níveis ----------
  function levelsFor(mode, dir, nav, qnh) {
    if (mode === 'circea') {
      const fl = dir === 'ida' ? nav.niveis.ida : nav.niveis.volta;
      return fl.map((s) => { const v = +s.replace('FL', '') * 100; return { label: s, pa: v, alt: null }; });
    }
    const out = [];
    for (let a = 1000; a <= 8000; a += 1000) {
      const q = qnh >= 800 && qnh <= 1100 ? qnh : 1013.25;
      out.push({ label: `${a} ft`, pa: a + (1013.25 - q) * 30, alt: a });
    }
    return out;
  }

  // ---------- plano ----------
  // engine: AW139Fuel.create(...); fields: vento por ponto amostrado (mesma ordem de samples)
  function planDirection(engine, legs, fields, idx, levels, opt) {
    const rows = [];
    for (const lv of levels) {
      const hpa = paToHpa(lv.pa);
      let t = opt.t0;
      let fuel = 0, time = 0, ok = true, err = null;
      const legOut = [];
      for (let li = 0; li < legs.length; li++) {
        const leg = legs[li];
        let su = 0, sv = 0, st = 0, n = 0;
        for (let k = 0; k < leg.samples.length; k++) {
          const f = fields[idx[li][k]];
          const tSample = t + (leg.samples[k].frac * leg.dist / 140) * 3600e3; // hora aproximada no ponto
          const w = windAt(f, tSample, hpa);
          if (!w) { ok = false; err = 'sem vento nesse nível'; break; }
          su += w.u; sv += w.v; st += w.t; n++;
        }
        if (!ok) break;
        const u = su / n, v = sv / n, oat = st / n;
        const c = leg.crs * D2R;
        const hw = -(u * Math.sin(c) + v * Math.cos(c));
        const xw = u * Math.cos(c) - v * Math.sin(c);
        const r = engine.solve({ pa: lv.pa, oat, gwKg: opt.gwKg, hw, xw, cf: opt.cf || 0, ibf: !!opt.ibf, tas: opt.speed === 'tas150' ? 150 : null });
        if (r.err) { ok = false; err = r.err; break; }
        const p = opt.speed === 'tas150' ? r.fix : r.rng;
        if (!p || p.out || !(p.gs > 20)) { ok = false; err = 'sem solução nas cartas'; break; }
        const hrs = leg.dist / p.gs;
        const wd = windToDirSpd(u, v);
        legOut.push({ leg, hw, xw, oat, wind: wd, p, hrs, fuel: p.ff * hrs });
        fuel += p.ff * hrs; time += hrs; t += hrs * 3600e3;
      }
      const dist = legs.reduce((a, l) => a + l.dist, 0);
      rows.push(ok ? { lv, ok, fuel, time, dist, legs: legOut, hwAvg: legOut.reduce((a, x) => a + x.hw * x.leg.dist, 0) / dist }
        : { lv, ok, err });
    }
    const okRows = rows.filter((r) => r.ok);
    const best = okRows.reduce((a, b) => (!a || b.fuel < a.fuel ? b : a), null);
    const near = best ? okRows.filter((r) => r !== best && r.fuel <= best.fuel * 1.01).map((r) => r.lv.label) : [];
    return { rows, best, near };
  }

  const api = { createNav, parseRoute, reverseRoute, buildLegs, windUrl, parseWind, windAt, paToHpa, windToDirSpd, levelsFor, planDirection, gcDist, gcCourse, parseLatLon, pointInPoly, LEVELS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AW139Route = api;
})(typeof window !== 'undefined' ? window : globalThis);
