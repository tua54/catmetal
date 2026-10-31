# ADR 0011 — Adaptación visual: Figma + identidad Catmetal

- Estado: aceptado
- Fecha: 2026-10-29
- Fase: 4 (adelantada en paralelo con la Fase 2)

## Contexto

`docs/diseno/README.md` define la estructura (Figma "Control de Materia Prima - Mockup") y la identidad (sitio de Catmetal). Pide registrar en un ADR cada adaptación no trivial. Las capturas son de baja resolución y el MCP de Figma no estaba disponible en la sesión.

## Opciones consideradas

1. Copiar el Figma tal cual (barra superior blanca, avatar "MP", azul genérico).
2. Aplicar la identidad de Catmetal sobre la estructura del Figma, priorizando contraste y tamaños táctiles en planta.

## Decisión

Opción 2:

- **Barra superior** en `ink-950` (#111111) con el logo blanco de Catmetal, título y subtítulo en blanco/gris claro, y una línea inferior de 3 px en `brand-600` (#0539CC), como el sitio corporativo. El avatar "MP" del Figma se reemplaza por el escudo de Catmetal; el avatar del usuario conserva sus iniciales.
- **Contenido** claro: fondo `surface-50`, tarjetas blancas, texto `ink-700`, secundario `ink-500`.
- **Primario** `brand-600`; hover/activo `brand-500`; presionado `brand-700`; anillo de foco `brand-500` de 3 px, visible siempre (`:focus-visible`).
- **Semánticos**: éxito `#15803D` (texto sobre `#DCFCE7`), advertencia texto `#92400E` sobre `#FEF3C7` con borde `#F59E0B`, peligro `#B91C1C`. Todos verificados AA (≥ 4,5:1 para texto normal).
- **Tipografía**: Poppins empaquetada (400/500/600/700), base 16 px, listas ≥ 15 px, cifras tabulares en cantidades y costos, mayúsculas solo en títulos de sección cortos.
- **Táctil**: objetivos ≥ 44 px (48 px en botones primarios de planta), separación ≥ 8 px, nada depende de hover (uso con guantes).
- **Formato**: COP `es-CO` sin decimales ("$ 4.182.300", corrige las comas del Figma), horas de 12 h con "a. m."/"p. m." en America/Bogota, cantidades con coma decimal.
- **Disposición**: dos columnas en horizontal (tablet 1180×820) y una columna en vertical.

## Consecuencias

- La app se reconoce como de Catmetal y mantiene el contraste en planta.
- Cuando el cliente entregue el SVG oficial, se reemplazan los PNG provisionales sin cambiar la estructura.

## Cómo revertir

Cambiar los tokens de la barra superior en `apps/web/src/styles/index.css` y el componente de barra; el resto de la UI no depende de ese color.
