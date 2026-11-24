# Claude Context Meter

Extensión de VS Code (JavaScript puro, sin dependencias ni compilación) que muestra en la barra de estado el consumo de Claude Code leyendo sus transcripts locales (`~/.claude/projects/**/*.jsonl`).

## Flujo (de principio a fin)
1. `src/extension.js` → `activate()` crea 3 items de barra de estado y un temporizador (`claudeMeter.pollMs`).
2. Cada tick (`tick()` es asíncrono y no se solapa consigo mismo):
   - `P.readClaudeEnv()` lee (solo lectura) `~/.claude/settings.json` y los settings del proyecto para saber si el 1M está desactivado o hay un modelo `[1m]`.
   - `P.findActiveSession()` busca el transcript más reciente cuyo `cwd` coincide con la carpeta abierta. Plan A: solo la carpeta de `~/.claude/projects` de la carpeta abierta; plan B (subcarpetas, todos los proyectos) como mucho cada 30 s. El `cwd` de cada archivo se cachea.
   - `IncrementalReader` (asíncrono, por trozos de 1 MB) lee solo los bytes nuevos → `SessionState.feedLine()` acumula llamadas (deduplicadas por `message.id`) y preguntas.
   - `SessionState.summary()` calcula contexto actual, pico, totales, coste y el desglose por pregunta → `render()` pinta la barra.
   - `pollBlocks()` → `src/blocks.js` (`LiveBlocks`) lee lo nuevo de los transcripts de las últimas 10 h y `showBlocks()` pinta el bloque de 5 h actual (alineado con `anchor`, el inicio del último bloque del escaneo completo).
3. Vista "Claude Meter" (`claudeMeter.view`, `media/view.js` + `media/view.css`): webview view registrada en el contenedor `claude-sidebar-secondary` de la extensión de Claude Code, así aparece debajo de su chat (si Claude Code no está instalado, VS Code la pone en el Explorador). `render()` y `showBlocks()` llaman a `updateView()`, que envía un único mensaje `state` con lo justo (`slimLive`). La barra de estado usa textos cortos y `claudeMeter.statusBar` (`all` / `context` / `none`).
4. Panel (`claudeMeter.openPanel`): webview con `media/panel.js` + `media/panel.css`; recibe datos por `postMessage` (`config`, `live`, `history`, `blocks`, `detail`).
5. Histórico: `scanHistory()` guarda un resumen de cada sesión en `globalStorage/history.json`; `scanBlocksBackground()` (cada hora) guarda los bloques de 5 h en `globalStorage/blocks.json`. Así sobreviven aunque Claude Code borre transcripts antiguos. El escaneo de bloques usa el mismo `CallStore` que `LiveBlocks`: solo lee lo que ha cambiado desde la vez anterior.
6. Bloque de 5 h: `tokens` (total) y `freshTokens` (sin caché leída). El % de tu máximo, el ritmo y la proyección usan `freshTokens`.

## Reglas importantes
- Nunca escribir en `~/.claude/` (ni settings ni hooks). Sin red.
- Nada síncrono en `src/` (ni `fs.*Sync`): la extensión comparte proceso con las demás y no debe bloquear VS Code. Las lecturas van por `IncrementalReader` (trozos de 1 MB) o `fs.promises`.
- `claudeMeter.saveToDisk` (por defecto activado): si está desactivado no se escribe `history.json` ni `blocks.json`; lo existente se sigue leyendo y no se borra.
- Contexto = `input + cache_creation + cache_read` de la última llamada del hilo principal (igual que Claude Code; sin output).
- Ventana de contexto (`contextWindowFor` en `src/parser.js`), según la documentación de Claude Code: 1M por defecto en Fable 5+, Mythos 5+, Sonnet 5+, Haiku 5.5 y Opus 4.7+; Opus/Sonnet 4.6 solo con `[1m]`; el resto 200K; `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` fuerza 200K.
- Precios en `PRICES` (`src/parser.js`), USD por millón: [input, output, cacheWrite5m, cacheWrite1h, cacheRead].
- El bloque de 5 h es una estimación local; no es el % oficial del plan.

## Probar y empaquetar
- Tests: `npm test` (node:test, sin dependencias; usan carpetas temporales, nunca `~/.claude`).
- F5 → abre una ventana "Extension Development Host" con la extensión cargada.
- Empaquetar: `npx @vscode/vsce package --allow-missing-repository --no-dependencies` → genera el `.vsix`.
- Instalar el `.vsix`: `code --install-extension claude-context-meter-<versión>.vsix`.
