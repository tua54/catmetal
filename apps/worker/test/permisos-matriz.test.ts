// Tarea 1.4: cada regla de la tabla de docs/spec.md §3 tiene una prueba positiva y una negativa.
//
// Se monta una app Hono de prueba con los middlewares REALES (`autenticar` + `requierePermiso`),
// una ruta por permiso, contra la D1 local real. Cada rol tiene un usuario real con login real.
//
// Alcance en la Fase 1: aquí se prueba el permiso por ROL (¿puede este rol hacer este tipo de
// acción?). Las restricciones de DATOS de la tabla se prueban en la Fase 2, por endpoint:
//   - "Ver órdenes: solo asignadas" (supervisor) y "Ver auditoría: solo lo propio" (supervisor).
//   - "Registrar consumo: órdenes asignadas en proceso" (supervisor).
//   - "Aprobar / rechazar: nunca uno propio" (jefe).
//   - "Editar consumo propio pendiente": solo propio y en estado pendiente.
// Por eso el supervisor aparece denegado en `ordenes.ver_todas` y `auditoria.ver_todo`: no tiene
// el permiso "todas", solo la visibilidad restringida que llega con los endpoints de la Fase 2.
import {
  MENSAJES_ERROR,
  PERMISOS,
  PERMISOS_POR_ROL,
  type Permiso,
  type Rol,
} from '@catmetal/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { crearAppDePrueba, llamar, type SesionDeRol, sesionReal } from './permisos-helpers';

interface FilaTabla {
  /** Texto de la fila en docs/spec.md §3. */
  fila: string;
  permiso: Permiso;
  /** Roles con ✅ para ese permiso (los demás quedan denegados). */
  permitidos: readonly Rol[];
}

const ROLES: readonly Rol[] = ['supervisor', 'jefe', 'admin'];

// Transcripción literal de la tabla de docs/spec.md §3 (solo el permiso por rol).
const TABLA_S3: readonly FilaTabla[] = [
  { fila: 'Ver órdenes (todas)', permiso: 'ordenes.ver_todas', permitidos: ['jefe', 'admin'] },
  {
    fila: 'Crear / iniciar / finalizar orden',
    permiso: 'ordenes.gestionar',
    permitidos: ['jefe', 'admin'],
  },
  {
    fila: 'Registrar consumo',
    permiso: 'consumos.registrar',
    permitidos: ['supervisor', 'jefe'],
  },
  {
    fila: 'Editar consumo propio pendiente',
    permiso: 'consumos.editar_propio',
    permitidos: ['supervisor'],
  },
  {
    fila: 'Registrar novedad + evidencia',
    permiso: 'novedades.registrar',
    permitidos: ['supervisor', 'jefe'],
  },
  { fila: 'Aprobar / rechazar consumo', permiso: 'consumos.validar', permitidos: ['jefe'] },
  { fila: 'Ver auditoría (todo)', permiso: 'auditoria.ver_todo', permitidos: ['jefe', 'admin'] },
  {
    fila: 'Gestionar usuarios, materiales, asignaciones y tolerancia',
    permiso: 'admin.gestionar',
    permitidos: ['admin'],
  },
];

describe('§3 la tabla de permisos de shared coincide con la spec', () => {
  it('la transcripción cubre cada permiso exactamente una vez', () => {
    expect(TABLA_S3.map((f) => f.permiso).sort()).toEqual([...PERMISOS].sort());
  });

  it.each(ROLES)('PERMISOS_POR_ROL.%s es exactamente el de la tabla', (rol) => {
    const esperado = TABLA_S3.filter((f) => f.permitidos.includes(rol)).map((f) => f.permiso);
    expect([...PERMISOS_POR_ROL[rol]].sort()).toEqual(esperado.sort());
  });
});

describe('§3 matriz de permisos con sesión real', () => {
  const app = crearAppDePrueba();
  const sesiones = {} as Record<Rol, SesionDeRol>;

  beforeAll(async () => {
    for (const rol of ROLES) {
      sesiones[rol] = await sesionReal(rol);
    }
  });

  for (const { fila, permiso, permitidos } of TABLA_S3) {
    describe(`§3 ${fila}`, () => {
      for (const rol of ROLES) {
        if (permitidos.includes(rol)) {
          it(`§3 ${fila} — ${rol} permitido (${permiso})`, async () => {
            const respuesta = await llamar(app, permiso, sesiones[rol].token);
            expect(respuesta.status).toBe(200);
            expect(await respuesta.json()).toEqual({ ok: true, permiso, rol });
          });
        } else {
          it(`§3 ${fila} — ${rol} denegado (${permiso})`, async () => {
            const respuesta = await llamar(app, permiso, sesiones[rol].token);
            expect(respuesta.status).toBe(403);
            expect(await respuesta.json()).toEqual({
              code: 'PERMISO_DENEGADO',
              message: MENSAJES_ERROR.PERMISO_DENEGADO,
            });
          });
        }
      }

      it(`§3 ${fila} — sin sesión responde 401 NO_AUTENTICADO (${permiso})`, async () => {
        const respuesta = await llamar(app, permiso);
        expect(respuesta.status).toBe(401);
        expect(await respuesta.json()).toEqual({
          code: 'NO_AUTENTICADO',
          message: MENSAJES_ERROR.NO_AUTENTICADO,
        });
      });
    });
  }
});
