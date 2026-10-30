// Canales de sesión simulados para las pruebas de varias pestañas (ADR 0023).

import type { CanalDifusion, VentanaAlmacen } from '../canal-sesion';

/** Bus en memoria que imita `BroadcastChannel`: entrega a los DEMÁS canales del mismo nombre. */
export function busDifusion(): {
  crearCanal: (nombre: string) => CanalDifusion;
  mensajes: unknown[];
} {
  const canales = new Set<{ nombre: string; oyentes: Set<(e: { data: unknown }) => void> }>();
  const mensajes: unknown[] = [];
  return {
    mensajes,
    crearCanal(nombre) {
      const propio = { nombre, oyentes: new Set<(e: { data: unknown }) => void>() };
      canales.add(propio);
      return {
        postMessage(mensaje) {
          // Clonado estructurado: nunca se comparte el objeto.
          const copia: unknown = structuredClone(mensaje);
          mensajes.push(copia);
          for (const otro of canales) {
            if (otro !== propio && otro.nombre === nombre) {
              for (const oyente of otro.oyentes) {
                oyente({ data: copia });
              }
            }
          }
        },
        addEventListener: (_tipo, oyente) => propio.oyentes.add(oyente),
        removeEventListener: (_tipo, oyente) => propio.oyentes.delete(oyente),
        close: () => canales.delete(propio),
      };
    },
  };
}

/** `localStorage` compartido y ventanas: `setItem` dispara `storage` en las DEMÁS ventanas. */
export function almacenCompartido(): {
  datos: Map<string, string>;
  pestana: () => { almacen: Pick<Storage, 'setItem'>; ventana: VentanaAlmacen };
} {
  const datos = new Map<string, string>();
  type Oyente = (e: { key: string | null; newValue: string | null }) => void;
  const ventanas = new Set<Set<Oyente>>();
  return {
    datos,
    pestana() {
      const oyentes = new Set<Oyente>();
      ventanas.add(oyentes);
      return {
        almacen: {
          setItem(clave, valor) {
            const previo = datos.get(clave);
            datos.set(clave, valor);
            if (previo === valor) {
              return;
            }
            for (const otra of ventanas) {
              if (otra !== oyentes) {
                for (const oyente of otra) {
                  oyente({ key: clave, newValue: valor });
                }
              }
            }
          },
        },
        ventana: {
          addEventListener: (_tipo, oyente) => oyentes.add(oyente),
          removeEventListener: (_tipo, oyente) => oyentes.delete(oyente),
        },
      };
    },
  };
}
