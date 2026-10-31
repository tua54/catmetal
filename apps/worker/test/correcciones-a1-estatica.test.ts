// A1 (ADR 0028, punto 6): respaldo estático del tipo opaco `CondicionDeEscritura`. La garantía real
// son las pruebas del "plan perdedor" (correcciones-a1-*.test.ts); esta falla si alguien vuelve a
// escribir una auditoría o una dependiente condicionada a una coincidencia de horas o valores.
//
// Alcance: solo apps/worker/src (scripts/ y migrations/ también están en `TEST_ARCHIVOS_FUENTE`,
// pero los scripts de mantenimiento escriben su propia auditoría fuera del Worker).
import { uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  type CondicionDeEscritura,
  MARCADOR_CONDICION,
  porAuditoria,
  porMarca,
  porPkNueva,
  porReserva,
  sentenciaAuditoriaCondicional,
  sentenciaDependiente,
  type TablaConMarca,
} from '../src/auditoria/auditar';

const AUDITAR = 'apps/worker/src/auditoria/auditar.ts';
const HELPERS = ['sentenciaAuditoriaCondicional', 'sentenciaDependiente'] as const;

const fuentes = env.TEST_ARCHIVOS_FUENTE.filter(
  (a) => a.ruta.startsWith('apps/worker/src/') && a.ruta.endsWith('.ts'),
);

/** Texto de los argumentos de cada llamada a `nombre(…)` (paréntesis balanceados). */
function argumentosDe(contenido: string, nombre: string): string[] {
  const llamadas: string[] = [];
  let desde = 0;
  for (;;) {
    const inicio = contenido.indexOf(`${nombre}(`, desde);
    if (inicio < 0) {
      return llamadas;
    }
    let profundidad = 0;
    let i = inicio + nombre.length;
    for (; i < contenido.length; i += 1) {
      const c = contenido[i];
      if (c === '(') {
        profundidad += 1;
      } else if (c === ')') {
        profundidad -= 1;
        if (profundidad === 0) {
          break;
        }
      }
    }
    llamadas.push(contenido.slice(inicio + nombre.length + 1, i));
    desde = i;
  }
}

describe('A1: prueba estática de las condiciones de auditoría', () => {
  it('revisa el código del Worker', () => {
    expect(fuentes.length).toBeGreaterThan(30);
    expect(fuentes.some((a) => a.ruta === AUDITAR)).toBe(true);
  });

  it('ningún INSERT INTO audit_log fuera de auditar.ts', () => {
    const fuera = fuentes
      .filter((a) => a.ruta !== AUDITAR && /INSERT\s+INTO\s+audit_log/i.test(a.contenido))
      .map((a) => a.ruta);
    expect(fuera).toEqual([]);
  });

  it('ningún literal `{ sql: … }` pasado a los helpers de auditoría y dependientes', () => {
    const conLiteral = fuentes.flatMap((a) =>
      a.ruta === AUDITAR
        ? []
        : HELPERS.flatMap((nombre) =>
            argumentosDe(a.contenido, nombre)
              .filter((args) => /\{\s*sql\s*:/.test(args))
              .map(() => `${a.ruta}: ${nombre}`),
          ),
    );
    expect(conLiteral).toEqual([]);
  });

  it('ninguna condición EXISTS compara una hora con igualdad (`_at = ?`)', () => {
    const conHora = fuentes.flatMap((a) =>
      [...a.contenido.matchAll(/EXISTS\s*\(\s*SELECT[^)]*?\b\w+_at\s*=\s*\?/gi)].map(
        (m) => `${a.ruta}: ${m[0].replace(/\s+/g, ' ')}`,
      ),
    );
    expect(conHora).toEqual([]);
  });

  it('los helpers de auditoría y dependientes solo aceptan una CondicionDeEscritura', () => {
    const auditar = fuentes.find((a) => a.ruta === AUDITAR)?.contenido ?? '';
    for (const nombre of HELPERS) {
      const firma = new RegExp(`export function ${nombre}\\([^)]*condicion: CondicionDeEscritura`);
      expect(firma.test(auditar.replace(/\s+/g, ' ')), nombre).toBe(true);
    }
  });
});

describe('A1: comprobaciones en ejecución del tipo opaco', () => {
  const entrada = {
    entidad: 'devices' as const,
    entidad_id: 'x',
    accion: 'prueba',
    actor_id: null,
    device_id: null,
  };
  // Un literal con la forma de la condición (lo que el compilador ya rechaza sin el cast).
  const literal = { sql: '1 = 1', parametros: [] } as unknown as CondicionDeEscritura;

  it('rechaza una condición que no salió de un constructor', () => {
    expect(() => sentenciaAuditoriaCondicional(env.DB, entrada, literal)).toThrow(
      /CondicionDeEscritura/,
    );
    expect(() =>
      sentenciaDependiente(env.DB, `SELECT 1 WHERE ${MARCADOR_CONDICION}`, [], literal),
    ).toThrow(/CondicionDeEscritura/);
  });

  it('la dependiente exige el marcador al final, una sola vez', () => {
    const condicion = porAuditoria(uuidv7());
    expect(() => sentenciaDependiente(env.DB, 'SELECT 1', [], condicion)).toThrow(/terminar/);
    expect(() =>
      sentenciaDependiente(
        env.DB,
        `SELECT 1 WHERE ${MARCADOR_CONDICION} AND ${MARCADOR_CONDICION}`,
        [],
        condicion,
      ),
    ).toThrow(/terminar/);
    expect(() =>
      sentenciaDependiente(env.DB, `SELECT 1 WHERE ${MARCADOR_CONDICION}`, [], condicion),
    ).not.toThrow();
  });

  it('los constructores solo aceptan marcas del servidor y claves válidas', () => {
    const id = uuidv7();
    expect(() => porMarca('materials', { id }, 'no-es-uuid')).toThrow(/UUID v7/);
    expect(() => porMarca('audit_log' as TablaConMarca, { id }, uuidv7())).toThrow(/sin marca/);
    expect(() => porMarca('materials', {}, uuidv7())).toThrow(/vacía/);
    expect(() => porMarca('materials', { id: null }, uuidv7())).toThrow(/Clave inválida/);
    expect(() => porMarca('materials', { 'id; --': id }, uuidv7())).toThrow(/Clave inválida/);
    expect(() => porPkNueva('refresh_tokens', 'cliente-1')).toThrow(/UUID v7/);
    expect(() => porReserva(id, null, 'x')).toThrow(/UUID v7/);
    expect(() => porAuditoria('x')).toThrow(/UUID v7/);
    expect(porMarca('materials', { id }, uuidv7()).tipo).toBe('marca');
    expect(porPkNueva('users', id).tipo).toBe('pk_nueva');
    expect(porReserva(id, 'g', uuidv7(), { bloqueada: true }).sql).toContain('bloqueado_hasta');
  });
});
