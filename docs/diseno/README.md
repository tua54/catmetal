# Guía visual — Control de Materia Prima · Catmetal

La estructura y la jerarquía salen del **Figma**. La identidad (color, tipografía, logo y tono) sale del **sitio corporativo de Catmetal**. Si las dos fuentes chocan, manda la identidad de Catmetal, **excepto** en contraste y tamaños táctiles: ahí manda la usabilidad en planta (WCAG AA como mínimo, objetivos de 44 px o más). Cada adaptación no trivial se registra en un ADR.

## Fuentes

| Fuente | Ubicación |
|---|---|
| Figma "Control de Materia Prima - Mockup" | https://www.figma.com/design/QUlIwCVlR2jpmTYcLRb2Bo/Control-de-Materia-Prima---Mockup?node-id=3-3 |
| Captura: Supervisor · Registro de Consumo (frame 1180 de ancho) | `figma-supervisor-registro.jpg` |
| Captura: Jefe · Validación de Consumos | `figma-jefe-validacion.jpg` |
| Sitio corporativo | https://catmetal.com/ |
| Capturas del sitio | `catmetal-sitio-hero.jpg`, `catmetal-sitio-footer.jpg` |

Las capturas son de baja resolución: sirven para la estructura, no para medir. Si en la sesión está disponible el servidor MCP de Figma (`/mcp` muestra `figma` conectado), úsalo para leer medidas, textos y estilos exactos de los frames con node-id `3-2` (Supervisor) y `4-2` (Jefe). Si no está disponible, trabaja con esta guía y las capturas, y anótalo en `docs/notas-plataforma.md`.

## Identidad Catmetal (extraída de catmetal.com el 2026-10-29)

Catmetal S.A.S.: fundición y mecanizado de hierros y aceros, con 30 años de experiencia. El tono es industrial, sobrio y de mucho contraste: fondos casi negros, azul eléctrico como acento, titulares en Poppins negrita y en mayúsculas, y una línea azul corta bajo los títulos de sección.

### Paleta

| Token | Hex | Uso en el sitio | Uso en la app |
|---|---|---|---|
| `brand-600` | `#0539CC` | Barra superior, acentos y subrayados | **Color primario**: botón principal, enlaces, foco, selección, línea de acento bajo la barra superior |
| `brand-500` | `#0349FF` | Enlaces y acentos brillantes | Hover/activo del primario, indicadores, gráficos |
| `brand-700` | `#043BC9` | Variante del primario | Estado presionado |
| `navy-800` | `#243673` | Color de tema secundario | Encabezados de tablas, elementos secundarios oscuros |
| `ink-950` | `#111111` | Secciones oscuras y footer | **Barra superior de la app**, pantalla de login |
| `ink-700` | `#333333` | Texto principal | Texto principal sobre fondo claro |
| `ink-500` | `#69727D` | Texto secundario | Texto secundario y metadatos |
| `surface-50` | `#F5F7F9` | Fondo claro | Fondo de la app |
| `white` | `#FFFFFF` | — | Tarjetas y campos |

**Colores semánticos** (vienen del Figma; ajústalos para cumplir AA):

| Estado | Uso | Referencia del Figma |
|---|---|---|
| Éxito | "Sincronizado", "Validado por jefe", botón "Validar gasto" (relleno), indicador "En línea" | Verde (por ejemplo `#15803D`; texto sobre verde claro `#DCFCE7`) |
| Advertencia | Bloque de novedad, "Pendiente de sync", "Con novedad", "N pendientes", "1 por sustentar" | Ámbar (por ejemplo fondo `#FEF3C7`, borde `#F59E0B`, texto `#92400E`) |
| Peligro | Botón "Rechazar" (contorno), rechazos, errores | Rojo (por ejemplo `#B91C1C`) |
| Offline | Píldora "Sin conexión · N por sincronizar" | Píldora oscura con punto ámbar |

Contraste verificado: `#0539CC` sobre blanco da aproximadamente 8.5:1, y `#0349FF` sobre blanco aproximadamente 6.2:1. Los dos sirven para texto normal.

### Tipografía

- **Poppins** para todo: 700 en títulos, 600 en subtítulos y etiquetas, 400 y 500 en el texto. En el sitio, los títulos grandes van en mayúsculas. En la app usa mayúsculas solo para títulos de sección cortos, no para texto de formularios.
- **Lato 700** en botones del sitio. Es opcional; si se usa, que sea solo en botones.
- Números con `font-variant-numeric: tabular-nums` para cantidades y costos.
- **Las fuentes van empaquetadas en la app** (por ejemplo con `@fontsource/poppins`), nunca desde Google Fonts. Así funcionan offline y no rompen la CSP `'self'`.
- Tamaño base de 16 px o más. En la tablet en planta, el texto de las listas va a 15 px como mínimo.

### Logo

- En el sitio, el logo es un escudo azul con "CM" más la palabra "CATMETAL" en blanco, pensado para fondo oscuro.
  - PNG: `https://catmetal.com/wp-content/uploads/2025/05/Logo-Catmetal-pagina-web-1.png`
  - Favicon: `https://catmetal.com/wp-content/uploads/2025/05/cropped-cropped-Favicon-Catmetal-SAS-32x32.png`
