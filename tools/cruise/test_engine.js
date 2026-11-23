// Testes do motor do fluxo Combustível: node tools/cruise/test_engine.js
// Confere com os exemplos do RFM (Seção 9, p. 9-3, 9-5, 9-6) e com as tabelas
// FUEL CONSUMPTION do QRH I02 R31 (Lims-Norm-Perf p. 90 e 92).
'use strict';
const path = require('path');
global.window = {};
require(path.join(__dirname, '../../combustivel/cruise-data.js'));
const F = require(path.join(__dirname, '../../combustivel/engine.js'));
const E = F.create(window.AW139_CRUISE);

let fails = 0, passes = 0;
function near(name, got, want, tol) {
  const ok = got != null && Math.abs(got - want) <= tol;
  if (ok) passes++; else { fails++; console.log(`FALHA ${name}: obtido ${got == null ? 'null' : got.toFixed(1)}, esperado ${want} ± ${tol}`); }
}
function truthy(name, v) { if (v) passes++; else { fails++; console.log('FALHA', name); } }

// 1. Exemplo de interpolação (RFM p. 9-3): PA 5000 ft, OAT 10 °C, 5600 kg, recommended cruise
let r = E.solve({ pa: 5000, oat: 10, gwKg: 5600 });
near('p9-3 TQ', r.rec.tq, 72, 1.0);
near('p9-3 IAS', r.rec.ias, 142, 1.5);
near('p9-3 TAS', r.rec.tas, 153, 1.5);
near('p9-3 FF', r.rec.ff, 404, 4);

// valores de cada carta do mesmo exemplo
for (const [pa, oat, tq, ias, tas, ff] of [[4000, 0, 76, 149, 154, 420], [4000, 20, 73, 143, 154, 418], [6000, 0, 70, 141, 152, 390], [6000, 20, 68, 134, 151, 388]]) {
  const x = E.solve({ pa, oat, gwKg: 5600 });
  near(`p9-3 ${pa}/${oat} TQ`, x.rec.tq, tq, 1.0);
  near(`p9-3 ${pa}/${oat} IAS`, x.rec.ias, ias, 1.5);
  near(`p9-3 ${pa}/${oat} TAS`, x.rec.tas, tas, 1.5);
  near(`p9-3 ${pa}/${oat} FF`, x.rec.ff, ff, 3);
}

// 2. Exemplo 1 (p. 9-5): Fig. 9-4, 5600 kg, recommended cruise
r = E.solve({ pa: 0, oat: 20, gwKg: 5600 });
near('p9-5 TAS', r.rec.tas, 161, 1.5);
near('p9-5 IAS', r.rec.ias, 162, 1.5);
near('p9-5 TQ', r.rec.tq, 88, 1.0);
near('p9-5 FF', r.rec.ff, 492, 3);

// 3. Exemplo 2 (p. 9-6): Fig. 9-17, 6000 kg, velocidade máxima na MCP = 158 KTAS / 142 KIAS / 445 kg/h
r = E.solve({ pa: 4000, oat: 40, gwKg: 6000, tas: 170 });
near('p9-6 TAS (MCP)', r.fix.tas, 158, 1.5);
near('p9-6 IAS (MCP)', r.fix.ias, 142, 1.5);
near('p9-6 FF (MCP)', r.fix.ff, 445, 4);
truthy('p9-6 marcado como limitado', r.fix.tag === 'MCP');

