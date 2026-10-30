# 0001. Linear como fuente de verdad del avance

- Estado: Aceptado
- Fecha: 2026-10-29
- Decide: humano

## Contexto

Los agentes trabajan de forma asíncrona y sin el humano presente. Hace falta un lugar donde
el humano vea, corrija y priorice el trabajo, sin construir un tracker propio.

## Decisión

Usar Linear (plan gratis) como única fuente de verdad del estado del trabajo, accedido por su
servidor MCP oficial. Los agentes no se comunican entre sí directamente: lo hacen por tickets y comentarios.

## Alternativas consideradas

- **GitHub Issues + Projects:** ya incluido en GitHub Pro; peor flujo de estados y dependencias.
- **Tracker propio en archivos:** cero dependencias; reinventa la rueda y no tiene UI.

## Consecuencias

- El humano sigue todo desde Linear, también desde el celular.
- El plan gratis tiene tope de issues: archivar tickets Done.
- Si Linear cambia sus condiciones, migrar a GitHub Issues requiere un ADR nuevo.
