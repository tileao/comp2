"""Gera rota/nav-data.js com a base pública do plano de rota.

Uso: python3 -I build_nav.py <pasta com bases.json, plataformas.json e bacia_santos.json> <saida.js>

Fontes (as mesmas dos arquivos da IOS do treinador):
- bases.json: ponto de referência dos aeródromos (AIP/ROTAER);
- plataformas.json: posição do heliponto das UM, das portarias da ANAC no Diário Oficial;
- bacia_santos.json: CIRCEA 100-109 (setores, níveis, regras) e Carta Especial da Bacia de Santos de 28 NOV 24
  (pontos e aerovias KZ).
A base da Navigraph do treinador não entra aqui (assinatura pessoal).
"""
import json
import re
import sys


def dms(s):
    """'25 01 23 S', '23 12.18 S', '042 40 04 W' ou número decimal → graus decimais."""
    if isinstance(s, (int, float)):
        return float(s)
    m = re.fullmatch(r"\s*(\d+)\s+(\d+(?:\.\d+)?)(?:\s+(\d+(?:\.\d+)?))?\s*([NSEW])\s*", s)
    assert m, s
    d, mi, se, h = m.groups()
    v = int(d) + float(mi) / 60 + (float(se) / 3600 if se else 0)
    return -v if h in "SW" else v


def main():
    src, dst = sys.argv[1], sys.argv[2]
    bases = json.load(open(f"{src}/bases.json"))["bases"]
    pl = json.load(open(f"{src}/plataformas.json"))
    bs = json.load(open(f"{src}/bacia_santos.json"))
    pts = {}

    def add(pid, lat, lon, kind, **extra):
        assert pid not in pts, pid
        pts[pid] = {"lat": round(dms(lat), 6), "lon": round(dms(lon), 6), "k": kind, **extra}

    for b in bases:
        add(b["id"], b["lat"], b["lon"], "base", nome=b["nome"])
    for u in pl["plataformas"]:
        add(u["id"], u["lat"], u["lon"], "um", nome=u["nome"], bacia=u["bacia"], fonte=u.get("fonte", ""))
    for p in bs["pontos"]:
        extra = {"tipo": p["tipo"]}
        if p.get("compulsorio"):
            extra["comp"] = True
        add(p["id"], p["lat"], p["lon"], "santos", **extra)
    awy = {a["id"]: {"sentido": a["sentido"], "pts": a["pontos"]} for a in bs["aerovias"]}
    for a in awy.values():
        for x in a["pts"]:
            assert x in pts, x
    setores = [{"id": s["id"], "nome": s["nome"], "piso": s.get("piso"), "teto": s.get("teto"),
                "poly": [[round(dms(a), 5), round(dms(b), 5)] for a, b in s["poligono"]]} for s in bs["setores"]]
    area = [[round(dms(a), 5), round(dms(b), 5)] for a, b in bs["espaco_offshore"]["poligono"]]
    out = {
        "meta": {
            "fontes": [
                "Bases: ponto de referência do aeródromo (AIP Brasil / ROTAER).",
                "UM: posição do heliponto pelas portarias da ANAC no Diário Oficial (campo fonte de cada UM).",
                bs["fontes"]["circea"],
                bs["fontes"]["carta"],
            ],
            "nota": "Base pública do plano de rota. Sem a base da Navigraph do treinador (assinatura pessoal).",
        },
        "pts": pts,
        "awy": awy,
        "santos": {"niveis": bs["niveis"], "regras": bs["regras"], "setores": setores, "area": area,
                   "espaco": {k: bs["espaco_offshore"][k] for k in ("nome", "piso", "teto", "classe", "fir")}},
    }
    js = ("/* Gerado por tools/rota/build_nav.py — não editar à mão.\n"
          " * Base pública do plano de rota: bases, UM (ANAC/DOU) e Bacia de Santos (CIRCEA 100-109 e Carta Especial).\n */\n"
          "window.AW139_NAV = " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n")
    open(dst, "w").write(js)
    print("pontos", len(pts), "aerovias", len(awy), "bytes", len(js))


if __name__ == "__main__":
    main()
