// Precondición de las pruebas que agotan el limitador de login (binding de Rate Limiting, 5 por 60 s).
//
// El limitador simulado de Miniflare cuenta por ventanas ALINEADAS AL RELOJ de pared:
// `epoch = floor(Date.now() / (period * 1000))` (miniflare/src/workers/ratelimit). Si una ráfaga de
// intentos cruza el cambio de ventana, el contador vuelve a 0 y el sexto intento no da 429: la prueba
// fallaría según la hora a la que corra (N3, docs/correcciones-v1.2.md). Antes de la ráfaga, si queda
// menos de `margenMs` de la ventana actual, se espera a la siguiente. El resultado ya no depende de
// la hora ni de la velocidad de la máquina mientras la ráfaga dure menos que el margen.

/** Periodo del limitador de login (`ratelimits[].simple.period` de wrangler.jsonc), en ms. */
export const PERIODO_LIMITADOR_MS = 60_000;
/** Margen por defecto: unas 5 veces lo que tarda la ráfaga más larga medida (~3 s). */
export const MARGEN_LIMITADOR_MS = 15_000;

/** Milisegundos que quedan de la ventana actual del limitador. */
export function restanteDeVentana(ahora = Date.now(), periodoMs = PERIODO_LIMITADOR_MS): number {
  return periodoMs - (ahora % periodoMs);
}

/**
 * Espera, si hace falta, a que queden al menos `margenMs` en la ventana actual del limitador.
 * Devuelve lo que queda de la ventana al volver. La prueba que la usa debe tener un tiempo máximo
 * de al menos `margenMs` más lo que dure su ráfaga.
 */
export async function enVentanaDelLimitador(margenMs = MARGEN_LIMITADOR_MS): Promise<number> {
  const restante = restanteDeVentana();
  if (restante < margenMs) {
    await new Promise((resolver) => setTimeout(resolver, restante + 200));
  }
  return restanteDeVentana();
}