// 4. Tabelas do QRH (consumo em IAS fixa)
const isa = (pa) => 15 - 1.98 * pa / 1000;
const qrh = {
  6400: { cols: [-40, -20, 'ISA', 15, 25, 35], rows: {
    2000: { 90: [320, 327, 336, 339, 342, 345], 120: [348, 355, 368, 377, 383, 390], 150: [413, 427, 457, 474, 485, null] },
    4000: { 90: [310, 315, 322, 326, 331, 336], 120: [338, 344, 361, 371, 379, 388], 150: [408, 424, 458, 477, null, null] },
    8000: { 90: [289, 293, 303, 311, 318, 324], 120: [321, 335, 352, 367, 383, 401], 150: [417, 446, 480, null, null, null] },
    12000: { 90: [274, 286, 294, 306, 317, 337], 120: [323, 351, 374, 407, null, null], 150: [468, null, null, null, null, null] } } },
  6800: { cols: [-20, 0, 'ISA', 15, 25, 35], rows: {
    2000: { 90: [336, 336, 340, 348, 353, 358], 120: [360, 366, 373, 386, 395, 400], 150: [428, 456, 467, 480, 492, null] },
    4000: { 90: [320, 330, 333, 338, 344, 349], 120: [350, 362, 368, 380, 392, 402], 150: [436, 462, 472, 490, null, null] },
    8000: { 90: [303, 315, 315, null, null, null], 120: [346, 370, 370, null, null, null], 150: [468, 480, 480, null, null, null] } } },
};
const diffs = [];
for (const [gw, t] of Object.entries(qrh)) {
  for (const [pa, row] of Object.entries(t.rows)) {
    for (const [ias, vals] of Object.entries(row)) {
      vals.forEach((v, i) => {
        if (v == null) return;
        const col = t.cols[i];
        const oat = col === 'ISA' ? isa(+pa) : (i >= 3 ? isa(+pa) + col : col);
        const x = E.solve({ pa: +pa, oat, gwKg: +gw, ias: +ias });
        if (x.err || !x.cur || x.cur.out) return;
        diffs.push({ gw, pa, ias, col, v, got: x.cur.ff, d: x.cur.ff - v, ex: !!x.cur.extrap, over: !!x.cur.tag });
      });
    }
  }
}
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const d64 = diffs.filter((d) => d.gw === '6400' && !d.ex && !d.over).map((d) => Math.abs(d.d));
const d68 = diffs.filter((d) => d.gw === '6800' && !d.ex && !d.over).map((d) => Math.abs(d.d));
const dex = diffs.filter((d) => d.ex && !d.over).map((d) => Math.abs(d.d));
console.log(`QRH com a curva de uma carta prolongada: ${dex.length} células, erro médio ${mean(dex).toFixed(1)}, máx ${Math.max(...dex).toFixed(1)} kg/h`);
for (const d of diffs.filter((x) => x.ex && !x.over)) console.log('   prolongado', d.gw, d.pa, d.ias, d.col, 'QRH', d.v, 'calc', d.got.toFixed(1));
for (const d of diffs.filter((x) => x.over)) console.log('   acima da MCP', d.gw, d.pa, d.ias, d.col, 'QRH', d.v, 'calc', d.got.toFixed(1));
truthy('QRH prolongado: erro médio ≤ 4 kg/h', mean(dex) <= 4);
truthy('QRH prolongado: erro máx ≤ 9 kg/h', Math.max(...dex) <= 9);
console.log(`QRH 6400 kg: ${d64.length} células, erro médio ${mean(d64).toFixed(1)} kg/h, máx ${Math.max(...d64).toFixed(1)}`);
console.log(`QRH 6800 kg: ${d68.length} células, erro médio ${mean(d68).toFixed(1)} kg/h, máx ${Math.max(...d68).toFixed(1)}`);
truthy('QRH 6400 erro médio ≤ 1,5 kg/h', mean(d64) <= 1.5);
truthy('QRH 6400 erro máx ≤ 3 kg/h', Math.max(...d64) <= 3);
truthy('QRH 6800 erro médio ≤ 3 kg/h', mean(d68) <= 3);
truthy('QRH 6800 erro máx ≤ 6 kg/h', Math.max(...d68) <= 6);

// 5. Vento (RFM p. 9-4): 25 kt a 35° da proa → componente de proa 20 kt
const wc = F.windComponents(35, 25, 0);
near('vento 25 kt/35° proa', wc.hw, 20.5, 0.6);

