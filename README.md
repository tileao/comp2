# AW139 Companion — Integração v1

Primeira integração de casca entre os módulos WAT, RTO/CTO e ADC.

## Estrutura
- `/wat` → módulo WAT original
- `/rto` → módulo RTO/CTO original
- `/adc` → módulo ADC original
- `/shared/module-bridge.js` → contexto compartilhado via `localStorage`

## O que esta integração já faz
- Home única para abrir os módulos
- Contexto compartilhado entre WAT e RTO: PA, OAT, peso e vento
- RTO salva o valor final em metros no contexto
- ADC lê automaticamente RTO/CTO do contexto

## Próximo nível
- integração nativa dos cálculos em uma UI comum
- fluxo composto Cat A Clear Area
- ADC recebendo RTO/CTO automaticamente sem botão manual

## Combustível (`/combustivel`)
Fluxo de cruzeiro AEO: consumo em lb e kg, best range, best endurance, recommended cruise e sugestão de subir ou descer.

- **Fonte:** RFM 139G0290X002 Issue 2 Rev. 32 (03/03/2026), Seção 9, Figuras 9-1 a 9-55 (Cruise AEO, clean configuration, NR 100 %, 600 A). Dados em `combustivel/cruise-data.js`, extraídos por vetor do PDF (`tools/cruise/`).
- **Interpolação:** como no exemplo da p. 9-3: primeiro OAT (mesma PA), depois PA; entre curvas de peso, linear no peso.
- **Best range, best endurance e recommended:** linhas desenhadas na carta (Max Range Cruise, Max Endurance, Recommended Cruise). Com vento, a velocidade de best range é deslocada pelo deslocamento do ótimo de GS/consumo calculado na curva (raciocínio sobre a carta, não é dado do RFM).
- **IAS atual e TAS fixa:** quando a velocidade passa da ponta da curva numa carta vizinha (a carta quente para na MCP dela), a curva dessa carta é prolongada por uma parábola dos últimos 25 kt (testado nas próprias cartas: erro médio de 0,2 % TQ em 10 kt, 0,8 % em 20 kt, 1,7 % em 30 kt). O limite que vale é a MCP interpolada na condição real; acima dela o app mostra a IAS máxima.
- **Correções:** equipamento externo pela Tabela 9-1 (CF × DTQ); IBF +3,5 % no consumo (Supl. 86).
- **Reserva:** padrão de 30 min no consumo a 150 KTAS (OM-A 11.1.7; OM-C 4.1.5). Pode ser outro valor ou nenhuma.
- **Limites:** só 4.400 a 6.800 kg (não há carta de cruzeiro para 7.000 kg); OAT e PA dentro das cartas; não inclui subida, descida nem sangramento de ar. O fuel flow indicado do motor não serve para planejamento (RFM Seção 1).
- **Testes:** `node tools/cruise/test_engine.js` confere com os exemplos do RFM (p. 9-3, 9-5, 9-6) e com as tabelas FUEL CONSUMPTION do QRH I02 R31 (6.400 kg: erro médio 0,6 kg/h).

## Rota (teste, `/rota`)
Página de teste, sem link na Home. A rota é digitada como no FMS (ex.: `SBJR DIBIL KZ208 ITEKI 9PMO`); o app busca o vento e a temperatura previstos por nível e mostra o melhor nível na ida e na volta, com combustível e tempo.

- **Base:** `rota/nav-data.js`, só de fontes públicas: bases (AIP Brasil / ROTAER), UM (portarias da ANAC no DOU) e Bacia de Santos (CIRCEA 100-109 e Carta Especial de 28 NOV 24: pontos e aerovias KZ, de mão única). Gerada por `tools/rota/build_nav.py`. Bacia de Campos: por enquanto só a UM, sem aerovias.
- **Níveis:** na Bacia de Santos, os da CIRCEA 100-109 (2.4.3): ida FL025, FL045, FL065 e FL085; volta FL035, FL055, FL075 e FL095. Fora dela, 1000 a 8000 ft com o QNH.
- **Vento:** previsão de modelo do Open-Meteo nos níveis de 1000 a 700 hPa, interpolada no tempo e em ln p, um ponto a cada ~30 NM. Não é produto oficial: conferir na REDEMET. A última resposta fica guardada para uso sem rede.
- **Consumo:** o motor do fluxo Combustível em cada perna, com o vento e a OAT do nível; best range ou 150 KTAS. Na UM, 9 lb/min em FLIGHT (OM-B I01 R00, 0.21). Não inclui partida e táxi, subida e descida, alternativa nem contingência.
- **Testes:** `node tools/rota/test_rota.js`.

