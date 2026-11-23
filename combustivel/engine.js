/* Motor de cálculo do fluxo Combustível (AW139 Companion).
 *
 * Base: cartas Cruise AEO do RFM (Seção 9, Fig. 9-1 a 9-55), extraídas em cruise-data.js.
 * Interpolação como no exemplo da p. 9-3 do RFM: primeiro em OAT (mesma PA), depois em PA.
 * Entre curvas de peso, interpolação linear no peso.
 *
 * Sem DOM: roda no navegador (window.AW139Fuel) e no Node (testes).
 */
(function (root) {
  'use strict';

  const KG_TO_LB = 2.2046226218;
  const IBF_FACTOR = 1.035; // RFM Supl. 86: consumo "may increase up to 3.5%" no mesmo torque
  const ISA_LAPSE = 1.98; // °C por 1000 ft (atmosfera padrão)

  function lerp(a, b, f) { return a + (b - a) * f; }
  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

  // Tabela [[x, y], ...] crescente em x; null fora da faixa (não extrapola).
  function tab(xy, x) {
    const n = xy.length;
    if (!n || !(x >= xy[0][0] - 1e-9) || !(x <= xy[n - 1][0] + 1e-9)) return null;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (xy[m][0] <= x) lo = m; else hi = m;
    }
    const x0 = xy[lo][0], y0 = xy[lo][1], x1 = xy[hi][0], y1 = xy[hi][1];
    return x1 === x0 ? y0 : y0 + (y1 - y0) * (x - x0) / (x1 - x0);
  }

  // Inversa de uma tabela crescente em y.
  function tabInv(xy, y) {
    const n = xy.length;
    if (!n || !(y >= xy[0][1] - 1e-9) || !(y <= xy[n - 1][1] + 1e-9)) return null;
    for (let i = 1; i < n; i++) {
      if (xy[i][1] >= y) {
        const x0 = xy[i - 1][0], y0 = xy[i - 1][1], x1 = xy[i][0], y1 = xy[i][1];
        return y1 === y0 ? x0 : x0 + (x1 - x0) * (y - y0) / (y1 - y0);
      }
    }
    return xy[n - 1][0];
  }

  function isaTemp(pa) { return 15 - ISA_LAPSE * pa / 1000; }

  function create(data) {
    const charts = data.charts;
    const pas = [...new Set(charts.map((c) => c.pa))].sort((a, b) => a - b);
    const byPa = {};
    for (const c of charts) (byPa[c.pa] = byPa[c.pa] || []).push(c);
    for (const p of pas) byPa[p].sort((a, b) => a.oat - b.oat);
    const gwMin = 4400, gwMax = 6800;

    // ---------- carta isolada ----------
    function endType(c, k) {
      const [t, q] = k[k.length - 1];
      if (c.vne && Math.abs(t - c.vne) < 0.8) return 'VNE';
      if (Math.abs(q - c.mcp) < 0.8) return 'MCP';
      if (Math.abs(q - c.top) < 0.8) return 'TOP';
      return 'limite';
    }

    // Curva de uma carta prolongada pela inclinação final (só para preencher o vão entre
    // as pontas de duas curvas de peso vizinhas; nunca além da ponta interpolada).
    function tqExt(k, t) {
      const v = tab(k, t);
      if (v != null) return v;
      const n = k.length;
      if (t < k[0][0]) return null;
      const t1 = k[n - 1][0], q1 = k[n - 1][1];
      const q0 = tab(k, t1 - 4);
      if (q0 == null) return null;
      return q1 + ((q1 - q0) / 4) * (t - t1);
    }

    function model(c, gw, cf) {
      const gws = Object.keys(c.gw).map(Number).sort((a, b) => a - b);
      if (gw < gws[0] - 1e-6 || gw > gws[gws.length - 1] + 1e-6) return null;
      let g1 = gws[0], g2 = gws[gws.length - 1];
      for (const g of gws) { if (g <= gw + 1e-6) g1 = g; }
      for (const g of gws.slice().reverse()) { if (g >= gw - 1e-6) g2 = g; }
      const f = g2 === g1 ? 0 : (gw - g1) / (g2 - g1);
      const k1 = c.gw[g1], k2 = c.gw[g2];
      const t0 = Math.max(k1[0][0], k2[0][0]);
      const e1 = k1[k1.length - 1][0], e2 = k2[k2.length - 1][0];
      const ty1 = endType(c, k1), ty2 = endType(c, k2);
      // Entre duas curvas, a ponta (VNE/MCP) também é interpolada no peso.
      let t1 = lerp(e1, e2, f);
      let endKind = f <= 0.5 ? ty1 : ty2;
      if (ty1 === ty2) endKind = ty1;
      const tqAt = (t) => {
        if (t > t1 + 1e-6) return null;
        const a = f < 1 ? tqExt(k1, t) : 0, b = f > 0 ? tqExt(k2, t) : 0;
        if (a == null || b == null) return null;
        let q = f <= 0 ? a : f >= 1 ? b : lerp(a, b, f);
        if (cf) {
          const d = tab(c.dtq, t);
          q += cf * (d == null ? c.dtq[c.dtq.length - 1][1] : d);
        }
        return q;
      };
      // Com equipamento externo, o torque pode passar da MCP antes do fim da curva limpa.
      if (cf && tqAt(t1) > c.mcp) {
        let tMin = t0, qMin = Infinity;
        for (let t = t0; t <= t1; t += 1) { const q = tqAt(t); if (q != null && q < qMin) { qMin = q; tMin = t; } }
        if (qMin > c.mcp) return null;
        let lo = tMin, hi = t1;
        for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (tqAt(m) > c.mcp) hi = m; else lo = m; }
        t1 = lo;
        endKind = 'MCP';
      }
      return { c, gw, g1, g2, f, t0, t1, tqAt, cf, endKind };
    }

    function ffAt(m, t, ibf) {
      const q = m.tqAt(t);
      if (q == null) return null;
      const ff = tab(m.c.ff, q);
      return ff == null ? null : ff * (ibf ? IBF_FACTOR : 1);
    }

    function gsOf(tas, hw, xw) {
      const x = Math.min(Math.abs(xw || 0), tas);
      return Math.sqrt(tas * tas - x * x) - (hw || 0);
    }

    function argMinFF(m) {
      let best = null, tb = null;
      for (let t = Math.ceil(m.t0); t <= m.t1; t += 0.5) {
        const v = ffAt(m, t, false);
        if (v != null && (best == null || v < best)) { best = v; tb = t; }
      }
      if (tb == null) return null;
      for (let t = Math.max(m.t0, tb - 0.5); t <= Math.min(m.t1, tb + 0.5); t += 0.05) {
        const v = ffAt(m, t, false);
        if (v != null && v < best) { best = v; tb = t; }
      }
      return tb;
    }

    function argMaxSR(m, hw, xw, tLo) {
      let best = -Infinity, tb = null;
      const lo = Math.max(m.t0, tLo == null ? m.t0 : tLo);
      for (let t = lo; t <= m.t1 + 1e-9; t += 0.5) {
        const ff = ffAt(m, t, false); if (ff == null) continue;
        const sr = gsOf(t, hw, xw) / ff;
        if (sr > best) { best = sr; tb = t; }
      }
      if (tb == null) return null;
      for (let t = Math.max(lo, tb - 0.5); t <= Math.min(m.t1, tb + 0.5); t += 0.05) {
        const ff = ffAt(m, t, false); if (ff == null) continue;
        const sr = gsOf(t, hw, xw) / ff;
        if (sr > best) { best = sr; tb = t; }
      }
      return { t: tb, sr: best };
    }

    // Recommended cruise: velocidade acima do max range em que o alcance cai 1 % (RFM p. 9-2).
    function recAbove(m, hw, xw, r) {
      if (!r) return null;
      for (let t = r.t; t <= m.t1 + 1e-9; t += 0.1) {
        const ff = ffAt(m, t, false); if (ff == null) continue;
        if (gsOf(t, hw, xw) / ff <= 0.99 * r.sr) return { t, limited: false };
      }
      return { t: m.t1, limited: true };
    }

    function limitName(m) { return m.endKind; }

    function point(m, t, ibf, tag) {
      const tq = m.tqAt(t);
      if (tq == null) return null;
      const ff0 = tab(m.c.ff, tq);
      if (ff0 == null) return null;
      return { tas: t, tq, ff: ff0 * (ibf ? IBF_FACTOR : 1), ias: tab(m.c.ias, t), tag: tag || null };
    }

    // Velocidade além do fim da curva limitada pela MCP: prolonga a inclinação final da curva
    // (até 10 kt e até o TOP), só numa carta vizinha de peso menor que 0,5 na interpolação.
    // Só para a IAS informada pelo piloto; marcado como 'extrap'.
    function beyond(m, t, ibf, w) {
      if (t <= m.t1 + 1e-6) return point(m, t, ibf, null);
      if (limitName(m) !== 'MCP' || t - m.t1 > 10 || !(w <= 0.5)) return null;
      const q1 = m.tqAt(m.t1), q0 = m.tqAt(m.t1 - 4);
      if (q1 == null || q0 == null) return null;
      const q = q1 + ((q1 - q0) / 4) * (t - m.t1);
      if (q > m.c.top) return null;
      const ff0 = tab(m.c.ff, q);
      if (ff0 == null) return null;
      return { tas: t, tq: q, ff: ff0 * (ibf ? IBF_FACTOR : 1), ias: tab(m.c.ias, t), tag: 'extrap' };
    }

    // Resultados numa carta. o = { gw, hw, xw, cf, ibf, ias, tas }
    function onChart(c, o) {
      const m = model(c, o.gw, o.cf);
      if (!m) return null;
      const m0 = o.cf ? model(c, o.gw, 0) : m;
      const doc = (k) => {
        const a = c.opt[k][m.g1], b = c.opt[k][m.g2];
        if (!a || !b) return null;
        return { tas: lerp(a[0], b[0], m.f), flags: [a[1], b[1]] };
      };
      const res = { fig: c.fig, pg: c.pg, pa: c.pa, oat: c.oat, mcp: c.mcp, vne: c.vne, t0: m.t0, t1: m.t1 };
      const lim = (t, flags) => {
        if (t >= m.t1 - 0.3) return limitName(m);
        if (flags && flags.some((x) => x === 'v')) return 'VNE';
        if (flags && flags.some((x) => x === 'm')) return 'MCP';
        return null;
      };
      // Max endurance
      const eDoc = doc('e');
      const e0 = argMinFF(m0), eC = o.cf ? argMinFF(m) : e0;
      if (eDoc && e0 != null && eC != null) {
        const t = clamp(eDoc.tas + (eC - e0), m.t0, m.t1);
        res.end = point(m, t, o.ibf, lim(t));
      }
      // Max range (com vento: desloca a linha da carta pelo deslocamento do ótimo calculado)
      const rDoc = doc('r');
      const r0 = argMaxSR(m0, 0, 0, e0), rW = argMaxSR(m, o.hw, o.xw, eC);
      if (rDoc && r0 && rW && res.end) {
        const t = clamp(rDoc.tas + (rW.t - r0.t), res.end.tas, m.t1);
        res.rng = point(m, t, o.ibf, lim(t, rDoc.flags));
        res.rngShift = rW.t - r0.t;
      }
      // Recommended cruise
      const cDoc = doc('c');
      const c0 = recAbove(m0, 0, 0, r0), cW = recAbove(m, o.hw, o.xw, rW);
      if (cDoc && c0 && cW && res.rng) {
        const t = clamp(cDoc.tas + (cW.t - c0.t), res.rng.tas, m.t1);
        res.rec = point(m, t, o.ibf, lim(t, cDoc.flags));
      }
      // Velocidade informada (IAS) ou TAS fixa
      if (o.ias != null) {
        const t = tabInv(c.ias, o.ias);
        let p = null;
        if (t != null && t >= m.t0 - 1e-6) p = beyond(m, t, o.ibf, o.w);
        res.cur = p || { out: t == null ? 'escala' : (t > m.t1 ? 'acima' : 'abaixo') };
      }
      if (o.tas != null) {
        const t = clamp(o.tas, m.t0, m.t1);
        res.fix = point(m, t, o.ibf, o.tas > m.t1 + 1e-6 ? limitName(m) : null);
      }
      return res;
    }

    // ---------- interpolação entre cartas ----------
    function bracket(pa, oat) {
      if (!(pa >= pas[0] && pa <= pas[pas.length - 1])) {
        return { err: `PA ${Math.round(pa)} ft fora das cartas (${pas[0]} a ${pas[pas.length - 1]} ft).` };
      }
      let p1 = pas[0], p2 = pas[pas.length - 1];
      for (const p of pas) { if (p <= pa) p1 = p; }
      for (const p of pas.slice().reverse()) { if (p >= pa) p2 = p; }
      const fp = p2 === p1 ? 0 : (pa - p1) / (p2 - p1);
      const parts = [];
      for (const [p, wp] of (p1 === p2 ? [[p1, 1]] : [[p1, 1 - fp], [p2, fp]])) {
        const list = byPa[p];
        const lo = list[0].oat, hi = list[list.length - 1].oat;
        if (!(oat >= lo - 1e-9 && oat <= hi + 1e-9)) {
          return { err: `OAT ${fmt1(oat)} °C fora das cartas em ${p} ft (${lo} a ${hi} °C).` };
        }
        let c1 = list[0], c2 = list[list.length - 1];
        for (const c of list) { if (c.oat <= oat) c1 = c; }
        for (const c of list.slice().reverse()) { if (c.oat >= oat) c2 = c; }
        const fo = c2 === c1 ? 0 : (oat - c1.oat) / (c2.oat - c1.oat);
        if (c1 === c2) parts.push({ c: c1, w: wp });
        else { parts.push({ c: c1, w: wp * (1 - fo) }); parts.push({ c: c2, w: wp * fo }); }
      }
      return { parts: parts.filter((x) => x.w > 1e-9) };
    }

    function fmt1(v) { return (Math.round(v * 10) / 10).toString(); }

    function combine(items, key) {
      // items: [{w, r}] com r[key] = ponto; devolve ponto ponderado ou null
      let tas = 0, tq = 0, ff = 0, ias = 0, iasOk = true, tags = [];
      for (const it of items) {
        const p = it.r && it.r[key];
        if (!p || p.out) return { out: p && p.out ? p.out : 'indisponível' };
        tas += it.w * p.tas; tq += it.w * p.tq; ff += it.w * p.ff;
        if (p.ias == null) iasOk = false; else ias += it.w * p.ias;
        if (p.tag) tags.push({ tag: p.tag, oat: it.r.oat, pa: it.r.pa, w: it.w });
      }
      const ex = tags.filter((x) => x.tag === 'extrap');
      // Limite (VNE/MCP) só vale para o resultado se pesar pelo menos metade na interpolação.
      const wOf = (name) => tags.filter((x) => x.tag === name).reduce((a, x) => a + x.w, 0);
      const lims = [...new Set(tags.map((x) => x.tag).filter((t) => t !== 'extrap'))];
      const tag = lims.find((t) => wOf(t) >= 0.5 - 1e-9) || null;
      return { tas, tq, ff, ias: iasOk ? ias : null, tag, extrap: ex.length ? ex : null };
    }

    // Cálculo principal.
    // q = { pa, oat, gwKg, hw, xw, cf, ibf, ias, tas }
    function solve(q) {
      const gw = q.gwKg;
      if (!(gw >= gwMin - 1e-6 && gw <= gwMax + 1e-6)) {
        return { err: `Peso ${Math.round(gw)} kg fora das cartas de cruzeiro (${gwMin} a ${gwMax} kg).` };
      }
      const b = bracket(q.pa, q.oat);
      if (b.err) return { err: b.err };
      const items = [];
      for (const part of b.parts) {
        const r = onChart(part.c, { gw, hw: q.hw || 0, xw: q.xw || 0, cf: q.cf || 0, ibf: !!q.ibf, ias: q.ias, tas: q.tas, w: part.w });
        if (!r) return { err: `Sem curva para ${Math.round(gw)} kg na Fig. ${part.c.fig} (PA ${part.c.pa} ft, OAT ${part.c.oat} °C).` };
        items.push({ w: part.w, r });
      }
      const out = {
        charts: items.map((it) => ({ fig: it.r.fig, pg: it.r.pg, pa: it.r.pa, oat: it.r.oat, w: it.w })),
        end: combine(items, 'end'),
        rng: combine(items, 'rng'),
        rec: combine(items, 'rec'),
        cur: q.ias != null ? combine(items, 'cur') : null,
        fix: q.tas != null ? combine(items, 'fix') : null,
        q,
      };
      if (out.end.out || out.rng.out) return { err: 'Fora da faixa das cartas para estes dados.', partial: out };
      const gs = (p) => (p && !p.out ? gsOf(p.tas, q.hw, q.xw) : null);
      for (const k of ['end', 'rng', 'rec', 'cur', 'fix']) {
        const p = out[k];
        if (p && !p.out) { p.gs = gs(p); p.sr = p.gs / p.ff; }
      }
      return out;
    }

    // Curva consumo × TAS na condição pedida (para o gráfico).
    function ffCurve(q, step) {
      const b = bracket(q.pa, q.oat);
      if (b.err) return null;
      const ms = b.parts.map((part) => ({ w: part.w, m: model(part.c, q.gwKg, q.cf || 0) }));
      if (ms.some((x) => !x.m)) return null;
      const t0 = Math.max(...ms.map((x) => x.m.t0)), t1 = Math.min(...ms.map((x) => x.m.t1));
      const pts = [];
      for (let t = Math.ceil(t0 / (step || 2)) * (step || 2); t <= t1 + 1e-9; t += step || 2) {
        let ff = 0, ok = true;
        for (const x of ms) {
          const v = ffAt(x.m, t, !!q.ibf);
          if (v == null) { ok = false; break; }
          ff += x.w * v;
        }
        if (ok) pts.push([t, ff]);
      }
      return { t0, t1, pts };
    }

    return { solve, ffCurve, bracket, onChart, model, pas, charts, gwMin, gwMax, isaTemp, gsOf, tab, tabInv };
  }

  // ---------- utilidades de voo ----------
  function windComponents(windFrom, windKt, course) {
    // vento "de" windFrom; positivo = de proa
    const rel = ((windFrom - course) * Math.PI) / 180;
    return { hw: windKt * Math.cos(rel), xw: windKt * Math.sin(rel) };
  }

  function pressureAltitude(alt, qnh) {
    const q = qnh >= 800 && qnh <= 1100 ? qnh : 1013.25;
    return alt + (1013.25 - q) * 30;
  }

  const api = { create, windComponents, pressureAltitude, KG_TO_LB, IBF_FACTOR, ISA_LAPSE, isaTemp };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AW139Fuel = api;
})(typeof window !== 'undefined' ? window : globalThis);
