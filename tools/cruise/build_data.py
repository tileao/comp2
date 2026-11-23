"""Gera combustivel/cruise-data.js a partir do JSON extraído das cartas.

Uso: python3 -I build_data.py <cruise_raw.json> <saida.js>
"""
import json
import math
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from check_lines import ff_tq, interp, optimums  # noqa: E402


def dp(points, eps):
    """Douglas-Peucker em (TQ, TAS); mesma escala nos dois eixos (1 % TQ ≈ 1 kt no papel)."""
    if len(points) < 3:
        return points
    (x1, y1), (x2, y2) = points[0], points[-1]
    dx, dy = x2 - x1, y2 - y1
    L = math.hypot(dx, dy) or 1e-9
    best, idx = -1, 0
    for i in range(1, len(points) - 1):
        x0, y0 = points[i]
        d = abs(dy * x0 - dx * y0 + x2 * y1 - y2 * x1) / L
        if d > best:
            best, idx = d, i
    if best <= eps:
        return [points[0], points[-1]]
    a = dp(points[: idx + 1], eps)
    b = dp(points[idx:], eps)
    return a[:-1] + b


def limit_of(c, curve):
    tq, tas = curve[-1]
    if c["vne"] and abs(tas - c["vne"]) < 0.8:
        return "v"
    if abs(tq - c["mcp"]) < 0.8:
        return "m"
    if abs(tq - c["top"]) < 0.8:
        return "t"
    return "?"


def main():
    raw = json.load(open(sys.argv[1]))
    out = []
    n_pts = 0
    report = {"line": 0, "offset": 0, "limit": 0, "computed": 0}
    for c in raw:
        ch = {
            "fig": c["fig"],
            "pg": c["page"],
            "pa": c["pa"],
            "oat": c["oat"],
            "vne": c["vne"],
            "mcp": c["mcp"],
            "top": c["top"],
            "ff": [[round(a, 2), round(b, 1)] for a, b in c["ff"]],
            "ias": [[round(a, 2), b] for a, b in c["ias"]],
        }
        # DTQ a cada 10 kt (a linha tracejada vem com centenas de vértices)
        dt = c["dtq"]
        tmax = dt[-1][0]
        ch["dtq"] = [[v, round(interp(dt, v), 2)] for v in range(0, int(tmax) + 1, 10) if interp(dt, v) is not None]
        curves = {}
        for gw, cur in c["curves"].items():
            simp = dp([(q[0], q[1]) for q in cur], 0.06)
            curves[gw] = [[round(q[1], 1), round(q[0], 2)] for q in simp]  # [TAS, TQ]
            n_pts += len(simp)
        ch["gw"] = curves
        # Velocidades de ótimo por peso (TAS) e a origem do valor
        opt = {"e": {}, "r": {}, "c": {}}
        comp = {gw: optimums(c, cur) for gw, cur in c["curves"].items()}
        keymap = {"e": "maxEnd", "r": "maxRange", "c": "rec"}
        for k, key in keymap.items():
            doc = c["doc"].get(key, {})
            for gw, cur in c["curves"].items():
                end, rng, rec, srmax = comp[gw]
                cmp_pt = {"e": end, "r": rng, "c": rec}[k]
                t_end = cur[-1][1]
                if gw in doc:
                    opt[k][gw] = [round(doc[gw][1], 2), "L"]
                    report["line"] += 1
                    continue
                if k == "e":
                    opt[k][gw] = [round(end[0], 2), "C"]
                    report["computed"] += 1
                    continue
                lim = limit_of(c, cur)
                if cmp_pt is None or cmp_pt[0] >= t_end - 1.0:
                    opt[k][gw] = [round(t_end, 2), lim]
                    report["limit"] += 1
                    continue
                # offset do peso vizinho que tem a linha desenhada
                near = sorted(doc, key=lambda g: abs(int(g) - int(gw)))
                if near:
                    g = near[0]
                    e2, r2, c2, _ = comp[g]
                    cp2 = {"r": r2, "c": c2}[k]
                    off = doc[g][1] - cp2[0] if cp2 else 0.0
                else:
                    off = 0.0
                v = cmp_pt[0] + off
                if v >= t_end - 0.05:
                    opt[k][gw] = [round(t_end, 2), lim]
                    report["limit"] += 1
                else:
                    opt[k][gw] = [round(max(v, end[0]), 2), "O"]
                    report["offset"] += 1
        ch["opt"] = opt
        out.append(ch)
    meta = {
        "source": "RFM AW139 139G0290X002 Issue 2 Rev. 32 (03-03-2026), Seção 9, Figuras 9-1 a 9-55 (Cruise AEO, clean configuration, NR 100 %, carga elétrica 600 A)",
        "method": "Extração vetorial do PDF; curvas simplificadas (Douglas-Peucker, 0,06); validação contra os exemplos da p. 9-3/9-5/9-6 e as tabelas FUEL CONSUMPTION do QRH (Lims-Norm-Perf p. 90 e 92).",
        "opt_flags": {"L": "linha da carta", "O": "linha da carta ausente neste peso: ótimo calculado + desvio do peso vizinho", "C": "calculado (mínimo de torque)", "v": "limitado pela VNE", "m": "limitado pela MCP", "t": "limitado pelo TOP", "?": "fim da curva"},
    }
    js = "/* Gerado por scripts/build_data.py — não editar à mão.\n" \
         " * Fonte: " + meta["source"] + "\n" \
         " * " + meta["method"] + "\n */\n" \
         "window.AW139_CRUISE = " + json.dumps({"meta": meta, "charts": out}, ensure_ascii=False, separators=(",", ":")) + ";\n"
    open(sys.argv[2], "w").write(js)
    print("points", n_pts, "bytes", len(js), report)


if __name__ == "__main__":
    main()
