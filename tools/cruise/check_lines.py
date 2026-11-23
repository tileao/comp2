"""Compara as linhas de ótimo desenhadas no RFM com o ótimo calculado das curvas.

Uso: python3 -I check_lines.py <cruise_raw.json>
"""
import json
import sys


def interp(xy, x):
    """Interpolação linear numa tabela [[x, y], ...] crescente em x (sem extrapolar)."""
    if x < xy[0][0] - 1e-9 or x > xy[-1][0] + 1e-9:
        return None
    for (x0, y0), (x1, y1) in zip(xy, xy[1:]):
        if x0 <= x <= x1:
            return y0 if x1 == x0 else y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return xy[-1][1]


def ff_tq(c, tq):
    return interp(c["ff"], tq)


def curve_tas_tq(curve):
    return [[q[1], q[0]] for q in curve]  # (TAS, TQ)


def scan(c, curve, hw=0.0, step=0.1):
    ct = curve_tas_tq(curve)
    lo, hi = ct[0][0], ct[-1][0]
    pts = []
    v = lo
    while v <= hi + 1e-9:
        tq = interp(ct, v)
        ff = ff_tq(c, tq)
        if ff:
            pts.append((v, tq, ff))
        v += step
    return pts


def optimums(c, curve, hw=0.0):
    pts = scan(c, curve, hw)
    end = min(pts, key=lambda p: p[2])
    sr = [((p[0] - hw) / p[2], p) for p in pts if p[0] >= end[0]]
    srmax, rng = max(sr, key=lambda s: s[0])
    rec = None
    for s, p in sr:
        if p[0] > rng[0] and s <= 0.99 * srmax:
            rec = p
            break
    return end, rng, rec, srmax


def main():
    charts = json.load(open(sys.argv[1]))
    stats = {"maxEnd": [], "maxRange": [], "rec": []}
    for c in charts:
        for gw, curve in c["curves"].items():
            end, rng, rec, srmax = optimums(c, curve)
            for key, comp in (("maxEnd", end), ("maxRange", rng), ("rec", rec)):
                d = c["doc"].get(key, {}).get(gw)
                if not d or not comp:
                    continue
                tq_d, tas_d = d
                ff_d = ff_tq(c, tq_d)
                sr_d = tas_d / ff_d if ff_d else None
                rel = sr_d / srmax if sr_d else None
                stats[key].append((c["fig"], gw, round(tas_d - comp[0], 1), round(tq_d - comp[1], 2),
                                   round(ff_d - comp[2], 1) if ff_d else None, round(rel, 4) if rel else None))
    for key, rows in stats.items():
        dt = [abs(r[2]) for r in rows]
        print(key, "n", len(rows), "max|dTAS|", max(dt), "mean|dTAS|", round(sum(dt) / len(dt), 2))
        if key != "maxEnd":
            rels = [r[5] for r in rows if r[5]]
            print("   SR(doc)/SRmax: min", min(rels), "max", max(rels))
        worst = sorted(rows, key=lambda r: -abs(r[2]))[:8]
        for r in worst:
            print("   ", r)


if __name__ == "__main__":
    main()
