"""Extrai por vetor as cartas de cruzeiro AEO (RFM AW139, Seção 9, Figuras 9-1 a 9-55).

Uso: python3 -I extract_cruise.py <cruise_aeo.pdf> <saida.json> [pasta_qa]
O PDF de entrada contém só as 55 páginas das cartas (páginas 4215–4269 do RFM completo).
"""
import json
import math
import re
import sys

import pymupdf

GW_LABELS = {"4400", "4800", "5200", "5600", "6000", "6400", "6800"}
THICK = 0.85


def dedupe_words(words):
    out = []
    for w in words:
        dup = False
        for o in out:
            if o[4] == w[4] and abs(o[0] - w[0]) < 1.5 and abs(o[1] - w[1]) < 1.5:
                dup = True
                break
        if not dup:
            out.append(w)
    return out


def bezier(p0, c1, c2, p3, n=16):
    pts = []
    for i in range(n + 1):
        t = i / n
        a, b, c, d = (1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t * t, t ** 3
        pts.append((a * p0.x + b * c1.x + c * c2.x + d * p3.x, a * p0.y + b * c1.y + c * c2.y + d * p3.y))
    return pts


def path_polylines(d):
    """Converte os itens de um path em polilinhas encadeadas."""
    polys = []
    for it in d["items"]:
        k = it[0]
        if k == "l":
            seg = [(it[1].x, it[1].y), (it[2].x, it[2].y)]
        elif k == "c":
            seg = bezier(it[1], it[2], it[3], it[4])
        elif k == "re":
            r = it[1]
            seg = [(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1), (r.x0, r.y0)]
        elif k == "qu":
            q = it[1]
            seg = [(q.ul.x, q.ul.y), (q.ur.x, q.ur.y), (q.lr.x, q.lr.y), (q.ll.x, q.ll.y), (q.ul.x, q.ul.y)]
        else:
            continue
        if polys and math.dist(polys[-1][-1], seg[0]) < 0.05:
            polys[-1].extend(seg[1:])
        else:
            polys.append(list(seg))
    return polys


def _dir(p, q):
    L = math.dist(p, q) or 1
    return ((q[0] - p[0]) / L, (q[1] - p[1]) / L)


def _smooth(a, b, max_deg=35):
    """a termina onde b começa: as tangentes precisam seguir."""
    k = 1
    while k < len(a) - 1 and math.dist(a[-1 - k], a[-1]) < 1.0:
        k += 1
    m = 1
    while m < len(b) - 1 and math.dist(b[0], b[m]) < 1.0:
        m += 1
    da = _dir(a[-1 - k], a[-1])
    db = _dir(b[0], b[m])
    return da[0] * db[0] + da[1] * db[1] > math.cos(math.radians(max_deg))


def join_polylines(polys, tol=0.45):
    """Une pedaços cujas pontas coincidem (a mesma curva às vezes vem em dois paths)."""
    polys = [list(p) for p in polys]
    changed = True
    while changed:
        changed = False
        for i in range(len(polys)):
            for j in range(len(polys)):
                if i == j or not polys[i] or not polys[j]:
                    continue
                a, b = polys[i], polys[j]
                if math.dist(a[-1], b[0]) < tol and _smooth(a, b):
                    polys[i] = a + b[1:]
                    polys[j] = []
                    changed = True
                elif math.dist(a[-1], b[-1]) < tol and _smooth(a, b[::-1]):
                    polys[i] = a + b[::-1][1:]
                    polys[j] = []
                    changed = True
            polys = [p for p in polys if p]
            if changed:
                break
    return polys


def bbox(poly):
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    return min(xs), min(ys), max(xs), max(ys)


def linfit(pairs):
    n = len(pairs)
    sx = sum(p[0] for p in pairs)
    sy = sum(p[1] for p in pairs)
    sxx = sum(p[0] * p[0] for p in pairs)
    sxy = sum(p[0] * p[1] for p in pairs)
    b = (n * sxy - sx * sy) / (n * sxx - sx * sx)
    a = (sy - b * sx) / n
    res = max(abs(a + b * x - y) for x, y in pairs)
    return a, b, res


def seg_intersect(p1, p2, q1, q2):
    d = (p2[0] - p1[0]) * (q2[1] - q1[1]) - (p2[1] - p1[1]) * (q2[0] - q1[0])
    if abs(d) < 1e-12:
        return None
    t = ((q1[0] - p1[0]) * (q2[1] - q1[1]) - (q1[1] - p1[1]) * (q2[0] - q1[0])) / d
    u = ((q1[0] - p1[0]) * (p2[1] - p1[1]) - (q1[1] - p1[1]) * (p2[0] - p1[0])) / d
    if -1e-9 <= t <= 1 + 1e-9 and -1e-9 <= u <= 1 + 1e-9:
        return (p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1]))
    return None


