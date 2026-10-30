# Roster

Orquestación de agentes asíncronos: un Project Manager, un Director de RRHH que contrata
especialistas a demanda, y Linear como fuente de verdad. Diseño en
[Sistema de orquestación de agentes asíncronos](https://claude.ai/artifact/1KXrNH9rHu6qPCGCqeEaMd).

## Estructura

| Ruta | Qué es |
| --- | --- |
| `AGENTS.md` | Reglas para todo agente (neutral al harness) |
| `CLAUDE.md` | Importa `AGENTS.md` para Claude Code |
| `.mcp.json` | Servidor MCP oficial de Linear |
| `specs/constitution.md` | Reglas fijas del proyecto |
| `specs/<feature>/` | `spec.md`, `plan.md`, `tasks.md` de cada feature |
| `docs/adr/` | Architecture Decision Records (MADR) |
| `agents/` | Definiciones neutrales de agentes |
| `scripts/sync-agents.ps1` | Copia `agents/` a `.claude/agents/` |

## Puesta en marcha (Fase 1)

1. Crea un workspace gratis en Linear con estados Backlog, Todo, In Progress, In Review, Blocked, Done,
   y labels `agent:*` y `needs-human`.
2. Abre Claude Code en esta carpeta y aprueba el servidor `linear` de `.mcp.json`; inicia sesión por OAuth con `/mcp`.
3. Corre `scripts/sync-agents.ps1` y reinicia la sesión para cargar los agentes.
4. Escribe tu primera spec en `specs/<feature>/spec.md`, apruébala, y pide al agente `architect` el plan.
