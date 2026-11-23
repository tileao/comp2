/* Fluxo Combustível — AW139 Companion.
 * Consumo em kg e lb, best range, best endurance, sugestão de altitude e rota ida/volta com vento.
 * Cálculo: engine.js sobre as cartas Cruise AEO do RFM (Seção 9).
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const F = window.AW139Fuel;
  const E = F.create(window.AW139_CRUISE);
  const KG_TO_LB = F.KG_TO_LB;
  const STORE = 'aw139_fuel_v1';
  const ROUTE_ALTS = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
  const SCAN_ALTS = [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];
  const MIN_GAIN = 0.02; // abaixo de 2 % não vale sugerir mudança de altitude
  // RFM Seção 9, Tabela 9-1 (fator de correção × DTQ da carta)
  const EQUIP = [
    { id: 'eq1', cf: 0.3, label: 'Farol de busca (SX16, SX5, Nightsun II XP ou Trakkabeam A800)' },
    { id: 'eq2', cf: 0.3, label: 'Radar Telephonics 1500B+ e FLIR Star Safire' },
    { id: 'eq3', cf: 0.3, label: 'FLIR (Sea FLIR II, Star Safire, Wescam MX-15, Talon ou Ultraforce 350)' },
    { id: 'eq4', cf: 0.3, label: 'Radar Gabbiano T20N e FLIR Ultraforce 350' },
    { id: 'eq5', cf: 0.2, label: 'Guincho Goodrich recolhido', group: 'hoist' },
    { id: 'eq6', cf: 0.4, label: 'Guincho Goodrich fora da posição recolhida', group: 'hoist' },
    { id: 'eq7', cf: 0.4, label: 'Guincho Breeze', group: 'hoist' },
    { id: 'eq8', cf: 0.5, label: 'Snow skids ou slump pads' },
  ];
  const FIELDS = ['alt', 'qnh', 'oat', 'weight', 'fuel', 'reserve', 'ias', 'hw'];
  const SELECTS = ['unit', 'reserveMode', 'ibf', 'ceiling', 'speedMode'];
  const state = { last: null, route: null, tab: 'curva' };

  // ---------- entrada ----------
  function num(id) {
    const el = $(id);
    if (!el) return null;
    const s = String(el.value || '').replace(',', '.').trim();
    if (!s || s === '-') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  function unit() { return $('unit').value === 'kg' ? 'kg' : 'lb'; }
  function toKg(v) { return v == null ? null : (unit() === 'lb' ? v / KG_TO_LB : v); }
  function cfTotal() { return EQUIP.reduce((s, e) => s + ($(e.id).checked ? e.cf : 0), 0); }

  function sanitize(el, allowNeg) {
    const raw = String(el.value || '').trim();
    const neg = allowNeg && raw.startsWith('-') ? '-' : '';
    const digits = raw.replace(/[^0-9]/g, '');
    const max = Number(el.getAttribute('maxlength')) || 6;
    el.value = neg + digits.slice(0, max);
  }
  function toggleSign(el) {
    const raw = String(el.value || '').trim();
    const digits = raw.replace(/[^0-9]/g, '');
    el.value = (raw.startsWith('-') ? '' : '-') + digits;
    el.focus();
    try { el.setSelectionRange(el.value.length, el.value.length); } catch (_) {}
    updateCalcBand();
  }

  // ---------- formatação ----------
  const r0 = (v) => Math.round(v);
  function qty(kg, withOther) {
    if (kg == null) return '—';
    const lb = kg * KG_TO_LB;
    const main = unit() === 'lb' ? `${r0(lb)} lb` : `${r0(kg)} kg`;
    if (!withOther) return main;
    return main + (unit() === 'lb' ? ` (${r0(kg)} kg)` : ` (${r0(lb)} lb)`);
  }
  function rate(kgph) {
    const lb = r0(kgph * KG_TO_LB), kg = r0(kgph);
    return unit() === 'lb' ? `${lb}&nbsp;lb/h · ${kg}&nbsp;kg/h` : `${kg}&nbsp;kg/h · ${lb}&nbsp;lb/h`;
  }
  function hm(h) {
    if (!(h > 0)) return '0h00';
    const m = Math.round(h * 60);
    return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
  }
  function signed(v, unitTxt) { return `${v >= 0 ? '+' : '−'}${Math.abs(v)}${unitTxt || ''}`; }
  function speedTxt(p) { return p.ias != null ? `${r0(p.ias)}<small>KIAS</small>` : `${r0(p.tas)}<small>KTAS</small>`; }
  function limTxt(tag) { return tag ? `<span class="flag">Limitado pela ${tag}</span>` : ''; }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

  // ---------- cálculo ----------
  function readInputs() {
    return {
      unit: unit(),
      alt: num('alt'),
      qnh: num('qnh'),
      oat: num('oat'),
      gwKg: toKg(num('weight')),
      fuelKg: toKg(num('fuel')),
      reserveMode: $('reserveMode').value,
      reserveKg: toKg(num('reserve')),
      ias: num('ias'),
      hw: num('hw') || 0,
      ibf: $('ibf').value === '1',
      cf: cfTotal(),
    };
  }

  function missing(inp) {
    const m = [];
    if (inp.alt == null) m.push('altitude');
    if (inp.oat == null) m.push('OAT');
    if (inp.gwKg == null) m.push('peso');
    if (inp.fuelKg == null) m.push('combustível');
    if (inp.reserveMode === 'manual' && inp.reserveKg == null) m.push('reserva');
    return m;
  }

  function paOf(inp, alt) { return F.pressureAltitude(alt == null ? inp.alt : alt, inp.qnh); }

  function calc() {
    const inp = readInputs();
    const miss = missing(inp);
    if (miss.length) { state.last = null; showError(`Falta: ${miss.join(', ')}.`); renderAltitudes(); drawCurve(); return; }
    const pa = paOf(inp);
    const base = { pa, oat: inp.oat, gwKg: inp.gwKg, hw: inp.hw, xw: 0, cf: inp.cf, ibf: inp.ibf };
    const r = E.solve({ ...base, ias: inp.ias, tas: 150 });
    if (r.err) { state.last = null; showError(r.err); renderAltitudes(); drawCurve(); return; }

    let reserveKg = 0, reserveTxt = 'sem reserva';
    if (inp.reserveMode === 'r30') {
      const p = [r.fix, r.rec, r.rng].find((x) => x && !x.out);
      reserveKg = p.ff * 0.5;
      reserveTxt = `30 min a ${r0(p.tas)} KTAS`;
    } else if (inp.reserveMode === 'manual') {
      reserveKg = inp.reserveKg;
      reserveTxt = 'valor informado';
    }
    const usableKg = inp.fuelKg - reserveKg;
    const scan = scanAltitudes(inp, base, r);
    state.last = { inp, pa, base, r, reserveKg, reserveTxt, usableKg, scan };
    save();
    render();
  }

  function scanAltitudes(inp, base, cur) {
    const dIsa = inp.oat - F.isaTemp(base.pa);
    const rows = SCAN_ALTS.filter((alt) => Math.abs(alt - inp.alt) >= 1).map((alt) => {
      const pa = paOf(inp, alt);
      const oat = F.isaTemp(pa) + dIsa;
      const r = E.solve({ ...base, pa, oat });
      return { alt, pa, oat, r, cur: false };
    });
    rows.push({ alt: inp.alt, pa: base.pa, oat: inp.oat, r: cur, cur: true });
    rows.sort((a, b) => a.alt - b.alt || (a.cur ? 1 : -1));
    return { rows, dIsa };
  }

  function bestOf(scan, ceiling) {
    const ok = scan.rows.filter((x) => !x.cur && !x.r.err && x.alt >= 1000 && x.alt <= ceiling);
    if (!ok.length) return null;
    const rng = ok.reduce((a, b) => (b.r.rng.sr > a.r.rng.sr ? b : a));
    const end = ok.reduce((a, b) => (b.r.end.ff < a.r.end.ff ? b : a));
    return { rng, end };
  }

  // ---------- resultado ----------
  function showError(msg) {
    $('resultCard').classList.remove('pending');
    const chip = $('statusChip');
    chip.textContent = 'Verifique';
    chip.className = 'status-chip bad';
    for (const k of ['Rng', 'End', 'Rec', 'Cur']) {
      $('val' + k).innerHTML = '—';
      $('sub' + k).innerHTML = '';
      $('box' + k).classList.add('muted');
    }
    $('mainRng').textContent = 'Alcance';
    $('mainEnd').textContent = 'Autonomia';
    $('mainRec').textContent = '';
    $('mainCur').textContent = 'Informe a IAS atual';
    $('altBand').innerHTML = `<span class="err-line">${esc(msg)}</span>`;
    $('resFoot').innerHTML = '';
  }

  function render() {
    const s = state.last;
    if (!s) return;
    const { r, usableKg } = s;
    $('resultCard').classList.remove('pending');
    const chip = $('statusChip');
    if (usableKg <= 0) {
      chip.textContent = 'Abaixo da reserva';
      chip.className = 'status-chip bad';
    } else {
      chip.textContent = 'Calculado';
      chip.className = 'status-chip ok';
    }
    const usable = Math.max(0, usableKg);
    const box = (k, p, main) => {
      const el = $('box' + k);
      if (!p || p.out) {
        el.classList.add('muted');
        $('val' + k).innerHTML = '—';
        $('main' + k).textContent = main || '';
        $('sub' + k).innerHTML = '';
        return;
      }
      el.classList.remove('muted');
      $('val' + k).innerHTML = speedTxt(p);
    };
    // Best range
    box('Rng', r.rng);
    const hR = usable / r.rng.ff;
    $('mainRng').textContent = `${r0(hR * r.rng.gs)} NM até a reserva`;
    $('subRng').innerHTML = `${rate(r.rng.ff)}<br>TAS&nbsp;${r0(r.rng.tas)} · GS&nbsp;${r0(r.rng.gs)} · TQ&nbsp;${r0(r.rng.tq)}&nbsp;% · ${hm(hR)}${limTxt(r.rng.tag)}`;
    // Best endurance
    box('End', r.end);
    const hE = usable / r.end.ff;
    $('mainEnd').textContent = `${hm(hE)} até a reserva`;
    $('subEnd').innerHTML = `${rate(r.end.ff)}<br>TAS&nbsp;${r0(r.end.tas)} · TQ&nbsp;${r0(r.end.tq)}&nbsp;% · ${r0(hE * r.end.gs)}&nbsp;NM${limTxt(r.end.tag)}`;
    // Recommended cruise
    if (r.rec && !r.rec.out) {
      box('Rec', r.rec);
      const h = usable / r.rec.ff;
      $('mainRec').textContent = `${r0(h * r.rec.gs)} NM · ${hm(h)}`;
      $('subRec').innerHTML = `${rate(r.rec.ff)}<br>TAS&nbsp;${r0(r.rec.tas)} · TQ&nbsp;${r0(r.rec.tq)}&nbsp;%${limTxt(r.rec.tag)}`;
    } else box('Rec', null, 'Fora da carta');
    // Agora
    if (s.inp.ias != null && r.cur && !r.cur.out) {
      box('Cur', r.cur);
      const h = usable / r.cur.ff;
      $('mainCur').textContent = `${hm(h)} · ${r0(h * r.cur.gs)} NM`;
      const exw = r.cur.extrap ? r.cur.extrap.reduce((a, x) => a + x.w, 0) : 0;
      const ex = !r.cur.extrap ? '' : exw >= 0.25
        ? `<span class="flag">Acima da MCP na carta de ${r.cur.extrap[0].oat} °C: curva prolongada</span>`
        : `<br><span class="note-inline">Carta de ${r.cur.extrap[0].oat} °C prolongada além da MCP (peso ${r0(exw * 100)} % na interpolação).</span>`;
      $('subCur').innerHTML = `${rate(r.cur.ff)}<br>TAS&nbsp;${r0(r.cur.tas)} · GS&nbsp;${r0(r.cur.gs)} · TQ&nbsp;${r0(r.cur.tq)}&nbsp;%${ex}`;
    } else if (s.inp.ias != null) {
      box('Cur', null, r.cur && r.cur.out === 'acima' ? 'IAS acima do limite da carta (VNE/MCP)' : 'IAS fora da escala da carta');
    } else box('Cur', null, 'Informe a IAS atual');

    renderSuggestion();
    const figs = r.charts.map((c) => `${c.fig} (p. ${c.pg})`).join(', ');
    const cfTxt = s.inp.cf ? ` · equipamento CF ${s.inp.cf.toFixed(1).replace('.', ',')}` : '';
    const ibfTxt = s.inp.ibf ? ' · IBF +3,5 %' : '';
    $('resFoot').innerHTML = `Utilizável <b>${qty(usable, true)}</b> · reserva ${qty(s.reserveKg)} (${s.reserveTxt})${cfTxt}${ibfTxt}<br>RFM Seção 9, Fig. ${figs}. Sem efeito do sangramento de ar (p. 9-2).`;
    renderAltitudes();
    drawCurve();
    if (state.route) computeRoute(true);
  }

  function renderSuggestion() {
    const s = state.last;
    const ceiling = Number($('ceiling').value) || 8000;
    const best = bestOf(s.scan, ceiling);
    const cur = s.r;
    const usable = Math.max(0, s.usableKg);
    const parts = [];
    if (!best) { $('altBand').textContent = 'Sem dados de altitude para comparar.'; return; }
    const gR = best.rng.r.rng.sr / cur.rng.sr - 1;
    const dNm = r0(usable * (best.rng.r.rng.sr - cur.rng.sr));
    const hEbest = usable / best.end.r.end.ff, hEcur = usable / cur.end.ff;
    const gE = hEbest / hEcur - 1;
    const dMin = r0((hEbest - hEcur) * 60);
    const verb = (alt) => (alt > s.inp.alt ? 'subir para' : 'descer para');
    if (gR >= MIN_GAIN && Math.abs(best.rng.alt - s.inp.alt) >= 500) {
      parts.push(`<strong>Best range:</strong> ${verb(best.rng.alt)} ${best.rng.alt} ft (+${r0(gR * 100)} % de alcance, ${signed(dNm, ' NM')}).`);
    } else {
      parts.push(`<strong>Best range:</strong> manter — a melhor altitude até ${ceiling} ft dá no máximo ${r0(Math.max(gR, 0) * 100)} % a mais.`);
    }
    if (gE >= MIN_GAIN && Math.abs(best.end.alt - s.inp.alt) >= 500) {
      parts.push(`<strong>Best endurance:</strong> ${verb(best.end.alt)} ${best.end.alt} ft (${signed(dMin, ' min')}).`);
    } else {
      parts.push(`<strong>Best endurance:</strong> manter — ganho máximo de ${Math.max(dMin, 0)} min até ${ceiling} ft.`);
    }
    const wind = s.inp.hw ? `vento de proa de ${s.inp.hw} kt em todas as altitudes` : 'sem vento';
    parts.push(`<span class="helper-inline">ISA ${signed(r0(s.scan.dIsa), ' °C')} constante, ${wind}. Não inclui o combustível de subida ou descida. Vento por altitude: aba Rota.</span>`);
    $('altBand').innerHTML = parts.join('<br>');
  }

  function renderAltitudes() {
    const s = state.last;
    const t = $('altTable');
    if (!s) { t.innerHTML = ''; $('altNote').textContent = ''; return; }
    const ceiling = Number($('ceiling').value) || 8000;
    const best = bestOf(s.scan, ceiling);
    const usable = Math.max(0, s.usableKg);
    const per = unit() === 'lb' ? 100 / KG_TO_LB : 100; // NM por 100 lb ou 100 kg
    let html = `<thead><tr><th>Alt ft</th><th>OAT</th><th>IAS BR</th><th>NM/100${unit()}</th><th>Alcance</th><th>Auton.</th></tr></thead><tbody>`;
    for (const row of s.scan.rows) {
      const r = row.r;
      const cls = row.cur ? ' class="cur"' : '';
      const altTxt = row.cur ? `${r0(row.alt)}<span class="tag">ATUAL</span>` : `${row.alt}`;
      if (r.err) {
        html += `<tr${cls}><td>${altTxt}</td><td>${r0(row.oat)}°</td><td class="na" colspan="4">fora da carta</td></tr>`;
        continue;
      }
      const isBR = best && !row.cur && row === best.rng;
      const isBE = best && !row.cur && row === best.end;
      const hE = usable / r.end.ff;
      const nm = usable * r.rng.sr;
      html += `<tr${cls}><td>${altTxt}</td><td>${r0(row.oat)}°</td><td>${r.rng.ias != null ? r0(r.rng.ias) : '—'}</td>` +
        `<td${isBR ? ' class="best-r"' : ''}>${(r.rng.sr * per).toFixed(1).replace('.', ',')}</td>` +
        `<td${isBR ? ' class="best-r"' : ''}>${r0(nm)} NM</td><td${isBE ? ' class="best-e"' : ''}>${hm(hE)}</td></tr>`;
    }
    t.innerHTML = html + '</tbody>';
    const wind = s.inp.hw ? `vento de proa de ${s.inp.hw} kt em todas as altitudes` : 'sem vento';
    $('altNote').innerHTML = `OAT pela variação padrão (ISA ${signed(r0(s.scan.dIsa), ' °C')} constante), ${wind}, peso atual. Alcance e autonomia até a reserva. Destaque: melhor de 1000 ft ao teto escolhido. Confira a altitude máxima operacional (RFM Seção 1, Fig. 1-6) e o espaço aéreo.`;
  }

  // ---------- gráfico consumo × TAS ----------
  function niceStep(span, target) {
    const raw = span / target;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / p;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
  }

  function drawCurve() {
    const cv = $('curveCanvas');
    if (!cv || state.tab !== 'curva') return;
    const w = Math.max(280, cv.clientWidth || cv.parentElement.clientWidth || 320);
    const h = Math.round(Math.min(w * 0.68, 460));
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.height = h + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0f1722';
    ctx.fillRect(0, 0, w, h);
    const s = state.last;
    const legend = $('curveLegend');
    if (!s) {
      ctx.fillStyle = '#9eb0c1';
      ctx.font = '14px Inter,-apple-system,Segoe UI,Roboto,sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Preencha os dados e toque em Calcular', w / 2, h / 2);
      legend.innerHTML = '';
      return;
    }
    const { inp, base, r } = s;
    const curve = E.ffCurve({ pa: base.pa, oat: base.oat, gwKg: base.gwKg, cf: base.cf, ibf: base.ibf }, 1);
    if (!curve || curve.pts.length < 3) return;
    const k = unit() === 'lb' ? KG_TO_LB : 1;
    const pts = curve.pts.map(([t, ff]) => [t, ff * k]);
    const xMax = Math.ceil((curve.t1 + 5) / 20) * 20;
    let yMin = Math.min(...pts.map((p) => p[1])), yMax = Math.max(...pts.map((p) => p[1]));
    const pad = (yMax - yMin) * 0.08;
    const yStep = niceStep(yMax - yMin + 2 * pad, 5);
    yMin = Math.floor((yMin - pad) / yStep) * yStep;
    yMax = Math.ceil((yMax + pad) / yStep) * yStep;
    const L = 46, R = 12, T = 14, B = 34;
    const X = (t) => L + (t / xMax) * (w - L - R);
    const Y = (v) => T + (1 - (v - yMin) / (yMax - yMin)) * (h - T - B);
    // grade
    ctx.font = '11px Inter,-apple-system,Segoe UI,Roboto,sans-serif';
    ctx.lineWidth = 1;
    for (let t = 0; t <= xMax; t += 20) {
      ctx.strokeStyle = 'rgba(255,255,255,.07)';
      ctx.beginPath(); ctx.moveTo(X(t) + 0.5, T); ctx.lineTo(X(t) + 0.5, h - B); ctx.stroke();
      ctx.fillStyle = '#8fa1b2'; ctx.textAlign = 'center';
      ctx.fillText(String(t), X(t), h - B + 15);
    }
    for (let v = yMin; v <= yMax + 1e-9; v += yStep) {
      ctx.strokeStyle = 'rgba(255,255,255,.07)';
      ctx.beginPath(); ctx.moveTo(L, Y(v) + 0.5); ctx.lineTo(w - R, Y(v) + 0.5); ctx.stroke();
      ctx.fillStyle = '#8fa1b2'; ctx.textAlign = 'right';
      ctx.fillText(String(Math.round(v)), L - 6, Y(v) + 4);
    }
    ctx.fillStyle = '#A9B8C8';
    ctx.textAlign = 'center';
    ctx.fillText('TAS (kt)', L + (w - L - R) / 2, h - 4);
    ctx.save();
    ctx.translate(11, T + (h - T - B) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(`Consumo (${unit()}/h)`, 0, 0);
    ctx.restore();
    // clip na área do gráfico
    ctx.save();
    ctx.beginPath(); ctx.rect(L, T, w - L - R, h - T - B); ctx.clip();
    // reta da origem (ou do vento de proa) ao best range
    const hw = inp.hw || 0;
    const pr = r.rng;
    if (pr && !pr.out && pr.tas - hw > 5) {
      const slope = (pr.ff * k) / (pr.tas - hw);
      ctx.strokeStyle = 'rgba(70,194,186,.55)';
      ctx.setLineDash([5, 5]);
      ctx.beginPath(); ctx.moveTo(X(hw), Y(0)); ctx.lineTo(X(xMax), Y(slope * (xMax - hw))); ctx.stroke();
      ctx.setLineDash([]);
    }
    // curva
    ctx.strokeStyle = '#e5eef7';
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach(([t, v], i) => (i ? ctx.lineTo(X(t), Y(v)) : ctx.moveTo(X(t), Y(v))));
    ctx.stroke();
    ctx.restore();
    // pontos
    const marks = [
      ['end', '#6fd89a', 'BE'],
      ['rng', '#46C2BA', 'BR'],
      ['rec', '#b39dfa', 'REC'],
      ['cur', '#D9A441', 'AGORA'],
    ];
    const items = [];
    const placed = [];
    ctx.font = '700 11px Inter,-apple-system,Segoe UI,Roboto,sans-serif';
    for (const [key, color, label] of marks) {
      const p = r[key];
      if (!p || p.out) continue;
      if (key === 'cur' && inp.ias == null) continue;
      const x = X(p.tas), y = Y(p.ff * k);
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#0f1722'; ctx.lineWidth = 1.5; ctx.stroke();
      // rótulo à esquerda do ponto (a curva sobe para a direita); desvia dos já colocados
      const tw = ctx.measureText(label).width;
      let lx = x - tw - 9, ly = y + 4;
      if (key === 'end') { lx = x - tw / 2; ly = y + 18; }
      if (lx < L + 2) lx = x + 9;
      for (let i = 0; i < 6 && placed.some((b) => !(lx + tw < b.x || lx > b.x + b.w || ly < b.y - 12 || ly - 12 > b.y)); i++) ly -= 13;
      placed.push({ x: lx, y: ly, w: tw });
      ctx.fillStyle = color;
      ctx.textAlign = 'left';
      ctx.fillText(label, lx, ly);
      const spd = p.ias != null ? `${r0(p.ias)} KIAS` : `${r0(p.tas)} KTAS`;
      items.push(`<span class="viz-legend-item"><span class="viz-swatch" style="background:${color}"></span>${label} · ${spd} · ${r0(p.ff * k)} ${unit()}/h</span>`);
    }
    legend.innerHTML = items.join('');
    const figs = r.charts.map((c) => c.fig).join(', ');
    $('curveSource').innerHTML = `Curva na PA ${r0(base.pa)} ft, OAT ${r0(base.oat)} °C, ${qty(base.gwKg)}. Reta tracejada: ${hw ? `do vento de proa (${hw} kt) ` : 'da origem '}ao best range. RFM Seção 9, Fig. ${figs}; interpolação em OAT e depois em PA (p. 9-3).`;
  }

  // ---------- rota (ida e volta) ----------
  function buildWindTable() {
    let html = '<div class="wt-head">Alt</div><div class="wt-head">Direção (°)</div><div class="wt-head">Vel (kt)</div>';
    for (const a of ROUTE_ALTS) {
      html += `<div class="wt-alt">${a} ft</div>` +
        `<input id="wd${a}" type="text" inputmode="numeric" maxlength="3" placeholder="—" aria-label="Direção do vento a ${a} ft">` +
        `<input id="ws${a}" type="text" inputmode="numeric" maxlength="3" placeholder="—" aria-label="Velocidade do vento a ${a} ft">`;
    }
    $('windTable').innerHTML = html;
  }

  function computeRoute(silent) {
    const out = $('routeOut');
    const s = state.last;
    if (!s) { if (!silent) out.innerHTML = '<p class="err-line">Calcule primeiro com os dados do topo.</p>'; return; }
    const course = num('course'), dist = num('dist');
    if (course == null || dist == null || dist <= 0) { if (!silent) out.innerHTML = '<p class="err-line">Informe o rumo de ida e a distância.</p>'; return; }
    const mode = $('speedMode').value;
    const { inp } = s;
    const dIsa = s.scan.dIsa;
    const back = (course + 180) % 360;
    const rows = [];
    for (const alt of ROUTE_ALTS) {
      const dir = num('wd' + alt), spd = num('ws' + alt);
      if (dir == null || spd == null) continue;
      const pa = paOf(inp, alt);
      const oat = F.isaTemp(pa) + dIsa;
      const legs = {};
      for (const [key, crs] of [['ida', course], ['volta', back]]) {
        const wc = F.windComponents(dir, spd, crs);
        const r = E.solve({ pa, oat, gwKg: inp.gwKg, hw: wc.hw, xw: wc.xw, cf: inp.cf, ibf: inp.ibf, tas: mode === 'tas150' ? 150 : null });
        if (r.err) { legs[key] = { err: r.err }; continue; }
        const p = mode === 'tas150' ? r.fix : r.rng;
        if (!p || p.out || !(p.gs > 20)) { legs[key] = { err: 'sem solução' }; continue; }
        const hrs = dist / p.gs;
        legs[key] = { hw: wc.hw, p, hrs, fuel: p.ff * hrs };
      }
      rows.push({ alt, oat, dir, spd, legs });
    }
    state.route = { course, dist, mode };
    save();
    if (!rows.length) { out.innerHTML = '<p class="err-line">Preencha o vento de pelo menos uma altitude.</p>'; return; }
    const pick = (key) => rows.filter((x) => x.legs[key] && !x.legs[key].err).reduce((a, b) => (!a || b.legs[key].fuel < a.legs[key].fuel ? b : a), null);
    const bi = pick('ida'), bv = pick('volta');
    const near = (key, best) => {
      if (!best) return '';
      const lim = best.legs[key].fuel * 1.01;
      const alts = rows.filter((x) => x !== best && x.legs[key] && !x.legs[key].err && x.legs[key].fuel <= lim).map((x) => x.alt);
      return alts.length ? `<br>Até +1 %: ${alts.join(', ')} ft` : '';
    };
    const card = (title, crs, row, key, cls) => {
      if (!row) return `<div class="route-card ${cls}"><div class="rc-label">${title} · ${String(r0(crs)).padStart(3, '0')}°</div><div class="rc-main">Sem solução nas cartas</div></div>`;
      const l = row.legs[key];
      const comp = l.hw >= 0 ? `proa ${r0(l.hw)} kt` : `cauda ${r0(-l.hw)} kt`;
      const spd = l.p.ias != null ? `${r0(l.p.ias)} KIAS` : `${r0(l.p.tas)} KTAS`;
      return `<div class="route-card ${cls}"><div class="rc-label">${title} · ${String(r0(crs)).padStart(3, '0')}°</div>` +
        `<div class="rc-alt">${row.alt} ft</div><div class="rc-main">${qty(l.fuel)} · ${hm(l.hrs)}</div>` +
        `<div class="rc-sub">${spd} · TQ&nbsp;${r0(l.p.tq)}&nbsp;% · GS&nbsp;${r0(l.p.gs)} · ${comp}<br>${rate(l.p.ff)}${near(key, row)}</div></div>`;
    };
    let html = `<div class="route-cards">${card('Ida', course, bi, 'ida', '')}${card('Volta', back, bv, 'volta', 'back')}</div>`;
    if (bi && bv) {
      const tot = bi.legs.ida.fuel + bv.legs.volta.fuel;
      const left = s.usableKg - tot;
      html += `<div class="route-total${left < 0 ? ' bad' : ''}">Ida + volta: <b>${qty(tot, true)}</b> · ${hm(bi.legs.ida.hrs + bv.legs.volta.hrs)} de voo. ` +
        (left >= 0 ? `Sobra ${qty(left)} acima da reserva.` : `Faltam ${qty(-left)} para manter a reserva.`) + '</div>';
    }
    html += '<div class="table-wrap"><table class="fuel-table"><thead><tr><th>Alt</th><th>Vento</th><th>Ida</th><th>Volta</th><th>Total</th></tr></thead><tbody>';
    for (const row of rows) {
      const cell = (key, best) => {
        const l = row.legs[key];
        if (!l || l.err) return '<td class="na">—</td>';
        return `<td${best === row ? ' class="best-r"' : ''}>${r0(unit() === 'lb' ? l.fuel * KG_TO_LB : l.fuel)} · ${hm(l.hrs)}</td>`;
      };
      const tot = row.legs.ida && !row.legs.ida.err && row.legs.volta && !row.legs.volta.err ? row.legs.ida.fuel + row.legs.volta.fuel : null;
      html += `<tr><td>${row.alt}</td><td>${String(r0(row.dir)).padStart(3, '0')}/${r0(row.spd)}</td>${cell('ida', bi)}${cell('volta', bv)}<td>${tot == null ? '—' : r0(unit() === 'lb' ? tot * KG_TO_LB : tot)}</td></tr>`;
    }
    html += `</tbody></table></div><p class="source-line">Combustível em ${unit()} e tempo de cada perna em ${mode === 'tas150' ? '150 KTAS' : 'best range com o vento da altitude'}. Peso atual nas duas pernas; não inclui subida, descida nem tempo na UM. OAT pela variação padrão (ISA ${signed(r0(dIsa), ' °C')}).</p>`;
    out.innerHTML = html;
  }

  // ---------- estado salvo ----------
  function save() {
    const data = {};
    for (const id of FIELDS) data[id] = $(id).value;
    for (const id of SELECTS) data[id] = $(id).value;
    data.eq = EQUIP.filter((e) => $(e.id).checked).map((e) => e.id);
    data.course = $('course').value;
    data.dist = $('dist').value;
    data.wind = {};
    for (const a of ROUTE_ALTS) data.wind[a] = [$('wd' + a).value, $('ws' + a).value];
    data.hasRoute = !!state.route;
    try { localStorage.setItem(STORE, JSON.stringify(data)); } catch (_) {}
  }

  function restore() {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (_) {}
    if (!data) return false;
    for (const id of SELECTS) if (data[id] != null) $(id).value = data[id];
    for (const id of FIELDS) if (data[id] != null) $(id).value = data[id];
    for (const e of EQUIP) $(e.id).checked = (data.eq || []).includes(e.id);
    if (data.course != null) $('course').value = data.course;
    if (data.dist != null) $('dist').value = data.dist;
    for (const a of ROUTE_ALTS) {
      const v = data.wind && data.wind[a];
      if (v) { $('wd' + a).value = v[0] || ''; $('ws' + a).value = v[1] || ''; }
    }
    state.route = data.hasRoute ? {} : null;
    return true;
  }

  function clearAll() {
    try { localStorage.removeItem(STORE); } catch (_) {}
    for (const id of FIELDS) $(id).value = '';
    $('course').value = '';
    $('dist').value = '';
    for (const a of ROUTE_ALTS) { $('wd' + a).value = ''; $('ws' + a).value = ''; }
    for (const e of EQUIP) $(e.id).checked = false;
    $('reserveMode').value = 'r30';
    $('ibf').value = '0';
    state.last = null;
    state.route = null;
    $('routeOut').innerHTML = '';
    $('resultCard').classList.add('pending');
    $('statusChip').textContent = 'Aguardando cálculo';
    $('statusChip').className = 'status-chip warn';
    for (const k of ['Rng', 'End', 'Rec', 'Cur']) { $('val' + k).innerHTML = '—'; $('sub' + k).innerHTML = ''; $('box' + k).classList.remove('muted'); }
    $('mainRng').textContent = 'Alcance';
    $('mainEnd').textContent = 'Autonomia';
    $('mainRec').textContent = '';
    $('mainCur').textContent = 'Informe a IAS atual';
    $('altBand').textContent = '—';
    $('resFoot').innerHTML = '';
    syncUi();
    renderAltitudes();
    drawCurve();
  }

  // ---------- interface ----------
  function syncUi() {
    const u = unit();
    $('weightLabel').textContent = `Peso atual (${u})`;
    $('fuelLabel').textContent = `Combustível (${u})`;
    $('reserveLabel').textContent = `Reserva (${u})`;
    $('weight').placeholder = u === 'lb' ? '13500' : '6100';
    $('fuel').placeholder = u === 'lb' ? '2400' : '1090';
    $('reserve').placeholder = u === 'lb' ? '493' : '224';
    $('reserveField').hidden = $('reserveMode').value !== 'manual';
    const cf = cfTotal();
    const badge = $('advBadge');
    const extra = [];
    if ($('ibf').value === '1') extra.push('IBF');
    if (cf) extra.push(`CF ${cf.toFixed(1).replace('.', ',')}`);
    badge.textContent = extra.length ? `· ${extra.join(' · ')}` : '';
    updateCalcBand();
  }

  function updateCalcBand() {
    const alt = num('alt'), qnh = num('qnh'), oat = num('oat');
    if (alt == null) { $('calcPa').textContent = '—'; $('calcIsa').textContent = '—'; return; }
    const pa = F.pressureAltitude(alt, qnh);
    $('calcPa').textContent = `${r0(pa)} ft`;
    $('calcIsa').textContent = oat == null ? '—' : `${signed(r0(oat - F.isaTemp(pa)), ' °C')}`;
  }

  function convertUnits(from, to) {
    if (from === to) return;
    const f = from === 'lb' ? 1 / KG_TO_LB : KG_TO_LB;
    for (const id of ['weight', 'fuel', 'reserve']) {
      const v = num(id);
      if (v != null) $(id).value = String(r0(v * f));
    }
  }

  function showTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.viewer-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    for (const t of ['curva', 'altitudes', 'rota']) $('tab-' + t).hidden = t !== tab;
    $('vizTitle').textContent = tab === 'curva' ? 'Consumo × velocidade' : tab === 'altitudes' ? 'Comparação por altitude' : 'Rota ida e volta';
    if (tab === 'curva') requestAnimationFrame(drawCurve);
  }

  function init() {
    // equipamento externo
    $('eqList').innerHTML = EQUIP.map((e) => `<label class="eq-item"><input type="checkbox" id="${e.id}"><span>${e.label}</span><span class="cf">${e.cf.toFixed(1).replace('.', ',')}</span></label>`).join('');
    const sum = document.querySelector('#advBox summary');
    sum.insertAdjacentHTML('beforeend', '<span class="adv-badge" id="advBadge"></span>');
    buildWindTable();

    let lastUnit = unit();
    $('unit').addEventListener('change', () => { convertUnits(lastUnit, unit()); lastUnit = unit(); syncUi(); if (state.last) calc(); });
    $('reserveMode').addEventListener('change', syncUi);
    $('ibf').addEventListener('change', syncUi);
    for (const e of EQUIP) {
      $(e.id).addEventListener('change', () => {
        if (e.group && $(e.id).checked) for (const o of EQUIP) if (o !== e && o.group === e.group) $(o.id).checked = false;
        syncUi();
      });
    }
    $('ceiling').addEventListener('change', () => { if (state.last) { renderSuggestion(); renderAltitudes(); save(); } });
    $('speedMode').addEventListener('change', () => { if (state.route) computeRoute(true); });
    $('oatSign').addEventListener('click', () => toggleSign($('oat')));
    $('hwSign').addEventListener('click', () => toggleSign($('hw')));
    for (const id of FIELDS) {
      const el = $(id);
      el.addEventListener('input', () => { sanitize(el, id === 'oat' || id === 'hw'); updateCalcBand(); });
    }
    const order = ['alt', 'qnh', 'oat', 'weight', 'fuel', 'ias', 'hw'];
    order.forEach((id, i) => {
      $(id).addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        if (i < order.length - 1) $(order[i + 1]).focus(); else { $(id).blur(); calc(); }
      });
    });
    document.querySelectorAll('#windTable input, #course, #dist').forEach((el) => {
      el.addEventListener('input', () => sanitize(el, false));
    });
    $('runBtn').addEventListener('click', calc);
    $('resetBtn').addEventListener('click', clearAll);
    $('routeBtn').addEventListener('click', () => computeRoute(false));
    document.querySelectorAll('.viewer-tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
    let rt = null;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(drawCurve, 120); });

    const had = restore();
    syncUi();
    if (had && missing(readInputs()).length === 0) calc();
    else drawCurve();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