def poly_intersections(a, b):
    out = []
    for i in range(len(a) - 1):
        for j in range(len(b) - 1):
            p = seg_intersect(a[i], a[i + 1], b[j], b[j + 1])
            if p:
                out.append(p)
    # remove repetidos (pontas compartilhadas)
    uniq = []
    for p in out:
        if all(math.dist(p, q) > 0.2 for q in uniq):
            uniq.append(p)
    return uniq


def extend(poly, e=1.2):
    """Prolonga as pontas da linha de ótimo para pegar a interseção com a curva da ponta."""
    (x0, y0), (x1, y1) = poly[0], poly[1]
    L = math.dist((x0, y0), (x1, y1)) or 1
    s = (x0 - (x1 - x0) / L * e, y0 - (y1 - y0) / L * e)
    (xa, ya), (xb, yb) = poly[-2], poly[-1]
    L2 = math.dist((xa, ya), (xb, yb)) or 1
    t = (xb + (xb - xa) / L2 * e, yb + (yb - ya) / L2 * e)
    return [s] + poly + [t]


def point_poly_dist(p, poly):
    best = 1e9
    for i in range(len(poly) - 1):
        (x1, y1), (x2, y2) = poly[i], poly[i + 1]
        dx, dy = x2 - x1, y2 - y1
        L2 = dx * dx + dy * dy
        t = 0 if L2 == 0 else max(0, min(1, ((p[0] - x1) * dx + (p[1] - y1) * dy) / L2))
        best = min(best, math.dist(p, (x1 + t * dx, y1 + t * dy)))
    return best


def phrase_anchor(words, first, second=None):
    """Ponto de ancoragem (canto esquerdo, meio da altura) de um rótulo."""
    for i, w in enumerate(words):
        if w[4] != first:
            continue
        if second is None:
            return (w[0], (w[1] + w[3]) / 2), w
        for v in words:
            if v[4] == second and abs((v[1] + v[3]) / 2 - (w[1] + w[3]) / 2) < 2 and 0 < v[0] - w[2] < 6:
                return (w[0], (w[1] + w[3]) / 2), w
    return None, None


