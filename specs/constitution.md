# Constitución del proyecto

Reglas que ninguna spec, plan ni agente puede saltarse. Cambiarlas requiere un ADR.

## Principios

1. **Documentar antes de ejecutar.** Ningún ticket se implementa sin una spec aprobada por el humano.
2. **Linear es la fuente de verdad del avance.** El repo es la fuente de verdad de specs, decisiones y código.
3. **Especialistas a demanda.** Cada ticket lo ejecuta el perfil más específico posible, definido por `hr-director`.
4. **Mínimo privilegio.** Cada agente recibe solo las herramientas que su ticket necesita.
5. **Humano en las compuertas.** El humano aprueba specs, agentes nuevos (la primera vez) y merges a `main`.
6. **Neutral al harness.** Nada depende de un solo harness; las instrucciones viven en `AGENTS.md` y `agents/`.

## Restricciones actuales

- Suscripción de IA: solo Claude Pro, usada desde Claude Code. Sin API keys.
- Un agente ejecutor a la vez, para no agotar la cuota.
- Herramientas de pago: solo Claude Pro y GitHub Pro. Linear en plan gratis.

## Definición de terminado (todo ticket)

- Cumple los criterios de aceptación del ticket.
- Tiene verificación descrita (test, comando o captura).
- PR abierto contra `main` y comentario de cierre en Linear.
