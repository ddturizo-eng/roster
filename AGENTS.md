# Roster — instrucciones para agentes

Sistema de orquestación de agentes asíncronos. Un Project Manager parte objetivos en tickets de Linear,
un Director de RRHH contrata especialistas a demanda, y cada especialista ejecuta y reporta en su ticket.

Este archivo es neutral al harness. Claude Code lo lee vía `CLAUDE.md`; OpenCode lo lee directo.

## Fuentes de verdad

- **Estado del trabajo:** Linear (servidor MCP `linear`). Nada se da por hecho si no está en un ticket.
- **Qué construir:** `specs/<feature>/spec.md`, aprobada por el humano.
- **Cómo y por qué:** `specs/<feature>/plan.md` y `docs/adr/`.
- **Reglas fijas:** `specs/constitution.md`.

## Reglas para todo agente

1. Antes de trabajar, lee `specs/constitution.md`, los ADRs de `docs/adr/` y tu ticket completo.
2. No contradigas un ADR aceptado. Si hace falta cambiarlo, pide al agente `architect` un ADR nuevo que lo reemplace.
3. Trabaja solo en el alcance de tu ticket. Lo que encuentres fuera, déjalo como comentario o ticket nuevo.
4. Nunca hagas push a `main`. Trabaja en una rama `agent/<id-del-ticket>` y abre PR.
5. Nunca uses credenciales de producción, pagos ni datos personales. Esos tickets llevan `needs-human`.
6. Si el ticket es ambiguo, pregunta en un comentario y muévelo a Blocked. No adivines.
7. Al terminar, comenta en el ticket: qué hiciste, cómo lo verificaste, link al PR. Mueve el estado a In Review.

## Flujo SDD

constitution → spec (aprobada) → plan + ADRs → tasks → tickets en Linear → implementación → PR → revisión humana.

## Roles base

| Agente | Archivo | Hace | Nunca hace |
| --- | --- | --- | --- |
| project-manager | `agents/project-manager.md` | Convierte `tasks.md` en tickets y sigue el avance | Escribir código |
| hr-director | `agents/hr-director.md` | Elige y define el especialista de cada ticket | Ejecutar el ticket |
| architect | `agents/architect.md` | Escribe `plan.md` y los ADRs | Implementar |

## Agentes contratados

- La definición neutral vive en `agents/<slug>.md`. Es la única que se edita a mano.
- Después de que `hr-director` cree o cambie un agente, corre `scripts/sync-agents.ps1` para copiarlo a `.claude/agents/`.
- Claude Code carga los agentes nuevos al iniciar sesión. En la misma sesión, usa el contenido del `.md` como prompt de un subagente general.
