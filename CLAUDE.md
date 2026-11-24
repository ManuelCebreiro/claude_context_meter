# Claude Context Meter

Extensión de VS Code (JavaScript puro, sin dependencias ni compilación) que muestra en la barra de estado el consumo de Claude Code leyendo sus transcripts locales (`~/.claude/projects/**/*.jsonl`).

## Flujo (de principio a fin)
1. `src/extension.js` → `activate()` crea 3 items de barra de estado y un temporizador (`claudeMeter.pollMs`).
2. Cada tick:
   - `P.readClaudeEnv()` lee (solo lectura) `~/.claude/settings.json` y los settings del proyecto para saber si el 1M está desactivado o hay un modelo `[1m]`.
   - `P.findActiveSession()` busca el transcript más reciente cuyo `cwd` coincide con la carpeta abierta.
   - `IncrementalReader` lee solo los bytes nuevos → `SessionState.feedLine()` acumula llamadas (deduplicadas por `message.id`) y preguntas.
   - `SessionState.summary()` calcula contexto actual, pico, totales, coste y el desglose por pregunta → `render()` pinta la barra.
   - `tickBlocks()` → `src/blocks.js` (`LiveBlocks`) suma todas las llamadas de las últimas horas de todos los proyectos y calcula el bloque de 5 h actual.
3. Panel (`claudeMeter.openPanel`): webview con `media/panel.js` + `media/panel.css`; recibe datos por `postMessage` (`live`, `history`, `blocks`, `detail`).
4. Histórico: `scanHistory()` guarda un resumen de cada sesión en `globalStorage/history.json`; `scanBlocksBackground()` guarda los bloques de 5 h en `globalStorage/blocks.json`. Así sobreviven aunque Claude Code borre transcripts antiguos.

## Reglas importantes
- Nunca escribir en `~/.claude/` (ni settings ni hooks). Sin red.
- Contexto = `input + cache_creation + cache_read` de la última llamada del hilo principal (igual que Claude Code; sin output).
- Ventana de contexto (`contextWindowFor` en `src/parser.js`), según la documentación de Claude Code: 1M por defecto en Fable 5+, Mythos 5+, Sonnet 5+, Haiku 5.5 y Opus 4.7+; Opus/Sonnet 4.6 solo con `[1m]`; el resto 200K; `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` fuerza 200K.
- Precios en `PRICES` (`src/parser.js`), USD por millón: [input, output, cacheWrite5m, cacheWrite1h, cacheRead].
- El bloque de 5 h es una estimación local; no es el % oficial del plan.

## Probar y empaquetar
- Tests: `npm test` (node:test, sin dependencias; usan carpetas temporales, nunca `~/.claude`).
- F5 → abre una ventana "Extension Development Host" con la extensión cargada.
- Empaquetar: `npx @vscode/vsce package --allow-missing-repository --no-dependencies` → genera el `.vsix`.
- Instalar el `.vsix`: `code --install-extension claude-context-meter-<versión>.vsix`.