// 6. Coerência numa grade de condições
let checked = 0;
for (const pa of [0, 1000, 2500, 4000, 5000, 6000, 8000, 10000]) {
  for (const dIsa of [-10, 0, 10, 20, 25]) {
    for (const gw of [4600, 5200, 5800, 6300, 6800]) {
      const oat = isa(pa) + dIsa;
      const x = E.solve({ pa, oat, gwKg: gw });
      if (x.err) continue;
      checked++;
      if (!(x.end.ff <= x.rng.ff + 0.5)) { fails++; console.log('FALHA end.ff > rng.ff', pa, oat, gw, x.end.ff, x.rng.ff); }
      if (!(x.rng.tas <= (x.rec.out ? Infinity : x.rec.tas) + 1e-6)) { fails++; console.log('FALHA rng.tas > rec.tas', pa, oat, gw); }
      if (!(x.end.tas < x.rng.tas)) { fails++; console.log('FALHA end.tas >= rng.tas', pa, oat, gw, x.end.tas, x.rng.tas); }
      // vento de proa aumenta a velocidade de melhor alcance; de cauda, reduz
      const h = E.solve({ pa, oat, gwKg: gw, hw: 30 });
      const tl = E.solve({ pa, oat, gwKg: gw, hw: -30 });
      if (!(h.rng.tas >= x.rng.tas - 0.3 && tl.rng.tas <= x.rng.tas + 0.3)) { fails++; console.log('FALHA vento', pa, oat, gw, tl.rng.tas, x.rng.tas, h.rng.tas); }
      // peso maior consome mais
      if (gw < 6800) {
        const y = E.solve({ pa, oat, gwKg: gw + 200 });
        if (!y.err && !(y.end.ff >= x.end.ff - 0.3)) { fails++; console.log('FALHA peso', pa, oat, gw, x.end.ff, y.end.ff); }
      }
    }
  }
}
truthy(`grade de coerência (${checked} casos)`, checked > 120);

// 7. Fora da carta
truthy('7000 kg recusado', !!E.solve({ pa: 2000, oat: 20, gwKg: 7000 }).err);
truthy('OAT 45 °C a 6000 ft recusado', !!E.solve({ pa: 6000, oat: 45, gwKg: 6000 }).err);

// 8. IBF: +3,5 % no consumo, mesmas velocidades
const a = E.solve({ pa: 3000, oat: 25, gwKg: 6200 });
const b = E.solve({ pa: 3000, oat: 25, gwKg: 6200, ibf: true });
near('IBF +3,5 %', b.rng.ff / a.rng.ff, 1.035, 0.0005);
near('IBF mesma TAS', b.rng.tas - a.rng.tas, 0, 0.05);

// 9. Equipamento (Tab. 9-1): DTQ aumenta torque e consumo na mesma TAS
const c0 = E.solve({ pa: 0, oat: 20, gwKg: 5600, tas: 161 });
const c1 = E.solve({ pa: 0, oat: 20, gwKg: 5600, tas: 161, cf: 0.5 });
near('DTQ p9-5: +11,5 % TQ a 161 KTAS', c1.fix.tq - c0.fix.tq, 11.5, 0.6);

// 10. Dia quente (ISA+19, ~5000 ft): IAS de cruzeiro tem de sair, mesmo que a carta de 40 °C pare antes.
for (const ias of [130, 140, 145]) {
  const h = E.solve({ pa: 5000, oat: isa(5000) + 19, gwKg: 6500, ias });
  truthy(`ISA+19 5000 ft 6500 kg ${ias} KIAS calculado`, h.cur && !h.cur.out);
  if (h.cur && !h.cur.out) truthy(`ISA+19 ${ias} KIAS abaixo da MCP real`, h.cur.tag == null);
}
// reserva a 150 KTAS não deve parar na MCP da carta quente
const rr = E.solve({ pa: 5000, oat: isa(5000) + 19, gwKg: 6500, tas: 150 });
near('150 KTAS em ISA+19 sem limitar', rr.fix.tas, 150, 0.01);

console.log(`\n${passes} ok, ${fails} falhas`);
process.exit(fails ? 1 : 0);
