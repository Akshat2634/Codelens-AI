

# Codelens AI

**[codelensai-dev.vercel.app](https://codelensai-dev.vercel.app/)**

**Correlador de Productividad vs. Costo del Agente** — ¿Su agente de codificación AI realmente está entregando código?

Codelens AI vincula el uso de tokens de agentes de codificación AI con la salida real en git. Lee los archivos de sesión locales de **Claude Code** y **OpenAI Codex CLI**, los correlaciona con los commits de git y sirve un panel de control que responde: *"¿Estoy obteniendo ROI de mis agentes de codificación AI?"* Cuando ambos agentes tienen sesiones, el panel añade pestañas de **Todos los Agentes / Claude Code / OpenAI Codex** para que puedas compararlos lado a lado.

- Un comando, cero configuración
- Todos los datos se mantienen en local
- Compatible con Claude Code y OpenAI Codex CLI en un solo panel
- Funciona con cualquier repositorio git donde hayas usado cualquiera de los agentes

## Instalación

> **Previo publicado como `claude-roi`.** Ese paquete está en desuso — usa `npx codelens-ai` de ahora en adelante. El comando `claude-roi` aún funciona como un alias compatible con versiones anteriores.

### Opción 1: Ejecutar directamente (sin instalación)

```bash
npx codelens-ai
```

### Opción 2: Instalar globalmente

```bash
# npm
npm install -g codelens-ai

# pnpm
pnpm add -g codelens-ai

# yarn
yarn global add codelens-ai
```

Luego ejecútalo en cualquier lugar:

```bash
codelens-ai
```

### Opción 3: Clonar y ejecutar desde el código fuente

```bash
git clone https://github.com/Akshat2634/Codelens-AI.git
cd Codelens-AI

# Instalar dependencias (elige uno)
npm install
# o
pnpm install
# o
yarn install

# Ejecutarlo
node src/index.js
```

### Solución de problemas: `npx codelens-ai` ejecuta una versión antigua

`npx codelens-ai` (sin fijar versión) puede resolverse a una copia antigua en lugar de la última versión publicada: ya sea una entrada obsoleta en la caché local de npx, o una instalación global ya en tu `$PATH` que npx reutiliza sin consultar el registro. Las versiones suficientemente antiguas preceden a ciertos subcomandos completos, por lo que verás un error confuso como:

```
error: too many arguments. Expected 0 arguments but got 1.
```

Cada versión actual imprime un mensaje de "Actualización disponible" cuando ocurre esto, pero si estás atascado en una versión anterior a esa comprobación, corrígelo con uno de:

```bash
npx codelens-ai@latest report       # fijar la versión explícitamente

npm uninstall -g codelens-ai        # eliminar una instalación global que oculta la actual
# o
npm install -g codelens-ai@latest   # ...o simplemente actualizarla
```

## Prerrequisitos

- **Node.js >= 22.12** — [Descarga](https://nodejs.org/) (Node >= 22.15 para también leer las compilaciones de archivos comprimidos con zstd de Codex)
- **Git** — instalado y configurado con `user.name` y `user.email`
- Al menos un agente compatible con datos de sesión locales:
  - **Claude Code** — Sesiones de [Claude Code](https://claude.com/claude-code) en `~/.claude/projects/`
  - **OpenAI Codex CLI** — Sesiones de [Codex](https://developers.openai.com/codex) en `~/.codex/sessions/` (se respeta `$CODEX_HOME`)

## Inicio Rápido

```bash
npx codelens-ai
```

Esto analiza los datos de `~/.claude/projects/` y `~/.codex/sessions/`, examina tus repositorios git y abre un panel de control en `http://localhost:3457`.

## Qué Mide

| Métrica                | Descripción                                                     |
| --------------------- | --------------------------------------------------------------- |
| **Costo por Commit**   | Cuánto cuesta cada commit asistido por AI en tokens                |
| **Porcentaje de Código AI**     | % de todas las líneas fusionadas en esta ventana escritas por AI — medido desde git, no encuestas |
| **Fuga de Valor**        | $ y % del gasto de sesiones que no produjeron código commiteado |
| **Tasa de Supervivencia de Líneas**| % de líneas escritas por AI que sobreviven 24h sin ser reescritas  |
| **Sesiones Huérfanas** | Sesiones con 10+ mensajes que produjeron cero commits           |
| **Grado de ROI (A-F)**   | Puntaje compuesto basado en tokens por commit y tasa de supervivencia    |
| **Atribución de Remolque** | Los remolques `Co-authored-by` del agente confirman la atribución del commit (cercano a la verdad absoluta) |
| **Comparación de Modelos**  | Eficiencia entre modelos Claude y Codex, incluyendo GPT-5.6 Sol, Terra y Luna |
| **Comparación de Agentes**  | Pestañas del panel por agente (Todos / Claude Code / OpenAI Codex)     |
| **Conciencia de Rama**  | Qué % de commits AI aterrizaron en producción                       |
| **Horas Pico**        | Mapa de calor de productividad hora del día x día de la semana                  |
| **Puntaje de Autonomía**    | Grado compuesto A-F que mide qué tan independientemente trabaja el agent |
| **Relación de Piloto Automático**   | Mensajes del asistente por mensaje del usuario (mayor = más autónomo)   |
| **Puntaje de Auto-Reparación**   | % de llamadas bash que son comandos de prueba/lint (auto-verificación) |
| **Velocidad de Commit**   | Llamadas de herramientas por commit (menor = más eficiente)                  |

## Opciones de CLI

```bash
codelens-ai                        # por defecto: últimos 30 días, puerto 3457
codelens-ai --days 90              # mirar atrás 90 días
codelens-ai --port 8080            # puerto personalizado
codelens-ai --host 0.0.0.0         # exponer el panel más allá de localhost (desactivado por defecto)
codelens-ai --no-open              # no abrir el navegador automáticamente
codelens-ai --json                 # volcar todas las métricas como JSON a stdout
codelens-ai --project techops      # filtrar a un proyecto específico
codelens-ai --refresh              # forzar reanálisis completo (ignorar caché)
codelens-ai --source codex         # analizar solo un agente: claude | codex
codelens-ai --offline              # omitir la actualización de precios por red (usar tarifas en caché/fijas)
codelens-ai --plan max20           # modo suscripción Claude: $/commit efectivo vs tu plan fijo
codelens-ai --plan-cost 150        # costo mensual personalizado de suscripción Claude (USD)
codelens-ai --codex-plan plus      # Suscripción ChatGPT/Codex: free | go | plus | pro100 | pro | business | business-annual
codelens-ai --codex-plan-cost 40   # costo mensual personalizado de suscripción Codex (USD)
codelens-ai --claude-dir <path>    # anular ~/.claude/projects (pruebas/CI)
codelens-ai --codex-dir <path>     # anular ~/.codex/sessions (pruebas/CI)

codelens-ai report                 # imprimir una tarjeta de ROI en la terminal
codelens-ai report --md            # exportar codelens-report.md (o --md <path>)
codelens-ai report --html          # exportar un codelens-report.html autocontenido
codelens-ai statusline --install   # añadir la línea de estado de ROI a Claude Code

codelens-ai daily                  # tabla de uso de tokens y costo por día (+ commits, $/commit)
codelens-ai weekly                 # ...por semana (--start-of-week monday|sunday)
codelens-ai monthly                # ...por mes
codelens-ai daily --breakdown      # anidar filas por modelo bajo cada periodo
codelens-ai daily --json           # exportación estructurada (pipe a jq)

codelens-ai blocks                 # agrupar uso en ventanas de facturación de 5 horas de Claude
codelens-ai blocks --active        # solo el bloque abierto: tasa de consumo, tiempo restante, proyección
codelens-ai blocks --recent        # solo los últimos 3 días de bloques
codelens-ai blocks -t max          # advertir contra un límite de tokens (un número, o "max")

codelens-ai mcp                    # servir informes de uso y ROI como herramientas MCP sobre stdio
```

### Tablas de uso (`codelens-ai daily|weekly|monthly`)

Contabilidad de tokens estilo ccusage sobre la misma ventana analizada: Entrada / Salida / Creación de Caché / Lectura de Caché / Total / Costo por periodo, más las dos columnas de ROI que una herramienta de uso pura no puede darte: **Commits** y **$/Commit**. Todas las banderas de análisis compartidas (`--days`, `--source`, `--project`, `--claude-dir`, `--codex-dir`) aplican.

### Bloques de facturación (`codelens-ai blocks`)

Claude factura el uso en ventanas rodantes de **5 horas** (la ventana se abre con tu primer mensaje y dura exactamente 5 horas). `blocks` agrupa el uso de cada sesión en esas ventanas y muestra tokens y costo por bloque, tu **tasa de consumo** (tokens/min y $/hr) y, para el bloque que aún está abierto, una **proyección** lineal de dónde aterriza más un medidor de cuota opcional (`-t <n>` o `-t max`). Añade `--active` para solo la ventana actual, `--recent` para los últimos 3 días, `--session-length <hours>` para cambiar el tamaño de la ventana, o `--json` para una exportación estructurada. Los costos usan los precios por token conscientes de la versión de Codelens, por lo que los números coinciden con el resto de la herramienta.

### Servidor MCP (`codelens-ai mcp`)

Servir los mismos informes como **herramientas MCP sobre stdio**, para que Claude Code / Claude Desktop puedan consultar tu uso y ROI en el chat ("¿cuánto costó mi codificación AI esta semana?", "¿qué repo tiene el peor $/commit?"). Añádelo a Claude Code con:

```bash
claude mcp add codelens -- npx -y codelens-ai mcp
```

Herramientas expuestas: **`roi_summary`** (grado, gasto, $/commit, supervivencia, fuga de valor — la tarjeta), **`usage`** (tabla de tokens y costo diario/semanal/mensual), **`blocks`** (ventanas de facturación de 5 horas + tasa de consumo), **`sessions`**, **`projects`** (ROI por repo) y **`refresh`** (forzar reanálisis). La mayoría de las herramientas toman un `source` opcional (`all | claude | codex`), y todas las banderas de análisis compartidas (`--days`, `--project`, `--claude-dir`, ...) aplican al servidor mismo. El análisis se ejecuta una vez al inicio y se sirve desde memoria; la herramienta `refresh` la vuelve a ejecutar bajo demanda.

### Informe de ROI (`codelens-ai report`)

Un comando produce el artefacto de "¿mi suscripción AI se está pagando a sí misma" — en la terminal, o como un documento de una página Markdown/HTML autocontenido que puedes entregar a un gerente para justificar un asiento Claude Max o ChatGPT Pro:

- Gasto (equivalente a API, con la participación de precios estimados marcada), utilización del plan cuando se establece `--plan`/`--codex-plan`
- Commits entregados, costo por commit (y $/commit efectivo en tu plan fijo), supervivencia de líneas
- **Porcentaje de código AI** — % de todas las líneas fusionadas en esta ventana que escribió la AI, medido desde git
- **Fuga de valor** — cuánto gasto nunca se convirtió en código commiteado
- Desgloses por agente y por modelo, la auditoría de atribución y los principales insights

Todas las banderas de análisis (`--days`, `--source`, `--plan`, `--project`, ...) también funcionan en `report`.

### Línea de estado de Claude Code (`codelens-ai statusline`)

Una línea de HUD siempre encendida dentro de Claude Code, y la única línea de estado que muestra **ROI** junto al consumo:

```text
$4.20 session │ today $12.40 · 3 commits · $4.13/commit · A │ burn 2.6K/min · $0.23/hr │ 5h 84% (resets 1h15m) · wk 41% │ ctx 23%
```

- **Costo de sesión** directo de Claude Code (exacto, no estimado)
- **Gasto de hoy, commits y $/commit** de tu última ejecución del pipeline
- **Tasa de consumo** del bloque abierto de 5 horas — tokens/min (coloreado por el indicador excluido de caché) y $/hr — capturado por tu última ejecución del pipeline y oculto una vez que la ventana se cierra
- **Uso oficial de límites de tasa de 5 horas y semanales** con una cuenta regresiva de reinicio cuando estás cerca — los números que el limitador de Anthropic realmente aplica, no estimaciones matemáticas de tokens
- **Presión de la ventana de contexto**

Instálala con un comando (hace una copia de seguridad de tu archivo de configuración primero, se niega a sobrescribir una línea de estado existente a menos que pases `--force`):

```bash
npx codelens-ai statusline --install
```

Luego ejecuta `npx codelens-ai` (o `codelens-ai report`) cada vez que quieras actualizar los números de ROI de "hoy".

### Costo efectivo (modo suscripción)

Por defecto, los costos son **equivalentes a API** — lo que tu uso *costaría* a tarifas de tokens pago por uso. Si estás en un plan de tarifa fija, esos dólares no son lo que realmente pagas. Pasa `--plan` (`pro` = $20/mes, `max5` = $100/mes, `max20` = $200/mes) / `--plan-cost <usd>` para Claude, o `--codex-plan` (`free` = $0/mes, `go` = $8/mes, `plus` = $20/mes, `pro100` = $100/mes, `pro` = $200/mes, `business` = $25/usuario/mes, `business-annual` = $20/usuario/mes anualmente) / `--codex-plan-cost <usd>` para ChatGPT/Codex, para añadir un panel de **Costo Efectivo** que prorrratea tu suscripción a la ventana analizada y muestra:

- **$ /commit efectivo** y **$/línea sobreviviente** — tu cuota prorrateada ÷ salida, las cifras de costo que realmente reflejan tu factura.
- **Utilización del plan** — valor equivalente a API ÷ cuota prorrateada (p. ej. `3.2×` significa que extrajiste ~3.2× tu suscripción en valor pago por uso). Esto es una estimación de valor extraído, **no** ahorros realizados.

## Panel de Control

El panel incluye:

- **Pestañas de origen del agente** — cuando existen sesiones de Claude Code y Codex, cambia entre las vistas de **Todos los Agentes**, **Claude Code** y **OpenAI Codex**; cada sección se recalcula para el agente seleccionado
- **Estadísticas principales** — costo total, commits entregados, costo por commit, grado de ROI, **porcentaje de código AI** y **fuga de valor**
- **Atribución y Cobertura** — confianza por commit (alta/media/baja) de que un commit fue realmente del AI, confirmaciones de remolque `Co-authored-by`, más una reconciliación de líneas atribuidas a AI vs co-autoradas vs orgánicas (manuales), para que los números de ROI sean auditables y no una caja negra
- **Insights inteligentes** — observaciones generadas automáticamente sobre tus patrones de uso
- **Línea de tiempo de Costo vs Salida** — gráfico de doble eje del costo diario y líneas agregadas
- **Comparación de modelos** — desglose de costo y eficiencia entre modelos Claude Code y OpenAI Codex
- **Análisis de longitud de sesión** — qué tamaños de sesión tienen el mejor ROI
- **Mapa de calor de productividad** — cuadrícula estilo GitHub que muestra cuándo eres más productivo
- **Autonomía del Agente** — insignia de puntaje de autonomía, relación de piloto automático, puntaje de auto-reparación, velocidad de commit y principales comandos de verificación
- **Proyectos** — ROI por repositorio: a qué repositorio va tu gasto, clasificado por costo, con su participación en el gasto, commits, $/commit, líneas y % en la rama predeterminada. Los repositorios se identifican por su remote `origin` de git, por lo que un clon, worktree o checkout movido del mismo repositorio cuenta como un proyecto (no como una tarjeta duplicada)
- **Tabla de sesiones** — tabla ordenable y expandible con métricas por sesión, commits coincidentes (incluyendo su rama contenedora cuando está disponible) y relación de piloto automático

## Cómo Funciona

1. **Analiza** archivos JSONL de sesión desde `~/.claude/projects/` (Claude Code) y archivos de compilación desde `~/.codex/sessions/` (OpenAI Codex CLI — incluyendo archivos `.jsonl.zst` en Node >= 22.15)
2. **Analiza** el historial git de cada repositorio en el que hayas trabajado con cualquiera de los agentes, incluidos los remolques `Co-authored-by` del agente en cada commit. Si una sesión comienza en un directorio padre que contiene múltiples repositorios git, Codelens descubre automáticamente repositorios anidados (hasta tres niveles) y correlaciona los archivos modificados con el repositorio correcto — sin necesidad de banderas ni configuración.
3. **Correlaciona** sesiones con commits por superposición de archivos y timing — todos los agentes se correlacionan juntos, por lo que un commit se atribuye a como máximo una sesión; un commit marcado con `Co-authored-by: Claude/Codex` se enruta al agente coincidente y cuenta como una atribución de alta confianza
4. **Calcula** el costo usando los precios de API publicados de cada proveedor (entrada, salida, caché y búsqueda web del lado del servidor cuando se registra)
5. **Sirve** un panel interactivo en localhost con vistas por agente

### Caché

Los datos de sesión analizados se almacenan en caché en `~/.cache/agent-analytics/parsed-sessions.json`. En ejecuciones posteriores, solo se vuelven a analizar los archivos JSONL nuevos o modificados, haciendo que el inicio sea casi instantáneo. Usa `--refresh` para forzar un reanálisis completo.

### Cálculo de Costo

> **Autoprecios de nuevos modelos:** las tablas por modelo a continuación permanecen como referencia oficial (llevan versión, fecha, contexto largo y precisión de nivel de caché), pero cualquier modelo que no reconozcan se precio automáticamente desde [el mapa de precios público de LiteLLM](https://github.com/BerriAI/litellm) (más de 2,900 modelos) — obtenido bajo demanda, almacenado en caché en `~/.cache/agent-analytics/pricing.json` por ~24h y actualizado con `--refresh`. Así, un ID de modelo totalmente nuevo se cuesta según su tarifa real publicada sin cambios de código, en lugar de una estimación aproximada. Usa `--offline` para omitir la red por completo (solo tarifas en caché/fijas); si la obtención falla, se degrada a la caché y luego a la alternativa fija. Las tarifas fijas siempre tienen prioridad cuando ambas fuentes tienen un modelo.

Los costos de tokens son conscientes de la versión y se calculan por modelo, teniendo en cuenta las dos tarifas de escritura de caché de prompt. Multiplicadores (relativos a la entrada base): **lectura de caché = 0.1×**, **escritura de caché de 5 minutos = 1.25×**, **escritura de caché de 1 hora = 2×**. Las cifras a continuación están verificadas contra [los precios de Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) (por millón de tokens):

| Modelo | Entrada | Salida | Lectura Caché | Escritura Caché (5m) | Escritura Caché (1h) |
| --- | --- | --- | --- | --- | --- |
| Fable 5 / Mythos 5 | $10/M | $50/M | $1.00/M | $12.50/M | $20/M |
| Opus 4.8 | $5/M | $25/M | $0.50/M | $6.25/M | $10/M |
| Opus 4.7 | $5/M | $25/M | $0.50/M | $6.25/M | $10/M |
| Opus 4.6 | $5/M | $25/M | $0.50/M | $6.25/M | $10/M |
| Opus 4.5 | $5/M | $25/M | $0.50/M | $6.25/M | $10/M |
| Opus 4.0/4.1 (legacy) | $15/M | $75/M | $1.50/M | $18.75/M | $30/M |
| Sonnet 5 (intro, through Aug 31 2026) | $2/M | $10/M | $0.20/M | $2.50/M | $4/M |
| Sonnet 5 (standard, from Sep 1 2026) | $3/M | $15/M | $0.30/M | $3.75/M | $6/M |
| Sonnet 3.7/4.0/4.5/4.6 | $3/M | $15/M | $0.30/M | $3.75/M | $6/M |
| Haiku 4.5 | $1/M | $5/M | $0.10/M | $1.25/M | $2/M |
| Haiku 3.5 | $0.80/M | $4/M | $0.08/M | $1.00/M | $1.60/M |
| Haiku 3 | $0.25/M | $1.25/M | $0.03/M | $0.30/M | $0.50/M |

> **Nota — Claude Sonnet 5:** Sonnet 5 se lanzó con [precios introductorios](https://www.anthropic.com/news/claude-sonnet-5) de $2 / $10 por MTok hasta el 31 de agosto de 2026, volviendo a los precios estándar de nivel Sonnet $3 / $15 el 1 de septiembre de 2026. Los costos se calculan según la tarifa vigente en la fecha de cada uso, por lo que los registros permanecen precisos a través del cambio.
>
> **Nota — Claude Fable 5 / Mythos 5:** Claude Fable 5 / Mythos 5 está disponible nuevamente — Anthropic [restauró el acceso](https://platform.claude.com/docs/en/about-claude/models/introducing-claude-fable-5) el 1 de julio de 2026 después de una suspensión temporal (12-30 de junio de 2026). Las tarifas de $10 / $50 por MTok se aplican tanto al uso en vivo como histórico de Fable 5 en tus registros de sesión.
>
> **Nota — niveles heredados:** Los multiplicadores 0.1× / 1.25× / 2× describen los modelos actuales. Claude 3 Haiku los precede y utiliza las tarifas de caché publicadas originalmente por Anthropic ($0.30 escritura / $0.03 lectura), y las tarifas de escritura de caché de 1 hora para niveles retirados (p. ej. Sonnet 3.7, Haiku 3) se derivan a 2× entrada. Estas filas heredadas se mantienen solo para costear con precisión registros de sesión más antiguos.
>
> **Nota — modificadores de facturación y herramientas:** Las filas de uso de Claude Code incluyen `speed` e `inference_geo` cuando correspondan. Las tarifas de modo rápido de Opus 4.8/4.7 y el multiplicador de inferencia 1.1× solo en EE. UU. se apilan con los precios de caché. La búsqueda web del lado del servidor se cobra solo desde el conteo registrado `server_tool_use.web_search_requests` a $10 por 1,000 búsquedas; una llamada de herramienta `WebSearch` del lado del cliente por sí sola no se asume que se cobra, y web fetch no tiene tarifa por llamada.

#### Modelos OpenAI Codex

Las sesiones de Codex se costean desde los eventos `token_count` en cada archivo de compilación. En la contabilidad de OpenAI, `cached_input_tokens` es un subconjunto de `input_tokens` (las lecturas de caché se facturan a la tarifa en caché, no hay prima por escritura de caché) y `reasoning_output_tokens` es un subconjunto de `output_tokens` (el razonamiento se factura a la tarifa de salida, nunca se cuenta doble). Las entradas `web_search_call` del lado del servidor añaden la tarifa de llamada de búsqueda web publicada por OpenAI. Tarifas por millón de tokens desde [los precios de API de OpenAI](https://developers.openai.com/api/docs/pricing):

| Modelo | Entrada | Entrada en Caché | Salida |
| --- | --- | --- | --- |
| GPT-5.6 Sol (`gpt-5.6` alias) | $5.00/M corto, $10/M contexto largo | $0.50/M corto, $1/M contexto largo | $30/M corto, $45/M contexto largo |
| GPT-5.6 Terra | $2.50/M corto, $5/M contexto largo | $0.25/M corto, $0.50/M contexto largo | $15/M corto, $22.50/M contexto largo |
| GPT-5.6 Luna | $1.00/M corto, $2/M contexto largo | $0.10/M corto, $0.20/M contexto largo | $6/M corto, $9/M contexto largo |
| GPT-5.5 | $5.00/M corto, $10/M contexto largo | $0.50/M corto, $1/M contexto largo | $30/M corto, $45/M contexto largo |
| GPT-5.5 Pro | $30/M corto, $60/M contexto largo | sin descuento de caché publicado | $180/M corto, $270/M contexto largo |
| GPT-5.4 / 5.4 Mini / 5.4 Nano | $2.50 / $0.75 / $0.20/M | $0.25 / $0.075 / $0.02/M | $15 / $4.50 / $1.25/M |
| GPT-5.4 Pro | $30/M corto, $60/M contexto largo | sin descuento de caché publicado | $180/M corto, $270/M contexto largo |
| GPT-5.3 Codex | $1.75/M | $0.175/M | $14/M |
| GPT-5.1 Codex (Max) / 5.1 / GPT-5 Codex / GPT-5 | $1.25/M | $0.125/M | $10/M |
| GPT-5.1 Codex Mini / GPT-5 Mini | $0.25/M | $0.025/M | $2/M |
| codex-mini-latest | $1.50/M | $0.375/M | $6/M |
| o3 (from Jun 10 2025 / before) | $2 / $10/M | $0.50 / $2.50/M | $8 / $40/M |
| o4-mini | $1.10/M | $0.275/M | $4.40/M |
| GPT-4.1 | $2.00/M | $0.50/M | $8/M |

> **Nota — o3:** OpenAI redujo los precios de o3 un 80% el 10 de junio de 2025; el uso se precio según la tarifa vigente en su fecha.
>
> **Nota — contexto largo:** GPT-5.6, GPT-5.5 y GPT-5.4 publican tarifas separadas para contexto corto y largo. Codelens aplica el nivel largo solo cuando una solicitud individual excede 272K tokens de entrada, luego lo mantiene como un cubo de modelo separado (por ejemplo, `gpt-5.6-sol[long]`) para que las sesiones mixtas no promedien tarifas incompatibles.
>
> **Nota — modelos actuales:** La guía de modelos actuales de OpenAI recomienda GPT-5.6 Sol para codificación y razonamiento complejos, GPT-5.6 Terra para un equilibrio entre capacidad y costo, y GPT-5.6 Luna para cargas de trabajo sensibles al costo. El alias `gpt-5.6` se resuelve a Sol. Codelens también conserva los precios de modelos Codex anteriores para que los costos de compilaciones históricas permanezcan precisos.
>
> **Nota — búsqueda web:** Las entradas `web_search_call` de Codex se costean a $10 por 1,000 llamadas de OpenAI; los tokens de contenido de búsqueda permanecen como parte del uso normal de tokens cuando se facturan por la API.
>
> **Nota — modelos sin precio:** Los modelos sin un precio de API publicado (p. ej. `gpt-5.3-codex-spark`, lanzamientos futuros) se costean a tarifas proxy e incluidos en la advertencia de "gasto estimado" del panel en lugar de leer silenciosamente $0.
>
> **Nota — suscripciones:** Si usas Codex a través de un plan ChatGPT (Free/Go/Plus/Pro/Business), las cifras en dólares son **valor equivalente a API**, no lo que te facturaron — pasa `--codex-plan` para ver el costo efectivo contra tu tarifa fija. El modo clave API también puede incluir tarifas publicadas de llamadas de herramientas del lado del servidor cuando los registros de compilación las exponen.

### Supervivencia de Líneas

La supervivencia de líneas utiliza una heurística aproximada: si las líneas agregadas en el commit A son eliminadas por un commit posterior en el mismo archivo dentro de 24 horas, se cuentan como "rotadas". Esto no es un seguimiento basado en git-blame y las tasas de supervivencia se redondean al 5% más cercano.

## Estructura del Proyecto

```text
Codelens-AI/
├── package.json
├── README.md
├── .gitignore
└── src/
    ├── index.js          # CLI entry point
    ├── claude-parser.js  # Parse Claude Code JSONL session files
    ├── codex-parser.js   # Parse OpenAI Codex CLI rollout files
    ├── cache.js          # Parsed data caching layer (per-source staleness)
    ├── git-analyzer.js   # Parse git log with branch awareness
    ├── correlator.js     # Match sessions to commits by file overlap + timing + trailers
    ├── metrics.js        # Calculate ROI metrics and insights
    ├── mcp.js            # `codelens-ai mcp` — expose reports as MCP tools over stdio
    ├── report.js         # `codelens-ai report` — terminal / Markdown / HTML ROI scorecard
    ├── statusline.js     # `codelens-ai statusline` — Claude Code statusline integration
    ├── server.js         # Express server + API routes (?source= views)
    └── dashboard.html    # Single-file dashboard (inline CSS/JS)
```

## Lanzamientos

Los lanzamientos están automatizados mediante GitHub Actions. Para publicar una nueva versión:

```bash
npm version patch   # or minor / major
git push --follow-tags
```

Esto publica automáticamente en npm y crea un Lanzamiento de GitHub con notas generadas automáticamente.

**Configuración (única):** Configura [publicación confiable](https://docs.npmjs.com/trusted-publishers/) en npm para el paquete `codelens-ai`, vinculándolo al flujo de trabajo de GitHub Actions. No se necesitan tokens ni secretos.

## Contribuciones

¡Las contribuciones son bienvenidas! Por favor, consulta [CONTRIBUTING.md](CONTRIBUTING.md) para la configuración de desarrollo, pautas e ideas para contribuciones.

## Privacidad

Todos los datos se mantienen en tu máquina, y el panel se vincula a `127.0.0.1` por defecto para que no sea visible en tu red (pasa `--host 0.0.0.0` para optar por mostrarlo). Chart.js está incluido y se sirve localmente; la única solicitud externa que realiza el panel es cargar fuentes web de Google Fonts (recurre a fuentes del sistema sin conexión). Sin telemetría, sin recopilación de datos.

## Licencia

MIT
