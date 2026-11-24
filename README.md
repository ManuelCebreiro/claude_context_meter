# Claude Context Meter

Muestra en la barra de estado de VS Code:

- **Contexto actual** de la sesión de Claude Code (tokens que se reenvían en cada consulta) y su % sobre la ventana del modelo. Se pone amarillo al 60 % y rojo al 80 %.
- **Sesión**: número de preguntas, tokens procesados y coste equivalente de la API.

Al hacer clic se abre un panel con:

- **Sesión actual**: gráfica del contexto que arrastra cada pregunta y tabla pregunta a pregunta (contexto al empezar/terminar, llamadas, salida, tokens, coste).
- **Histórico**: hoy / 7 días / 30 días / total, tokens por día y todas las sesiones anteriores (clic para ver el detalle).

## Cómo funciona

Lee los transcripts que Claude Code ya guarda en `~/.claude/projects/**/*.jsonl`. No usa red, no instala hooks y no modifica `~/.claude/settings.json`.
Guarda un resumen de cada sesión en el almacenamiento propio de la extensión, así el histórico se conserva aunque Claude Code borre los transcripts antiguos (por defecto a los 30 días; se puede ampliar con `"cleanupPeriodDays"` en `~/.claude/settings.json`).

## Notas

- "Tokens procesados" incluye las relecturas de caché, que son la mayor parte del volumen en sesiones largas.
- El coste es una estimación con los precios públicos de la API; con un plan Pro/Max no es lo que pagas.
