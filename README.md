# Claude Context Meter

Extensión de VS Code que te muestra cuánto estás consumiendo con Claude Code: el contexto de la conversación, lo que lleva cada chat, tu límite de 5 horas y el semanal, y un histórico de todas tus sesiones. Funciona en local: no usa la red ni modifica nada de Claude Code.

## Qué verás

### Vista "Claude Meter" (debajo del chat de Claude Code)

Aparece en la barra lateral, justo debajo del chat de Claude Code. Al pasar el ratón por cualquier dato, un bocadillo explica qué es.

- **Contexto**: cuántos tokens arrastra la conversación sobre la ventana del modelo (1M o 200K), con un esquema de cuadraditos (cada uno es el 1 % de la ventana) según de dónde viene: caché, nuevo en caché o sin caché.
- **Última llamada**: caché leída, caché escrita, entrada nueva y salida.
- **Sesión**: preguntas, llamadas, tokens procesados y sin caché, subagentes y coste equivalente de la API, con una barra que muestra qué parte es caché leída.
- **Última pregunta**: cuánto contexto añadió y cuánto costó.
- **Límite de 5 h y semanal (oficiales)**: el % usado y la hora de reinicio que Claude Code guarda al consultar tu uso (por ejemplo con `/usage`), con el reparto semanal por producto (Claude Code, Cowork…). Siempre indica de cuándo es el dato.
- **Ventana actual**: lo que lleva **este proyecto** en la ventana de 5 h y el total de **todos tus proyectos** de este ordenador, con un reparto por proyecto y un punto verde en los que están trabajando ahora.

Si no la ves, ejecuta **Claude Meter: Mostrar la vista** desde la paleta de comandos (`Ctrl+Shift+P`).

### Barra de estado

Tres indicadores cortos: contexto (`67k/1M · 7%`), sesión (`1 · 133k · $0.36`) y límite de 5 h (`5h 26% · 4h 49m`). Con el ajuste `claudeMeter.statusBar` puedes dejar los tres, solo el contexto o ninguno.

### Panel completo

Desde la vista o la barra de estado se abre un panel con:

- **Sesión actual**: gráfica del contexto que arrastra cada pregunta y tabla pregunta a pregunta.
- **Histórico**: hoy, 7 días, 30 días y total; tokens por día; bloques de 5 h anteriores; y todas tus sesiones (clic para ver el detalle), con filtro por proyecto.

## Instalación

1. Descarga el archivo `.vsix` de la última [release](https://github.com/ManuelCebreiro/claude_context_meter/releases).
2. Instálalo de una de estas formas:
   - En VS Code: vista de Extensiones → menú `···` → **Instalar desde VSIX…** y elige el archivo.
   - Desde una terminal: `code --install-extension claude-context-meter-0.4.0.vsix`
3. Abre una carpeta donde uses Claude Code y escríbele algo a Claude.

Requiere VS Code 1.90 o posterior. La vista se coloca debajo del chat de la extensión oficial de Claude Code; si no la tienes instalada, aparece en el Explorador.

## Ajustes

| Ajuste | Por defecto | Qué hace |
|---|---|---|
| `claudeMeter.statusBar` | `all` | Qué mostrar en la barra de estado: `all`, `context` o `none`. |
| `claudeMeter.showCost` | `true` | Mostrar el coste equivalente de la API. |
| `claudeMeter.warningPercent` / `errorPercent` | `60` / `80` | % de contexto a partir del cual se pone amarillo / rojo. |
| `claudeMeter.showBlock` | `true` | Mostrar el límite de 5 h y la ventana actual. |
| `claudeMeter.blockWarnRatio` | `0.8` | Fracción a partir de la cual el límite se pone amarillo. |
| `claudeMeter.contextWindow` | `0` | Ventana de contexto fija en tokens (0 = automática según el modelo). |
| `claudeMeter.saveToDisk` | `true` | Guardar el histórico para conservarlo cuando Claude Code borre transcripts antiguos. Desactivado, no escribe nada en disco. |
| `claudeMeter.priceOverrides` | `{}` | Precios propios por modelo (USD por millón). |
| `claudeMeter.pollMs` | `1500` | Cada cuántos milisegundos se relee el chat activo. |

## Cómo funciona y privacidad

- Lee los transcripts que Claude Code ya guarda en `~/.claude/projects/` y, solo para el límite oficial, el uso que Claude Code guarda en `~/.claude.json`. De ese archivo solo extrae el % y las horas de reinicio, nada de tu cuenta.
- No se conecta a ningún sitio, no instala hooks y no escribe en `~/.claude`.
- Guarda su propio histórico (`history.json` y `blocks.json`) en el almacenamiento de la extensión, salvo que desactives `claudeMeter.saveToDisk`.
- Lee los archivos por trozos y sin bloquear VS Code.

## Notas

- **Tokens procesados** incluye las relecturas de caché: en cada llamada, Claude Code reenvía todo el contexto, así que en chats largos son la mayor parte del volumen. Por eso también se muestran los tokens **sin caché leída**.
- El **límite oficial** solo se actualiza cuando Claude Code consulta tu uso; si el dato es antiguo, la vista lo indica.
- Los tokens de la **ventana actual** son solo de Claude Code en este ordenador: no incluyen claude.ai, Cowork ni otros equipos (el % oficial sí).
- El **coste** es una estimación con los precios públicos de la API; con un plan Pro o Max no es lo que pagas.

## Desarrollo

- `npm test` ejecuta los tests (Node, sin dependencias).
- F5 abre una ventana de VS Code con la extensión cargada.
- `npx @vscode/vsce package --no-dependencies` genera el `.vsix`.

Licencia MIT.
