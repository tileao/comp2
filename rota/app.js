/* Plano de rota (teste) — AW139 Companion. Página oculta: sem link na Home.
 * Rota digitada como no FMS → pernas → vento e temperatura previstos por nível (Open-Meteo)
 * → consumo pelas cartas Cruise AEO do RFM (motor do fluxo Combustível) → melhor nível na ida e na volta.
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const F = window.AW139Fuel;
  const R = window.AW139Route;
  const E = F.create(window.AW139_CRUISE);
  const nav = R.createNav(window.AW139_NAV);
  const KG_TO_LB = F.KG_TO_LB;
  const STORE = 'aw139_rota_v1';
  const FUEL_STORE = 'aw139_fuel_v1';
  const WIND_STORE = 'aw139_rota_wind_v1';
  const WIND_FRESH_MS = 30 * 60e3; // mesma consulta em até 30 min: usa a resposta guardada
  const DECK_LB_MIN = 9; // OM-B I01 R00, 0.21 (p.43): consumo no solo (MPOG) em FLIGHT
  // RFM Seção 9, Tabela 9-1 — mesmos ids do fluxo Combustível
  const EQ_CF = { eq1: 0.3, eq2: 0.3, eq3: 0.3, eq4: 0.3, eq5: 0.2, eq6: 0.4, eq7: 0.4, eq8: 0.5 };
  const FIELDS = ['rtOut', 'rtBack', 'dep', 'deck', 'fuel', 'weight', 'weightBack', 'reserve', 'qnh'];
  const SELECTS = ['unit', 'reserveMode', 'speed', 'levels'];
  const NUMERIC = ['dep', 'deck', 'fuel', 'weight', 'weightBack', 'reserve', 'qnh'];
  const state = { last: null, tab: 'niveis', busy: false };

  // ---------- entrada ----------
  function num(id) {
    const s = String($(id).value || '').replace(',', '.').trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  function unit() { return $('unit').value === 'kg' ? 'kg' : 'lb'; }
  function toKg(v) { return v == null ? null : (unit() === 'lb' ? v / KG_TO_LB : v); }
  function sanitize(el) {
    const max = Number(el.getAttribute('maxlength')) || 6;
    el.value = String(el.value || '').replace(/[^0-9]/g, '').slice(0, max);
  }

  // ---------- formatação ----------
  const r0 = (v) => Math.round(v);
  const pad = (v, n) => String(v).padStart(n, '0');
  function conv(kg) { return unit() === 'lb' ? kg * KG_TO_LB : kg; }
  function qty(kg, withOther) {
    if (kg == null) return '—';
    const main = `${r0(conv(kg))} ${unit()}`;
    if (!withOther) return main;
    return main + (unit() === 'lb' ? ` (${r0(kg)} kg)` : ` (${r0(kg * KG_TO_LB)} lb)`);
  }
  function rate(kgph) { return `${r0(conv(kgph))}&nbsp;${unit()}/h`; }
  function hm(h) {
    if (!(h > 0)) return '0h00';
    const m = Math.round(h * 60);
    return `${Math.floor(m / 60)}h${pad(m % 60, 2)}`;
  }
  function fmtZ(ms) {
    const d = new Date(ms);
    return `${pad(d.getUTCDate(), 2)}/${pad(d.getUTCMonth() + 1, 2)} ${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}Z`;
  }
  function hhmmZ(ms) { const d = new Date(ms); return `${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}Z`; }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
  function hwTxt(hw) {
    if (Math.abs(hw) < 0.5) return 'sem componente de proa';
    return `${hw > 0 ? 'proa' : 'cauda'} ${r0(Math.abs(hw))} kt`;
  }
  function windStr(w) {
    if (!w || w.spd < 0.5) return 'calmo';
    const d = r0(w.dir) % 360;
    return `${pad(d === 0 ? 360 : d, 3)}/${r0(w.spd)}`;
  }
  const sumDist = (legs) => legs.reduce((a, l) => a + l.dist, 0);

  // ---------- configuração do fluxo Combustível ----------
  function fuelStore() {
    try { return JSON.parse(localStorage.getItem(FUEL_STORE) || 'null'); } catch (_) { return null; }
  }
  function fuelConfig() {
    const d = fuelStore();
    const ibf = !!(d && d.ibf === '1');
    const cf = d && Array.isArray(d.eq) ? d.eq.reduce((s, id) => s + (EQ_CF[id] || 0), 0) : 0;
    return { ibf, cf };
  }
  function cfgTxt(c) {
    const parts = [];
    if (c.ibf) parts.push('IBF (+3,5 %)');
    if (c.cf) parts.push(`equipamento externo CF ${c.cf.toFixed(1).replace('.', ',')}`);
    return parts.length ? parts.join(', ') : 'entrada de ar padrão, sem equipamento externo';
  }

  // ---------- horário ----------
  // HHMM em UTC; vazio = agora. Hora que já passou há mais de 3 h vira amanhã.
  function depTime() {
    const s = String($('dep').value || '').replace(/\D/g, '');
    const now = Date.now();
    if (!s) return { t: Math.floor(now / 60e3) * 60e3, auto: true };
    if (s.length !== 4) return null;
    const hh = +s.slice(0, 2), mm = +s.slice(2);
    if (hh > 23 || mm > 59) return null;
    const d = new Date(now);
    let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm);
    if (t < now - 3 * 3600e3) t += 864e5;
    return { t, auto: false };
  }
  function updateDepInfo() {
    const d = depTime();
    const deck = num('deck');
    if (!d) { $('depInfo').innerHTML = '<span class="ri-err">Decolagem em HHMM (UTC), por exemplo 0930.</span>'; return; }
    let txt = `Decolagem ${d.auto ? 'agora, ' : ''}${fmtZ(d.t)}.`;
    if (deck) txt += ` Na UM com rotor girando: ${DECK_LB_MIN} lb/min em FLIGHT (OM-B 0.21).`;
    $('depInfo').textContent = txt;
  }

  // ---------- rota ----------
  function parseBoth() {
    const tOut = $('rtOut').value.trim(), tBack = $('rtBack').value.trim();
    const ida = tOut ? R.parseRoute(nav, tOut) : null;
    let volta = null, reversed = false;
    if (tBack) volta = R.parseRoute(nav, tBack);
    else if (ida && !ida.errors.length) { volta = R.reverseRoute(ida); reversed = true; }
    return { ida, volta, reversed };
  }
  function routeSummary(r, legs) {
    const a = r.pts[0].id, b = r.pts[r.pts.length - 1].id;
    return `${a} → ${b} · ${r0(sumDist(legs))} NM${r.airways.length ? ' · ' + r.airways.join(', ') : ''}`;
  }
  function reverseWarn(p) {
    return p.reversed && p.ida && p.ida.airways.length
      ? 'Aerovia da Bacia de Santos é de mão única: a volta pelo inverso da ida é só aproximação. Digite a volta.' : '';
  }
  function updateRouteInfo() {
    const p = parseBoth();
    const lines = [];
    const line = (name, r) => {
      if (!r) return;
      if (r.errors.length) lines.push(`<span class="ri-err">${name}: ${esc(r.errors[0])}</span>`);
      else lines.push(`${name}: ${esc(routeSummary(r, R.buildLegs(r.pts)))}`);
    };
    line('Ida', p.ida);
    line(p.reversed ? 'Volta (inverso)' : 'Volta', p.volta);
    const w = reverseWarn(p);
    if (w) lines.push(`<span class="ri-warn">${w}</span>`);
    $('routeInfo').innerHTML = lines.join('<br>');
  }

  // ---------- vento ----------
  async function getWind(url) {
    let cache = null;
    try { cache = JSON.parse(localStorage.getItem(WIND_STORE) || 'null'); } catch (_) {}
    const same = cache && cache.url === url;
    if (same && Date.now() - cache.at < WIND_FRESH_MS) return { json: cache.json, at: cache.at, cached: true };
    let res, json;
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 15000);
      res = await fetch(url, { signal: ctl.signal });
      clearTimeout(to);
      json = await res.json().catch(() => null);
    } catch (e) {
      if (same) return { json: cache.json, at: cache.at, cached: true, offline: true };
      throw new Error(e && e.name === 'AbortError' ? 'O serviço de vento não respondeu em 15 s.' : 'Sem conexão com o serviço de vento.');
    }
    if (!res.ok) {
      if (same) return { json: cache.json, at: cache.at, cached: true, offline: true };
      throw new Error(res.status === 429 ? 'O serviço de vento recusou por excesso de consultas (429). Tente de novo em alguns minutos.'
        : `Serviço de vento: ${json && json.reason ? json.reason : 'erro ' + res.status}.`);
    }
    const at = Date.now();
    try { localStorage.setItem(WIND_STORE, JSON.stringify({ url, at, json })); } catch (_) {}
    return { json, at, cached: false };
  }

  // ---------- cálculo ----------
  function readInputs() {
    return {
      deckMin: num('deck') || 0,
      gwKg: toKg(num('weight')),
      gwBackKg: toKg(num('weightBack')),
      fuelKg: toKg(num('fuel')),
      reserveMode: $('reserveMode').value,
      reserveKg: toKg(num('reserve')),
      speed: $('speed').value,
      levels: $('levels').value,
      qnh: num('qnh'),
    };
  }

  async function run() {
    if (state.busy) return;
    updateRouteInfo();
    updateDepInfo();
    const inp = readInputs();
    const p = parseBoth();
    const errs = [];
    if (!p.ida) errs.push('Digite a rota de ida.');
    else if (p.ida.errors.length) errs.push(...p.ida.errors.map((e) => 'Ida: ' + e));
    if (p.volta && p.volta.errors.length) errs.push(...p.volta.errors.map((e) => 'Volta: ' + e));
    const dep = depTime();
    if (!dep) errs.push('Decolagem em HHMM (UTC).');
    if (inp.gwKg == null) errs.push('Falta o peso na ida (em Peso e combustível).');
    if (inp.fuelKg == null) errs.push('Falta o combustível (em Peso e combustível).');
    if (inp.reserveMode === 'manual' && inp.reserveKg == null) errs.push('Falta a reserva.');
    if (errs.length) {
      if (inp.gwKg == null || inp.fuelKg == null) $('acBox').open = true;
      showError(errs);
      return;
    }
    const legsI = R.buildLegs(p.ida.pts), legsV = R.buildLegs(p.volta.pts);
    if (!legsI.length || !legsV.length) { showError(['Rota sem distância entre os pontos.']); return; }

    // pontos de vento: amostras das duas rotas, agrupadas a cada 0,1°
    const pts = [], key = {};
    const idxOf = (legs) => legs.map((l) => l.samples.map((s) => {
      const k = `${s.lat.toFixed(1)},${s.lon.toFixed(1)}`;
      if (!(k in key)) { key[k] = pts.length; pts.push({ lat: +s.lat.toFixed(1), lon: +s.lon.toFixed(1) }); }
      return key[k];
    }));
    const idxI = idxOf(legsI), idxV = idxOf(legsV);
    const nmI = sumDist(legsI), nmV = sumDist(legsV);
    const spanH = (nmI + nmV) / 70 + inp.deckMin / 60 + 1; // folga para vento de proa forte
    const url = R.windUrl(pts, dep.t, dep.t + spanH * 3600e3);
    save();

    setBusy(true);
    let wind, fields;
    try {
      wind = await getWind(url);
      fields = R.parseWind(wind.json, pts.length);
    } catch (e) {
      setBusy(false);
      showError([e.message || String(e)]);
      return;
    }
    setBusy(false);

    const cfg = fuelConfig();
    const santos = p.ida.santos || p.volta.santos;
    const mode = inp.levels === 'auto' ? (santos ? 'circea' : 'livre') : inp.levels;
    const lvI = R.levelsFor(mode, 'ida', nav, inp.qnh), lvV = R.levelsFor(mode, 'volta', nav, inp.qnh);
    const base = { cf: cfg.cf, ibf: cfg.ibf, speed: inp.speed };
    const pI = R.planDirection(E, legsI, fields, idxI, lvI, { ...base, gwKg: inp.gwKg, t0: dep.t });
    const tV = dep.t + (pI.best ? pI.best.time : nmI / 140) * 3600e3 + inp.deckMin * 60e3;
    const gwV = inp.gwBackKg != null ? inp.gwBackKg : inp.gwKg;
    const pV = R.planDirection(E, legsV, fields, idxV, lvV, { ...base, gwKg: gwV, t0: tV });

    // reserva: 30 min a 150 KTAS no nível da volta (mesma regra do fluxo Combustível)
    let reserveKg = 0, reserveTxt = 'sem reserva';
    if (inp.reserveMode === 'r30') {
      const ref = pV.best || pI.best;
      const last = ref && ref.legs[ref.legs.length - 1];
      const r = last ? E.solve({ pa: ref.lv.pa, oat: last.oat, gwKg: gwV, hw: 0, xw: 0, cf: cfg.cf, ibf: cfg.ibf, tas: 150 }) : null;
      const q = r && !r.err ? [r.fix, r.rec, r.rng].find((x) => x && !x.out) : null;
      if (q) { reserveKg = q.ff * 0.5; reserveTxt = `30 min a ${r0(q.tas)} KTAS no ${ref.lv.label}`; } else reserveTxt = 'reserva não calculada';
    } else if (inp.reserveMode === 'manual') {
      reserveKg = inp.reserveKg;
      reserveTxt = 'valor informado';
    }
    const deckKg = (inp.deckMin * DECK_LB_MIN) / KG_TO_LB;
    state.last = { inp, p, legsI, legsV, dep, tV, gwV, wind, cfg, mode, pI, pV, reserveKg, reserveTxt, deckKg, nPts: pts.length };
    render();
  }

  // ---------- resultado ----------
  function meanWind(row) {
    let u = 0, v = 0, d = 0;
    for (const l of row.legs) {
      const a = (l.wind.dir * Math.PI) / 180;
      u += -l.wind.spd * Math.sin(a) * l.leg.dist;
      v += -l.wind.spd * Math.cos(a) * l.leg.dist;
      d += l.leg.dist;
    }
    return R.windToDirSpd(u / d, v / d);
  }
  function oatAvg(row) { return row.legs.reduce((a, l) => a + l.oat * l.leg.dist, 0) / row.dist; }
  function speedTxt(row, mode) {
    const ias = row.legs.map((l) => l.p.ias).filter((x) => x != null).map(r0);
    const tag = row.legs.find((l) => l.p.tag) ? row.legs.find((l) => l.p.tag).p.tag : null;
    let txt;
    if (!ias.length) txt = mode === 'tas150' ? '150 KTAS' : `${r0(row.legs[0].p.tas)} KTAS`;
    else {
      const lo = Math.min(...ias), hi = Math.max(...ias);
      txt = lo === hi ? `${lo} KIAS` : `${lo}–${hi} KIAS`;
      if (mode === 'tas150') txt = `150 KTAS (${txt})`;
    }
    return txt + (tag ? ` <span class="flag">Limitado pela ${tag}</span>` : '');
  }

  function card(k, title, r, plan, mode) {
    const last = r.pts[r.pts.length - 1].id;
    $('lbl' + k).textContent = `${title} · ${r.pts[0].id} → ${last}`;
    const row = plan.best;
    const box = $('box' + k);
    if (!row) {
      box.classList.add('muted');
      $('val' + k).textContent = '—';
      $('main' + k).textContent = 'Sem solução nas cartas';
      const err = plan.rows.find((x) => x.err);
      $('sub' + k).textContent = err ? err.err : '';
      return;
    }
    box.classList.remove('muted');
    $('val' + k).textContent = row.lv.label;
    $('main' + k).textContent = `${qty(row.fuel)} · ${hm(row.time)}`;
    const gs = row.dist / row.time;
    const near = plan.near.length ? `<span class="near">Até +1 %: ${plan.near.join(', ')}</span>` : '';
    $('sub' + k).innerHTML = `GS&nbsp;${r0(gs)} · ${hwTxt(row.hwAvg)} (média)<br>${speedTxt(row, mode)} · ${rate(row.fuel / row.time)}${near}`;
  }

  function render() {
    const s = state.last;
    if (!s) return;
    const { p, pI, pV } = s;
    $('resultCard').classList.remove('pending');
    card('Ida', 'Ida', p.ida, pI, s.inp.speed);
    card('Volta', p.reversed ? 'Volta (inverso)' : 'Volta', p.volta, pV, s.inp.speed);

    const chip = $('statusChip');
    const band = $('totBand');
    const warn = reverseWarn(p);
    const warnHtml = (warn ? `<span class="warn-line">${warn}</span>` : '') +
      (s.wind.offline ? `<span class="warn-line">Sem conexão: vento guardado de ${fmtZ(s.wind.at)}.</span>` : '');
    if (!pI.best || !pV.best) {
      chip.textContent = 'Verifique';
      chip.className = 'status-chip bad';
      band.className = 'result-band bad';
      band.innerHTML = `<span class="err-line">Sem solução nas cartas em ${!pI.best ? 'nenhum nível da ida' : 'nenhum nível da volta'}.</span>${warnHtml}`;
    } else {
      const trip = pI.best.fuel + pV.best.fuel + s.deckKg;
      const usable = s.inp.fuelKg - s.reserveKg;
      const left = usable - trip;
      chip.textContent = left >= 0 ? 'Calculado' : 'Abaixo da reserva';
      chip.className = 'status-chip ' + (left >= 0 ? 'ok' : 'bad');
      band.className = 'result-band' + (left < 0 ? ' bad' : '');
      const deck = s.inp.deckMin ? ` (com ${r0(s.inp.deckMin)} min na UM: ${qty(s.deckKg)})` : '';
      band.innerHTML = `<strong>Ida e volta:</strong> ${qty(trip, true)}${deck} · ${hm(pI.best.time + pV.best.time)} de voo.<br>` +
        (left >= 0 ? `Sobra <b>${qty(left)}</b> acima da reserva` : `Faltam <b>${qty(-left)}</b> para manter a reserva`) +
        ` (${qty(s.reserveKg)}, ${s.reserveTxt}).` + warnHtml;
    }

    const src = s.wind.cached ? `guardado de ${fmtZ(s.wind.at)}` : `obtido às ${hhmmZ(s.wind.at)}`;
    const lvTxt = s.mode === 'circea' ? 'níveis da CIRCEA 100-109 (2.4.3)' : `altitudes com QNH ${s.inp.qnh != null ? r0(s.inp.qnh) : 1013} hPa`;
    const wTxt = s.inp.gwBackKg != null ? `${qty(s.inp.gwKg)} na ida e ${qty(s.gwV)} na volta` : `${qty(s.inp.gwKg)} nas duas pernas`;
    $('resFoot').innerHTML =
      `Volta calculada a partir de ${hhmmZ(s.tV)}. Vento e temperatura: previsão de modelo (Open-Meteo), ${src}, ${s.nPts} pontos da rota. <b>Não é produto oficial</b>: confira o vento em altitude na REDEMET.<br>` +
      `Consumo: RFM Seção 9, cartas Cruise AEO, com o vento e a OAT de cada perna; ${wTxt}; ${cfgTxt(s.cfg)}; ${lvTxt}. ` +
      'Não inclui partida e táxi, subida e descida, alternativa nem contingência (OM-A 11.1.7).';
    renderLevels();
    renderLegs();
  }

  function lvTable(title, cls, r, legs, plan) {
    let h = `<div class="dir-wrap ${cls}"><div class="dir-head ${cls}">${title}<small>${esc(routeSummary(r, legs))}</small></div>`;
    h += `<div class="table-wrap"><table class="fuel-table"><thead><tr><th>Nível</th><th>Vento</th><th>Proa kt</th><th>OAT</th><th>GS</th><th>Tempo</th><th>${unit()}</th></tr></thead><tbody>`;
    for (const row of plan.rows) {
      if (!row.ok) { h += `<tr><td>${esc(row.lv.label)}</td><td class="na" colspan="6">${esc(row.err)}</td></tr>`; continue; }
      const best = row === plan.best;
      const tag = best ? '<span class="tag">MELHOR</span>' : plan.near.includes(row.lv.label) ? '<span class="near-tag">+1 %</span>' : '';
      h += `<tr${best ? ' class="best"' : ''}><td>${esc(row.lv.label)}${tag}</td><td>${windStr(meanWind(row))}</td><td>${r0(row.hwAvg)}</td>` +
        `<td>${r0(oatAvg(row))}°</td><td>${r0(row.dist / row.time)}</td><td>${hm(row.time)}</td><td${best ? ' class="best-r"' : ''}>${r0(conv(row.fuel))}</td></tr>`;
    }
    return h + '</tbody></table></div></div>';
  }

  function renderLevels() {
    const s = state.last;
    if (!s) return;
    $('lvOut').innerHTML = lvTable('Ida', 'ida', s.p.ida, s.legsI, s.pI) +
      lvTable(s.p.reversed ? 'Volta (inverso)' : 'Volta', 'volta', s.p.volta, s.legsV, s.pV) +
      '<p class="source-line">Vento: média da rota no nível (vetorial, ponderada pela distância). Proa negativa = cauda. Tempo e combustível em cruzeiro, sem subida e descida. +1 %: até 1 % a mais que o melhor.</p>';
  }

  function legTable(title, cls, plan) {
    const row = plan.best;
    if (!row) return `<div class="dir-wrap ${cls}"><div class="dir-head ${cls}">${title}</div><p class="err-line">Sem solução nas cartas.</p></div>`;
    let h = `<div class="dir-wrap ${cls}"><div class="dir-head ${cls}">${title} · ${esc(row.lv.label)}</div>`;
    h += `<div class="table-wrap"><table class="fuel-table"><thead><tr><th>Perna</th><th>NM</th><th>Rumo V</th><th>Vento</th><th>Proa</th><th>GS</th><th>Min</th><th>${unit()}</th></tr></thead><tbody>`;
    for (const l of row.legs) {
      h += `<tr><td>${esc(l.leg.from.id)}–${esc(l.leg.to.id)}</td><td>${l.leg.dist.toFixed(1).replace('.', ',')}</td><td>${pad(r0(l.leg.crs) % 360 || 360, 3)}°</td>` +
        `<td>${windStr(l.wind)}</td><td>${r0(l.hw)}</td><td>${r0(l.p.gs)}</td><td>${r0(l.hrs * 60)}</td><td>${r0(conv(l.fuel))}</td></tr>`;
    }
    h += `<tr class="sum"><td>Total</td><td>${r0(row.dist)}</td><td></td><td></td><td>${r0(row.hwAvg)}</td><td>${r0(row.dist / row.time)}</td><td>${r0(row.time * 60)}</td><td>${r0(conv(row.fuel))}</td></tr>`;
    return h + '</tbody></table></div></div>';
  }

  function renderLegs() {
    const s = state.last;
    if (!s) return;
    $('legOut').innerHTML = legTable('Ida', 'ida', s.pI) + legTable(s.p.reversed ? 'Volta (inverso)' : 'Volta', 'volta', s.pV) +
      '<p class="source-line">No melhor nível. Rumo verdadeiro no meio da perna; vento previsto no nível, médio nos pontos da perna. Proa negativa = cauda.</p>';
  }

  function resetResult(chipTxt, chipCls) {
    $('resultCard').classList.add('pending');
    $('statusChip').textContent = chipTxt;
    $('statusChip').className = 'status-chip ' + chipCls;
    for (const k of ['Ida', 'Volta']) {
      $('box' + k).classList.remove('muted');
      $('lbl' + k).textContent = k;
      $('val' + k).textContent = '—';
      $('main' + k).textContent = '';
      $('sub' + k).innerHTML = '';
    }
    $('totBand').className = 'result-band';
    $('totBand').textContent = '—';
    $('resFoot').innerHTML = '';
    $('lvOut').innerHTML = '<p class="source-line">Digite a rota e toque em Buscar vento e calcular.</p>';
    $('legOut').innerHTML = '<p class="source-line">As pernas aparecem depois do cálculo.</p>';
  }

  function showError(errs) {
    state.last = null;
    resetResult('Verifique', 'bad');
    $('resultCard').classList.remove('pending');
    $('totBand').className = 'result-band bad';
    $('totBand').innerHTML = errs.map((e) => `<span class="err-line">${esc(e)}</span>`).join('<br>');
  }

  function setBusy(b) {
    state.busy = b;
    const btn = $('runBtn');
    btn.disabled = b;
    btn.textContent = b ? 'Buscando vento…' : 'Buscar vento e calcular';
    if (b) { $('statusChip').textContent = 'Buscando vento'; $('statusChip').className = 'status-chip warn'; }
  }

  // ---------- estado salvo ----------
  function save() {
    const d = {};
    for (const id of FIELDS) d[id] = $(id).value;
    for (const id of SELECTS) d[id] = $(id).value;
    try { localStorage.setItem(STORE, JSON.stringify(d)); } catch (_) {}
  }
  function restore() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (_) {}
    if (!d) {
      // primeira vez: peso, combustível e reserva do fluxo Combustível
      const f = fuelStore();
      if (f) d = { unit: f.unit, weight: f.weight, fuel: f.fuel, reserveMode: f.reserveMode, reserve: f.reserve, qnh: f.qnh };
    }
    if (!d) return;
    for (const id of SELECTS) if (d[id] != null && [...$(id).options].some((o) => o.value === d[id])) $(id).value = d[id];
    for (const id of FIELDS) if (d[id] != null) $(id).value = d[id];
  }
  function clearAll() {
    try { localStorage.removeItem(STORE); } catch (_) {}
    for (const id of FIELDS) $(id).value = '';
    $('reserveMode').value = 'r30';
    $('speed').value = 'rng';
    $('levels').value = 'auto';
    state.last = null;
    resetResult('Aguardando', 'warn');
    syncUi();
    updateRouteInfo();
  }

  // ---------- interface ----------
  function syncUi() {
    const u = unit();
    $('weightLabel').textContent = `Peso na ida (${u})`;
    $('weightBackLabel').textContent = `Peso na volta (${u})`;
    $('fuelLabel').textContent = `Combustível (${u})`;
    $('reserveLabel').textContent = `Reserva (${u})`;
    $('weight').placeholder = u === 'lb' ? '13500' : '6100';
    $('fuel').placeholder = u === 'lb' ? '2400' : '1090';
    $('reserve').placeholder = u === 'lb' ? '493' : '224';
    $('reserveField').hidden = $('reserveMode').value !== 'manual';
    $('qnhField').hidden = $('levels').value === 'circea';
    const w = num('weight'), f = num('fuel');
    $('acBadge').textContent = w == null && f == null ? ' · preencher' : ` · ${w != null ? w : '—'} · ${f != null ? f : '—'} ${u}`;
    const lv = { auto: 'automático', circea: 'CIRCEA', livre: '1000–8000 ft' }[$('levels').value];
    $('optBadge').textContent = ` · ${$('speed').value === 'tas150' ? '150 KTAS' : 'best range'} · ${lv}`;
    $('cfgInfo').textContent = `Configuração do fluxo Combustível: ${cfgTxt(fuelConfig())}.`;
    updateDepInfo();
  }

  function convertUnits(from, to) {
    if (from === to) return;
    const f = from === 'lb' ? 1 / KG_TO_LB : KG_TO_LB;
    for (const id of ['weight', 'weightBack', 'fuel', 'reserve']) {
      const v = num(id);
      if (v != null) $(id).value = String(r0(v * f));
    }
  }

  function showTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.viewer-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    for (const t of ['niveis', 'pernas']) $('tab-' + t).hidden = t !== tab;
    $('vizTitle').textContent = tab === 'niveis' ? 'Comparação por nível' : 'Pernas no melhor nível';
  }

  function init() {
    restore();
    let lastUnit = unit();
    $('unit').addEventListener('change', () => { convertUnits(lastUnit, unit()); lastUnit = unit(); syncUi(); if (state.last) render(); });
    for (const id of ['reserveMode', 'speed', 'levels']) $(id).addEventListener('change', syncUi);
    for (const id of NUMERIC) $(id).addEventListener('input', () => { sanitize($(id)); syncUi(); });
    let rt = null;
    for (const id of ['rtOut', 'rtBack']) $(id).addEventListener('input', () => { clearTimeout(rt); rt = setTimeout(updateRouteInfo, 200); });
    const order = ['rtOut', 'rtBack', 'dep', 'deck'];
    order.forEach((id, i) => {
      $(id).addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        if (i < order.length - 1) $(order[i + 1]).focus(); else { $(id).blur(); run(); }
      });
    });
    $('runBtn').addEventListener('click', run);
    $('resetBtn').addEventListener('click', clearAll);
    document.querySelectorAll('.viewer-tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
    syncUi();
    updateRouteInfo();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
