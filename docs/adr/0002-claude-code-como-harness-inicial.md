# 0002. Claude Code como harness inicial, diseño neutral al harness

- Estado: Aceptado
- Fecha: 2026-10-29
- Decide: humano

## Contexto

La única suscripción de IA disponible es Claude Pro. Anthropic no permite usar el login de
Pro/Max en harness de terceros como OpenCode, que con Claude solo funciona por API key.
A futuro se quieren sumar otros harness y suscripciones.

## Decisión

Ejecutar todos los agentes en Claude Code con la suscripción Claude Pro. Mantener las instrucciones
en `AGENTS.md` y las definiciones de agentes en `agents/`, con un script que las copia al formato
de cada harness (`.claude/agents/` hoy).

## Alternativas consideradas

- **OpenCode + API key:** más flexible; costo variable por token, fuera del presupuesto actual.
- **OpenCode + Copilot:** no hay Copilot Pro disponible; Copilot Free no alcanza.

## Consecuencias

- Cuota limitada: un agente ejecutor a la vez.
- Sumar un harness = escribir su adaptador en `scripts/sync-agents.ps1`, sin tocar los agentes.
