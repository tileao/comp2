# Cartas de cruzeiro do RFM → `combustivel/cruise-data.js`

Os gráficos Cruise AEO da Seção 9 do RFM são vetoriais no PDF; os scripts leem as linhas e os textos da página, sem leitura visual.

1. Separe as 55 páginas das Figuras 9-1 a 9-55 (no RFM I2 R32 completo, páginas 4215 a 4269 do PDF) num PDF à parte, por exemplo com PyMuPDF.
2. `python3 -I extract_cruise.py cruise_aeo.pdf cruise_raw.json` — calibra os eixos de torque, TAS, IAS e consumo pelos traços e rótulos; separa as curvas de peso, VNE, MCP, TOP, DTQ e as linhas de Max Endurance, Max Range Cruise e Recommended Cruise; calcula a interseção dessas linhas com cada curva de peso.
3. `python3 -I qa_overlay.py cruise_aeo.pdf cruise_raw.json qa/` — desenha o que foi extraído por cima de cada carta para conferência.
4. `python3 -I check_lines.py cruise_raw.json` — compara as linhas desenhadas com o ótimo calculado das curvas.
5. `python3 -I build_data.py cruise_raw.json ../../combustivel/cruise-data.js` — gera o arquivo do app.
6. `node test_engine.js` — testes do motor (exemplos do RFM e tabelas do QRH).

Quando a linha de ótimo da carta não cruza uma curva de peso, o valor fica marcado no arquivo: limitado pela VNE/MCP (`v`/`m`) ou calculado com o desvio do peso vizinho (`O`).
