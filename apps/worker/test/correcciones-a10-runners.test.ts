// A10 (docs/correcciones-v1.2.md): los jobs de CI corren en una imagen fija del runner. Una etiqueta
// `-latest` cambia de sistema operativo sin aviso (GitHub mueve `ubuntu-latest` a Ubuntu 26), y un
// cambio así no debe llegar al CI sin una decisión explícita.

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

/** Imagen fijada para todos los jobs. Cambiarla es una decisión del equipo, no un efecto lateral. */
const IMAGEN_FIJA = 'ubuntu-24.04';

/** Valores de `runs-on:` del workflow (una por job). */
function runsOn(contenido: string): string[] {
  return [...contenido.matchAll(/^\s*runs-on:\s*(.+?)\s*$/gm)].map((m) => m[1] ?? '');
}

describe('A10: imagen fija de los runners de CI', () => {
  it('hay workflows y todos tienen al menos un job con runs-on', () => {
    expect(env.TEST_WORKFLOWS.length).toBeGreaterThan(0);
    for (const workflow of env.TEST_WORKFLOWS) {
      expect(runsOn(workflow.contenido).length, workflow.ruta).toBeGreaterThan(0);
    }
  });

  it('ningún workflow usa una etiqueta -latest', () => {
    for (const workflow of env.TEST_WORKFLOWS) {
      expect(workflow.contenido, workflow.ruta).not.toMatch(/-latest\b/);
    }
  });

  it(`todos los jobs corren en ${IMAGEN_FIJA}`, () => {
    for (const workflow of env.TEST_WORKFLOWS) {
      for (const imagen of runsOn(workflow.contenido)) {
        expect(imagen, workflow.ruta).toBe(IMAGEN_FIJA);
      }
    }
  });
});
