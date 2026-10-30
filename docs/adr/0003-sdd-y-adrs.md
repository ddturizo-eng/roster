# 0003. Spec-Driven Development con ADRs

- Estado: Aceptado
- Fecha: 2026-10-29
- Decide: humano

## Contexto

Los especialistas se "contratan por minutos" y no conocen la historia del proyecto. Sin un
registro escrito, cada uno vuelve a discutir decisiones y el trabajo se desvía de la intención.

## Decisión

Seguir el flujo constitution → spec → plan + ADRs → tasks → tickets → implementación.
Las specs viven en `specs/<feature>/`; las decisiones técnicas en `docs/adr/` con formato MADR.
Ningún ticket se implementa sin spec aprobada por el humano.

## Alternativas consideradas

- **Tickets directos sin spec:** más rápido al inicio; los agentes adivinan la intención.
- **GitHub Spec Kit u OpenSpec como herramienta:** compatible; se puede adoptar después sin cambiar la estructura.

## Consecuencias

- Más trabajo de documentación al inicio de cada feature.
- Cualquier agente nuevo tiene el contexto completo leyendo el repo.
