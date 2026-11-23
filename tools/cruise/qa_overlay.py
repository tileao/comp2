"""Desenha por cima de cada carta o que foi extraído, para conferência visual.

Uso: python3 -I qa_overlay.py <cruise_aeo.pdf> <cruise_raw.json> <pasta_saida> [figs...]
"""
import json
import os
import sys

import pymupdf

COL = {
    "curve": (0.85, 0.1, 0.1),
    "maxEnd": (0.0, 0.55, 0.0),
    "maxRange": (0.0, 0.3, 0.95),
    "rec": (0.75, 0.0, 0.75),
    "left": (1.0, 0.5, 0.0),
    "lim": (0.0, 0.7, 0.8),
}


def main():
    src, js, outdir = sys.argv[1:4]
    only = set(sys.argv[4:])
    os.makedirs(outdir, exist_ok=True)
    charts = json.load(open(js))
    doc = pymupdf.open(src)
    for c in charts:
        n = int(c["fig"].split("-")[1])
        if only and c["fig"] not in only:
            continue
        pg = doc[n - 1]
        a, b, _ = c["_cal"]["tq"]
        cc, d, _ = c["_cal"]["tas"]
        fx0, fy0, fx1, fy1 = c["_cal"]["frame"]

        def P(tq, tas):
            return pymupdf.Point((tq - a) / b, (tas - cc) / d)

        sh = pg.new_shape()
        for gw, pts in c["curves"].items():
            sh.draw_polyline([P(*q) for q in pts])
            sh.finish(color=COL["curve"], width=0.5, closePath=False)
            q = pts[len(pts) // 3]
            pg.insert_text(P(q[0], q[1]) + (2, 0), gw, fontsize=4, color=COL["curve"])
        for key, pts in c["lines"].items():
            sh.draw_polyline([P(*q) for q in pts])
            sh.finish(color=COL[key], width=0.7, closePath=False)
        for p in c["leftovers"]:
            sh.draw_polyline([P(*q) for q in p])
            sh.finish(color=COL["left"], width=1.2, closePath=False)
        for key, pts in c["doc"].items():
            for gw, (tq, tas) in pts.items():
                sh.draw_circle(P(tq, tas), 1.1)
                sh.finish(color=COL[key], fill=COL[key])
        if c["vne"]:
            sh.draw_line(P(30, c["vne"]), P(110, c["vne"]))
            sh.finish(color=COL["lim"], width=0.4, dashes="[1 1] 0")
        for t in (c["mcp"], c["top"]):
            sh.draw_line(P(t, 5), P(t, 170))
            sh.finish(color=COL["lim"], width=0.4, dashes="[1 1] 0")
        # escala de consumo: marca e valor calculado
        for tq, ff in c["ff"]:
            p = P(tq, 0)
            p = pymupdf.Point(p.x, fy0)
            sh.draw_line(p, p + (0, 4))
            sh.finish(color=(0.9, 0.3, 0), width=0.4)
            pg.insert_text(p + (-3, 8), f"{ff:g}", fontsize=3, color=(0.9, 0.3, 0))
        for tas, ias in c["ias"]:
            p = P(0, tas)
            p = pymupdf.Point(fx1, p.y)
            sh.draw_line(p, p + (-4, 0))
            sh.finish(color=(0.9, 0.3, 0), width=0.4)
            pg.insert_text(p + (-14, 1), f"{ias:g}", fontsize=3, color=(0.9, 0.3, 0))
        # DTQ
        if c["dtq"]:
            tq_left = a + b * fx0
            sh.draw_polyline([P(tq_left + v, t) for t, v in c["dtq"][::20]])
            sh.finish(color=(0.5, 0.2, 0.9), width=0.5, closePath=False)
        sh.commit()
        pix = pg.get_pixmap(matrix=pymupdf.Matrix(2.6, 2.6), clip=pymupdf.Rect(fx0 - 30, fy0 - 30, fx1 + 30, fy1 + 25))
        pix.save(os.path.join(outdir, f"qa_{n:02d}.png"))


if __name__ == "__main__":
    main()
