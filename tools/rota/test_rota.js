// Testes do plano de rota (lab): node tools/rota/test_rota.js
'use strict';
const path = require('path');
global.window = {};
require(path.join(__dirname, '../../combustivel/cruise-data.js'));
require(path.join(__dirname, '../../rota/nav-data.js'));
const F = require(path.join(__dirname, '../../combustivel/engine.js'));
const R = require(path.join(__dirname, '../../rota/route.js'));
const E = F.create(window.AW139_CRUISE);
const nav = R.createNav(window.AW139_NAV);

let fails = 0, passes = 0;
function ok(name, cond, extra) { if (cond) passes++; else { fails++; console.log('FALHA', name, extra === undefined ? '' : extra); } }
function near(name, got, want, tol) { ok(name, got != null && Math.abs(got - want) <= tol, `obtido ${got}, esperado ${want} ± ${tol}`); }

// 1. Base
ok('9PMO = P-68', nav.lookup('9PMO') && nav.lookup('P-68') && nav.lookup('p68').id === '9PMO');
ok('SBJR é base', nav.lookup('SBJR').k === 'base');
ok('DIBIL é ponto de Santos', nav.lookup('DIBIL').k === 'santos');
const c = R.parseLatLon('2501S04240W');
near('coordenada lat', c.lat, -(25 + 1 / 60), 1e-9);
near('coordenada lon', c.lon, -(42 + 40 / 60), 1e-9);
ok('coordenada inválida', R.parseLatLon('2561S04240W') === null);

// 2. Rota com aerovia
let r = R.parseRoute(nav, 'SBJR DIBIL KZ204 BS072 9PMO');
ok('rota sem erro', r.errors.length === 0, r.errors);
ok('aerovia expandida', r.pts.map((p) => p.id).join(' ') === 'SBJR DIBIL BS219 CS029 BS234 OBLOL BS066 BS067 BS068 BS069 BS071 BS072 9PMO', r.pts.map((p) => p.id).join(' '));
ok('Bacia de Santos detectada', r.santos);
r = R.parseRoute(nav, '9PMO BS072 KZ204 DIBIL SBJR');
ok('mão única recusada', r.errors.some((e) => /mão única/.test(e)), r.errors);
r = R.parseRoute(nav, 'BS064 KZ231 EGUDI SBJR');
ok('volta pela KZ231', r.errors.length === 0 && r.pts[r.pts.length - 2].id === 'EGUDI', r.errors);
r = R.parseRoute(nav, 'SBJR XPTO 9PMO');
ok('ponto desconhecido', r.errors.some((e) => /XPTO/.test(e)));

// 3. Geometria: SBJR → SBME
const jr = nav.lookup('SBJR'), me = nav.lookup('SBME');
near('distância SBJR-SBME', R.gcDist(jr, me), 96.7, 1.5);
near('rumo SBJR-SBME', R.gcCourse(jr, me), 66.5, 1.5);
near('FL045 em hPa', R.paToHpa(4500), 859, 1);
near('FL085 em hPa', R.paToHpa(8500), 738.6, 1);

// 4. Vento: campo sintético. Nível baixo: vento de 180°/40 kt; alto (850 hPa para cima): calmo.
function field(lowDir, lowSpd, highDir, highSpd, t0) {
  const times = [t0 - 3600e3, t0, t0 + 3600e3, t0 + 2 * 3600e3, t0 + 3 * 3600e3, t0 + 4 * 3600e3];
  const lv = {};
  for (const p of R.LEVELS) {
    const high = p <= 850;
    const d = (high ? highDir : lowDir) * Math.PI / 180, s = high ? highSpd : lowSpd;
    lv[p] = times.map(() => ({ u: -s * Math.sin(d), v: -s * Math.cos(d), t: 20 - (1000 - p) / 12 }));
  }
  return { times, lv };
}
const t0 = Date.UTC(2026, 10, 24, 12);
const f1 = field(180, 40, 0, 0, t0);
const w = R.windAt(f1, t0 + 1800e3, 925);
const ds = R.windToDirSpd(w.u, w.v);
near('vento a 925 hPa: velocidade', ds.spd, 40, 0.01);
near('vento a 925 hPa: direção', ds.dir, 180, 0.01);
const w2 = R.windAt(f1, t0, R.paToHpa(8500));
near('vento a FL085 (calmo)', Math.hypot(w2.u, w2.v), 0, 0.01);