- Mientras el cliente no entregue el logo vectorial, puedes descargar esos PNG como recurso provisional en `apps/web/src/assets/brand/`. Deja en `docs/pendientes-humanos.md` la tarea de pedir el **SVG oficial** (en versión clara y oscura) y los íconos de la PWA (192, 512 y maskable).
- El avatar "MP" del Figma se reemplaza por el escudo de Catmetal.

## Estructura de pantallas (Figma)

### Barra superior (común)

Figma: barra blanca de 74 px de alto, con el ícono "MP", título y subtítulo a la izquierda, y la píldora de estado más el avatar con iniciales a la derecha.

Adaptación de marca recomendada: la barra superior en `ink-950`, con el logo blanco de Catmetal y una línea inferior de 3 px en `brand-600`, como en el sitio corporativo. El contenido debajo se mantiene claro (`surface-50` y tarjetas blancas) para el contraste en planta. La decisión va en un ADR.

- Título: "Registro de Consumo" o "Validación de Consumos".
- Subtítulo: `Orden OP-… · Línea …` o `Panel del jefe · Rol: Aprobador`.
- Píldora de estado: "● Sin conexión · 3 por sincronizar" (punto ámbar), "● En línea · Todo sincronizado" (punto verde) o "Sincronizando…".
- Avatar con iniciales ("JS", "RM").

### Supervisor · Registro de Consumo (dos columnas en horizontal)

**Columna izquierda, tarjeta "Nuevo registro de material":**

- Select "Materia prima", con buscador. Ejemplo: "Resina PET Grado A — Lote 4471". En Catmetal los materiales serán de fundición.
- "Cantidad utilizada" (teclado numérico) y "Unidad" (select corto) en la misma fila.
- **Bloque de novedad** en ámbar:
  - Ícono de advertencia, "¿Hay una novedad en este consumo?" y toggle.
  - Al activarlo: selector de tipo, área de texto de justificación, botón "📎 Adjuntar evidencia" y contador "1 foto adjunta".
  - Si el consumo supera la tolerancia, el toggle se activa y queda bloqueado, con un texto que explica por qué.
- Botón primario de ancho completo, fijo al fondo de la tarjeta: "Guardar registro (se sincroniza al recuperar señal)".

**Columna derecha, arriba, tarjeta "Registros de hoy — Orden OP-…":**

- Una fila por registro, con material, cantidad, hora y "con novedad" si aplica.
- Chip de estado a la derecha: Pendiente de sync (ámbar), Sincronizado (verde), Validado por jefe (verde), Rechazado (rojo, toca para ver el motivo y "Crear corrección") y Falta novedad (ámbar).

**Columna derecha, abajo, tarjeta "Trazabilidad — este dispositivo":** lista con viñetas y hora. Ejemplos: "10:24 · Juan S. registró consumo + novedad", "09:47 · … (auto-sync)", "08:20 · Orden … iniciada".

### Jefe · Validación de Consumos (dos columnas)

**Columna izquierda, tarjeta "Por validar — Orden OP-…":**

- Chip "3 pendientes" y filtros arriba (orden, supervisor, con novedad).
- Una tarjeta por consumo. La seleccionada tiene borde `brand-600`.
  - Material, cantidad, supervisor y hora, más el chip "Con novedad".
  - Bloque ámbar "Justificación del supervisor:" con el texto y un enlace a la evidencia (por ejemplo `evidencia_sellado_4471.jpg`), que abre un visor ampliable.
  - Botones "✓ Validar gasto" (verde, relleno) y "Rechazar" (rojo, contorno). Rechazar abre un diálogo con motivo obligatorio. Validar pide confirmación.
  - Si `requiere_novedad = 1`, el botón Validar aparece deshabilitado y explica por qué.

**Columna derecha, arriba, tarjeta "Resumen de la orden":** pares etiqueta/valor:

- Materiales consumidos
- Costo total reportado (en COP)
- Novedades abiertas (en ámbar si hay)
- Estado de la orden

**Columna derecha, abajo, tarjeta "Trazabilidad completa de la orden":** línea de tiempo con punto de color por actor (gris para el sistema, ámbar para supervisor con novedad, verde para validación del jefe, rojo para rechazo). Cada entrada lleva hora, actor y rol, y una descripción.

### Formato de datos

- Moneda con `Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 })` → "$ 4.182.300". El Figma muestra comas como separador de miles; se corrige al formato colombiano.
- Horas en formato de 12 h con "a. m."/"p. m.", zona America/Bogota, como en el Figma.
- Cantidades con hasta 3 decimales y coma decimal en la presentación. Al capturar, se acepta punto o coma.

### Componentes base a construir

Botón (primario, éxito, peligro con contorno, secundario), campo, select con buscador, toggle, chip de estado, píldora de conexión, tarjeta, lista de registros, línea de tiempo, diálogo de confirmación, visor de imagen, estado vacío y aviso (toast).

Todos los componentes:

- Tienen estados de foco visibles con anillo `brand-500`.
- Tienen objetivos táctiles de 44 px o más.
- No dependen de hover.