def extract_page(pg, fig_no):
    words = dedupe_words(pg.get_text("words"))
    text = " ".join(w[4] for w in words)
    m = re.search(r"Figure 9-(\d+)\s+Cruise \(PA (\d+) ft, OAT ([+-]?\d+)", text)
    assert m and int(m.group(1)) == fig_no, (fig_no, text[-200:])
    pa, oat = int(m.group(2)), int(m.group(3))
    m2 = re.search(r"Page (9-\d+)", text)
    page = m2.group(1)

    dr = pg.get_drawings()
    frame = None
    for d in dr:
        if d["type"] == "s" and len(d["items"]) == 1 and d["items"][0][0] == "re":
            r = d["items"][0][1]
            if r.width > 150 and r.height > 250:
                frame = r
    assert frame is not None
    fx0, fy0, fx1, fy1 = frame.x0, frame.y0, frame.x1, frame.y1

    thick = [d for d in dr if d["type"] == "s" and abs((d.get("width") or 0) - THICK) < 0.05]
    solid = [d for d in thick if not d.get("dashes") or d["dashes"].startswith("[] ")]
    dashed = [d for d in thick if d.get("dashes") and not d["dashes"].startswith("[] ")]

    # ---------- ticks ----------
    bottom_ticks, left_ticks, right_ticks, top_ticks = [], [], [], []
    for d in solid:
        if len(d["items"]) != 1 or d["items"][0][0] != "l":
            continue
        p, q = d["items"][0][1], d["items"][0][2]
        if abs(p.x - q.x) < 0.05:  # vertical
            y0, y1 = sorted((p.y, q.y))
            L = y1 - y0
            if abs(y0 - fy1) < 0.3 and 1.0 < L < 3.5:
                bottom_ticks.append(p.x)
            elif abs(y1 - fy0) < 0.3 and 1.0 < L < 3.5:
                top_ticks.append((p.x, L))
        elif abs(p.y - q.y) < 0.05:  # horizontal
            x0, x1 = sorted((p.x, q.x))
            L = x1 - x0
            if abs(x1 - fx0) < 0.3 and 1.0 < L < 3.0:
                left_ticks.append(p.y)
            elif abs(x0 - fx1) < 0.3 and 1.0 < L < 3.0:
                right_ticks.append(p.y)

    num = [w for w in words if re.fullmatch(r"\d+", w[4])]

    def cx(w):
        return (w[0] + w[2]) / 2

    def cy(w):
        return (w[1] + w[3]) / 2

    # Torque (eixo de baixo)
    pairs = []
    for w in num:
        if fy1 + 1 < w[1] < fy1 + 12 and fx0 - 12 < cx(w) < fx1 + 12:
            t = min(bottom_ticks, key=lambda x: abs(x - cx(w)))
            if abs(t - cx(w)) < 3:
                pairs.append((t, int(w[4])))
    tq_a, tq_b, tq_res = linfit(pairs)
    assert tq_res < 0.15, ("tq fit", tq_res)

    def TQ(x):
        return tq_a + tq_b * x

    def TQx(t):
        return (t - tq_a) / tq_b

    # TAS (eixo da esquerda)
    pairs = []
    for w in num:
        if fx0 - 16 < w[2] < fx0 - 0.5 and fy0 - 8 < cy(w) < fy1 + 8:
            t = min(left_ticks, key=lambda y: abs(y - cy(w)))
            if abs(t - cy(w)) < 3.5:
                pairs.append((t, int(w[4])))
    tas_a, tas_b, tas_res = linfit(pairs)
    assert tas_res < 0.15, ("tas fit", tas_res)

    def TAS(y):
        return tas_a + tas_b * y

    def TASy(v):
        return (v - tas_a) / tas_b

    # IAS (eixo da direita): rótulo fica logo acima do traço
    ias_pairs = []
    rt = sorted(set(round(y, 2) for y in right_ticks))
    for w in num:
        if fx1 + 0.5 < w[0] < fx1 + 16 and fy0 - 8 < cy(w) < fy1 + 8:
            v = int(w[4])
            if v == 0:
                continue
            t = min(rt, key=lambda y: abs(y - (w[3] - 1.7)))
            if abs(t - (w[3] - 1.7)) < 3:
                ias_pairs.append((round(TAS(t), 3), v))
    ias_pairs.sort()
    # conferência: IAS crescente com TAS
    for i in range(1, len(ias_pairs)):
        assert ias_pairs[i][1] > ias_pairs[i - 1][1], ias_pairs

    # Consumo (escala de cima): traços maiores com rótulo, menores intermediários
    tt = sorted(top_ticks)
    xs = []
    for x, L in tt:
        if xs and abs(xs[-1][0] - x) < 0.8:
            if L > xs[-1][1]:
                xs[-1] = (x, L)
            continue
        xs.append((x, L))
    labels = []
    for w in num:
        if fy0 - 14 < w[1] and w[3] < fy0 - 0.5 and fx0 + 1 < cx(w) < fx1 - 1:
            labels.append((cx(w), int(w[4])))
    labels = sorted(set((round(a, 1), b) for a, b in labels))
    # remove rótulos duplicados (mesmo valor)
    seen = {}
    for a, b in labels:
        seen.setdefault(b, a)
    labels = sorted((a, b) for b, a in seen.items())
    major_idx = {}
    for a, b in labels:
        j = min(range(len(xs)), key=lambda k: abs(xs[k][0] - a))
        assert abs(xs[j][0] - a) < 3.5, ("ff label", a, b, xs)
        major_idx[j] = b
    ks = sorted(major_idx)
    assert len(ks) >= 3
    ff_vals = [None] * len(xs)
    for i in range(len(ks) - 1):
        k0, k1 = ks[i], ks[i + 1]
        v0, v1 = major_idx[k0], major_idx[k1]
        for k in range(k0, k1 + 1):
            ff_vals[k] = v0 + (v1 - v0) * (k - k0) / (k1 - k0)
    step0 = (major_idx[ks[1]] - major_idx[ks[0]]) / (ks[1] - ks[0])
    for k in range(0, ks[0]):
        ff_vals[k] = major_idx[ks[0]] - step0 * (ks[0] - k)
    step1 = (major_idx[ks[-1]] - major_idx[ks[-2]]) / (ks[-1] - ks[-2])
    for k in range(ks[-1] + 1, len(xs)):
        ff_vals[k] = major_idx[ks[-1]] + step1 * (k - ks[-1])
    ff = [(round(TQ(x), 3), round(v, 2)) for (x, L), v in zip(xs, ff_vals)]
    for i in range(1, len(ff)):
        assert ff[i][0] > ff[i - 1][0] and ff[i][1] > ff[i - 1][1], ff
    # passo de valor entre traços deve ser uniforme dentro de cada par de rótulos
    # (confere se não faltou traço)
    for i in range(len(ks) - 1):
        n = ks[i + 1] - ks[i]
        assert n in (1, 2, 3, 4), ("ticks between labels", n)

    # DTQ: escala com zero na borda esquerda e o mesmo passo do torque
    dtq_labels = []
    for w in num:
        if fy0 + 8 < w[1] < fy0 + 20 and fx0 - 1 < w[0] < fx0 + 90:
            dtq_labels.append((cx(w), int(w[4])))
    dtq_ok = all(abs((TQ(a) - TQ(fx0)) - v) < 3.5 for a, v in dtq_labels if v not in (0,))
    assert dtq_ok, ("dtq labels", dtq_labels)

    # ---------- linhas ----------
    def inside(poly, m=0.6):
        x0, y0, x1, y1 = bbox(poly)
        return x0 >= fx0 - m and x1 <= fx1 + m and y0 >= fy0 - m and y1 <= fy1 + m

    vne_cands, top_cands, others = [], [], []
    for d in solid:
        for p in path_polylines(d):
            if len(p) < 2:
                continue
            x0, y0, x1, y1 = bbox(p)
            w, h = x1 - x0, y1 - y0
            if w < 0.3 and h > 40 and fx0 + 1 < x0 < fx1 - 1:
                top_cands.append(p)
                continue
            if h < 0.3 and w > 20 and fy0 + 1 < y0 < fy1 - 1:
                vne_cands.append(p)
                continue
            if not inside(p, 0.6):
                continue
            if w < 0.1 and (abs(x0 - fx0) < 0.3 or abs(x0 - fx1) < 0.3):
                continue
            if h < 0.1 and (abs(y0 - fy0) < 0.3 or abs(y0 - fy1) < 0.3):
                continue
            edge = min(abs(x0 - fx0), abs(x1 - fx1), abs(y0 - fy0), abs(y1 - fy1))
            if w < 3.5 and h < 3.5 and edge < 0.6:
                continue
            others.append(p)
    assert len(vne_cands) <= 1, ("vne cands", fig_no, len(vne_cands))
    vne = vne_cands[0] if vne_cands else None
    xs_top = sorted(set(round(p[0][0], 1) for p in top_cands))
    assert len(xs_top) == 1, ("top cands", fig_no, xs_top)
    top_line = top_cands[0]

    mcp_line = None
    dtq_pts = []
    for d in dashed:
        ds = d["dashes"]
        if ds.startswith("[ 9.21"):
            ps = [pt for poly in path_polylines(d) for pt in poly]
            mcp_line = ps
        elif ds.startswith("[ 7.086"):
            for poly in path_polylines(d):
                dtq_pts.extend(poly)
    assert mcp_line and top_line, ("limits", fig_no)
    mcp_x = sum(p[0] for p in mcp_line) / len(mcp_line)
    assert max(abs(p[0] - mcp_x) for p in mcp_line) < 0.2
    top_x = top_line[0][0]

    others = join_polylines(others)
    gw_curves, opt_lines = [], []
    for p in others:
        x0, y0, x1, y1 = bbox(p)
        ends = (p[0], p[-1])
        at_bottom = any(abs(e[1] - fy1) < 0.8 for e in ends)
        at_top_line = any(abs(e[0] - top_x) < 0.8 for e in ends)
        if (at_bottom or at_top_line) and y1 - y0 > 25:
            gw_curves.append(p)
        else:
            opt_lines.append(p)

    # rótulos de peso
    gw_words = [w for w in words if w[4] in GW_LABELS]
    assert len(set(w[4] for w in gw_words)) == len(gw_curves), (fig_no, sorted(w[4] for w in gw_words), len(gw_curves))
    # Pesos: as curvas não se cruzam, então a ordem de torque numa TAS comum é a ordem dos pesos.
    def tas_range(p):
        ys = [TAS(y) for x, y in p]
        return min(ys), max(ys)

    lo = max(tas_range(p)[0] for p in gw_curves)
    hi = min(tas_range(p)[1] for p in gw_curves)
    assert hi - lo > 10, ("no common TAS range", fig_no, lo, hi)
    ref = (lo + hi) / 2

    def tq_at(p, v):
        pts = sorted(((TAS(y), TQ(x)) for x, y in p))
        for (a0, b0), (a1, b1) in zip(pts, pts[1:]):
            if a0 <= v <= a1:
                return b0 + (b1 - b0) * (v - a0) / ((a1 - a0) or 1)
        raise AssertionError("ref out of range")

    order = sorted(range(len(gw_curves)), key=lambda j: tq_at(gw_curves[j], ref))
    gw_sorted = sorted(set(int(w[4]) for w in gw_words))
    lab_of = {j: gw_sorted[k] for k, j in enumerate(order)}
    # conferência: o rótulo de cada peso deve ficar perto da sua curva
    near_warn = []
    for w in gw_words:
        j = [jj for jj, g in lab_of.items() if g == int(w[4])][0]
        dist_own = point_poly_dist((cx(w), cy(w)), gw_curves[j])
        dist_min = min(point_poly_dist((cx(w), cy(w)), p) for p in gw_curves)
        if dist_own > dist_min + 1.5:
            near_warn.append((w[4], round(dist_own, 1), round(dist_min, 1)))
    curves = {}
    for j, p in enumerate(gw_curves):
        pts = [(TQ(x), TAS(y)) for x, y in p]
        if pts[0][1] > pts[-1][1]:
            pts = pts[::-1]
        # TAS precisa crescer ao longo da curva
        clean = [pts[0]]
        for q in pts[1:]:
            if q[1] > clean[-1][1] + 1e-6:
                clean.append(q)
            elif q[1] < clean[-1][1] - 0.15:
                raise AssertionError(("non monotonic TAS", fig_no, lab_of[j], q, clean[-1]))
        curves[lab_of[j]] = clean

    # ordem: na faixa comum de TAS, peso maior pede mais torque
    gws = sorted(curves)
    for a, b in zip(gws, gws[1:]):
        ta = curves[a]
        tb = curves[b]
        lo = max(ta[0][1], tb[0][1]) + 1
        hi = min(ta[-1][1], tb[-1][1]) - 1
        for v in [lo + (hi - lo) * k / 10 for k in range(11)]:
            assert interp_tq(ta, v) < interp_tq(tb, v) + 0.05, ("order", fig_no, a, b, v)

    # linhas de ótimo
    anchors = {}
    for key, w1, w2 in (("maxEnd", "MAX", "ENDURANCE"), ("maxRange", "MAX", "RANGE"), ("rec", "RECOMMENDED", None)):
        a, w = phrase_anchor(words, w1, w2)
        if a:
            anchors[key] = a

    # Candidatas: linhas que cruzam pelo menos uma curva de peso
    def hits_of(p):
        ext = extend(p)
        res = []
        for gw, c in curves.items():
            cp = [(TQx(t), TASy(v)) for t, v in c]
            h = poly_intersections(ext, cp)
            if h:
                res.append((gw, h))
        return res

    bucket = {}
    for gw, c in curves.items():
        tq_min = min(q[0] for q in c)
        bucket[gw] = [q for q in c if q[0] == tq_min][0][1]
    cands = []
    leftovers = []
    for p in opt_lines:
        hs = hits_of(p)
        if not hs:
            leftovers.append(p)
            continue
        tas_hits = []
        dev = []
        for gw, h in hs:
            v = TAS(sum(q[1] for q in h) / len(h))
            tas_hits.append(v)
            dev.append(abs(v - bucket[gw]))
        cands.append({"p": p, "n": len(hs), "tas": sum(tas_hits) / len(tas_hits), "dev": sum(dev) / len(dev)})
    lines = {}
    end_c = [c for c in cands if c["dev"] < 9]
    assert len(end_c) <= 1, ("maxEnd ambiguous", fig_no, [(round(c["dev"], 1), c["n"]) for c in end_c])
    if end_c:
        lines["maxEnd"] = end_c[0]["p"]
    up = sorted([c for c in cands if c["dev"] >= 9], key=lambda c: c["tas"])
    assert len(up) <= 2, ("too many upper lines", fig_no, len(up))
    if len(up) == 2:
        assert "maxRange" in anchors and "rec" in anchors, ("labels missing", fig_no, sorted(anchors))
        lines["maxRange"], lines["rec"] = up[0]["p"], up[1]["p"]
    elif len(up) == 1:
        p = up[0]["p"]
        d = {k: min(math.dist(a, p[0]), math.dist(a, p[-1])) for k, a in anchors.items() if k != "maxEnd"}
        assert d, ("no label for upper line", fig_no)
        lines[min(d, key=d.get)] = p
    # rótulo sem linha (ex.: MAX RANGE acima da VNE) fica registrado
    missing = [k for k in anchors if k not in lines]
    doc_pts = {}
    for key, p in lines.items():
        ext = extend(p)
        doc_pts[key] = {}
        for gw, c in curves.items():
            cp = [(TQx(t), TASy(v)) for t, v in c]
            hits = poly_intersections(ext, cp)
            if len(hits) == 1:
                x, y = hits[0]
                doc_pts[key][gw] = [round(TQ(x), 3), round(TAS(y), 3)]
            elif len(hits) > 1:
                spread = max(math.dist(a, b) for a in hits for b in hits)
                if spread > 2.0:
                    raise AssertionError(("multi hit", fig_no, key, gw, hits))
                x = sum(h[0] for h in hits) / len(hits)
                y = sum(h[1] for h in hits) / len(hits)
                doc_pts[key][gw] = [round(TQ(x), 3), round(TAS(y), 3)]

    out = {
        "fig": f"9-{fig_no}",
        "page": page,
        "pa": pa,
        "oat": oat,
        "ff": [[a, b] for a, b in ff],
        "ias": [[a, b] for a, b in ias_pairs],
        "dtq": None,
        "vne": round(TAS(vne[0][1]), 2) if vne else None,
        "mcp": round(TQ(mcp_x), 2),
        "top": round(TQ(top_x), 2),
        "curves": {str(k): v for k, v in curves.items()},
        "doc": doc_pts,
        "lines": {k: [[round(TQ(x), 3), round(TAS(y), 3)] for x, y in p] for k, p in lines.items()},
        "leftovers": [[[round(TQ(x), 2), round(TAS(y), 2)] for x, y in p] for p in leftovers],
        "_warn": near_warn,
        "_missing": missing,
        "_cal": {"tq": [tq_a, tq_b, tq_res], "tas": [tas_a, tas_b, tas_res], "frame": [fx0, fy0, fx1, fy1]},
    }
    # DTQ: zero na borda esquerda, mesmo passo do torque
    tq_left = TQ(fx0)
    dpts = sorted(((TAS(y), TQ(x) - tq_left) for x, y in dtq_pts), key=lambda q: q[0])
    out["dtq"] = [[round(a, 2), round(b, 3)] for a, b in dpts]
    return out


def interp_tq(curve, tas):
    if tas <= curve[0][1]:
        return curve[0][0]
    for i in range(1, len(curve)):
        if curve[i][1] >= tas:
            (t0, v0), (t1, v1) = curve[i - 1], curve[i]
            return t0 + (t1 - t0) * (tas - v0) / (v1 - v0)
    return curve[-1][0]


def main():
    src, dst = sys.argv[1], sys.argv[2]
    doc = pymupdf.open(src)
    charts = []
    fails = []
    for i in range(len(doc)):
        try:
            charts.append(extract_page(doc[i], i + 1))
        except AssertionError as e:
            fails.append((i + 1, str(e)[:300]))
            print("FAIL", i + 1, str(e)[:300])
            continue
        c = charts[-1]
        print(c["fig"], c["page"], c["pa"], c["oat"], "gw", sorted(int(k) for k in c["curves"]), "vne", c["vne"],
              "mcp", c["mcp"], "top", c["top"], "lines", sorted(c["lines"]), "left", len(c["leftovers"]),
              "doc", {k: len(v) for k, v in c["doc"].items()})
    with open(dst, "w") as f:
        json.dump(charts, f)
    print("fails", len(fails))


if __name__ == "__main__":
    main()