// 5. Plano: rumo sul com vento de proa embaixo → ida melhor em nível alto; volta (rumo norte) melhor embaixo
const A = { id: 'A', lat: -23.0, lon: -42.0 }, B = { id: 'B', lat: -24.5, lon: -42.0 };
const legsIda = R.buildLegs([A, B]);
const legsVolta = R.buildLegs([B, A]);
near('perna A-B 90 NM', legsIda[0].dist, 90, 0.5);
near('rumo A-B 180°', legsIda[0].crs, 180, 0.5);
const fieldsFor = (legs) => {
  const fields = [], idx = [];
  for (const l of legs) { const row = []; for (const sm of l.samples) { row.push(fields.length); fields.push(f1); } idx.push(row); }
  return { fields, idx };
};
const opt = { t0, gwKg: 6200, speed: 'rng' };
const fi = fieldsFor(legsIda), fv = fieldsFor(legsVolta);
const ida = R.planDirection(E, legsIda, fi.fields, fi.idx, R.levelsFor('circea', 'ida', nav), opt);
const volta = R.planDirection(E, legsVolta, fv.fields, fv.idx, R.levelsFor('circea', 'volta', nav), opt);
ok('ida: todos os níveis calculados', ida.rows.every((x) => x.ok), ida.rows.map((x) => x.err));
ok('ida: melhor nível alto (vento de proa embaixo)', ida.best && ['FL045', 'FL065', 'FL085'].includes(ida.best.lv.label), ida.best && ida.best.lv.label);
ok('volta: melhor FL035 (vento de cauda embaixo)', volta.best && volta.best.lv.label === 'FL035', volta.best && volta.best.lv.label);
const r25 = ida.rows.find((x) => x.lv.label === 'FL025');
near('ida FL025: componente de proa 40 kt', r25.hwAvg, 40, 0.5);
ok('ida FL025 consome mais que o melhor', r25.fuel > ida.best.fuel);

// 6. URL e resposta do Open-Meteo
const url = R.windUrl([{ lat: -23.1, lon: -42.2 }, { lat: -24, lon: -42.5 }], t0, t0 + 3 * 3600e3);
ok('URL com os dois pontos', /latitude=-23\.100,-24\.000&longitude=-42\.200,-42\.500/.test(url), url);
ok('URL com nível 925 hPa e nós', /wind_speed_925hPa/.test(url) && /wind_speed_unit=kn/.test(url) && /start_hour=2026-11-24T12:00/.test(url), url);
const mock = [0, 1].map((k) => ({
  latitude: -23 - k, longitude: -42,
  hourly: Object.assign({ time: ['2026-11-24T12:00', '2026-11-24T13:00'] },
    ...R.LEVELS.map((p) => ({ [`wind_speed_${p}hPa`]: [20, 30], [`wind_direction_${p}hPa`]: [90, 90], [`temperature_${p}hPa`]: [15, 15] }))),
}));
const parsed = R.parseWind(mock, 2);
const pw = R.windAt(parsed[0], t0 + 1800e3, 900);
const pd = R.windToDirSpd(pw.u, pw.v);
near('resposta: 25 kt no meio da hora', pd.spd, 25, 0.01);
near('resposta: de 090°', pd.dir, 90, 0.01);
let threw = false;
try { R.parseWind(mock, 3); } catch (e) { threw = true; }
ok('resposta com número errado de pontos', threw);

console.log(`\n${passes} ok, ${fails} falhas`);
process.exit(fails ? 1 : 0);
