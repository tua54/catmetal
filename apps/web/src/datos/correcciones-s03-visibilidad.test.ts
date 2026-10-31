// S-03 (docs/auditoria/seguridad-correcciones.md): tras bajar el rol (jefe → supervisor) y el
// `reiniciar`, la tablet conservaba hasta que terminara el snapshot lo que el usuario veía como jefe
// (consumos ajenos). Si el perfil NUEVO ya no tiene `auditoria.ver_todo` ni `consumos.validar`, se
// borran en el acto los consumos AJENOS (y sus hijos) sin mutaciones pendientes, solo en la
// partición de ese usuario. Lo propio, lo protegido y lo de otras particiones no se toca; lo que siga
// siendo visible lo vuelve a traer el snapshot.

import { permisosDeRol, uuidv7, type Perfil } from '@catmetal/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { crearServidorFalso, type ServidorFalso } from '../auth/pruebas/servidor-falso';
import { GestorSesion } from '../auth/sesion';
import { aplicarEntidades } from './aplicar-cambios';
import { db } from './db';
import { aprobarLocal, registrarConsumoLocal } from './outbox';
import {
  consumoServidor,
  evidenciaServidor,
  limpiarDb,
  novedadServidor,
  validacionServidor,
} from './pruebas/fabricas';
import { purgarAjenosSinVisibilidad } from './visibilidad';

const CLAVE = 'clave-segura-beto';
const OTRO = uuidv7();

let servidor: ServidorFalso;
let beto: Perfil;

function gestor(): GestorSesion {
  return new GestorSesion({
    fetch: servidor.fetch,
    locks: null,
    iteraciones: 1_000,
    iteracionesMinimas: 1_000,
    enLinea: () => true,
  });
}

/** Partición de `userId` como la deja un jefe: consumos ajenos con hijos, uno propio, y más. */
async function particionDeJefe(userId: string) {
  const ordenAsignada = uuidv7();
  const ajeno = consumoServidor({ registrado_por: OTRO });
  const novedad = novedadServidor({ consumption_id: ajeno.id, registrado_por: OTRO });
  const foto = evidenciaServidor({ incident_id: novedad.id });
  const validacion = validacionServidor({ consumption_id: ajeno.id, validado_por: OTRO });
  const ajenoConCola = consumoServidor({ registrado_por: OTRO });
  const ajenoDeOrdenAsignada = consumoServidor({ registrado_por: OTRO, order_id: ordenAsignada });
  const propio = consumoServidor({ registrado_por: userId });
  await aplicarEntidades(userId, [
    { entidad: 'consumptions', id: ajeno.id, datos: { ...ajeno } },
    { entidad: 'incidents', id: novedad.id, datos: { ...novedad } },
    { entidad: 'evidences', id: foto.id, datos: { ...foto, subido: true } },
    { entidad: 'validations', id: validacion.id, datos: { ...validacion } },
    { entidad: 'consumptions', id: ajenoConCola.id, datos: { ...ajenoConCola } },
    { entidad: 'consumptions', id: ajenoDeOrdenAsignada.id, datos: { ...ajenoDeOrdenAsignada } },
    { entidad: 'consumptions', id: propio.id, datos: { ...propio } },
    {
      entidad: 'order_supervisors',
      id: uuidv7(),
      datos: {
        id: uuidv7(),
        order_id: ordenAsignada,
        user_id: userId,
        nombre: 'Beto',
        asignado_por: null,
        activo: true,
      },
    },
  ]);
  // Una aprobación del jefe que aún no sale: ese consumo ajeno queda protegido.
  await aprobarLocal(userId, { consumption_id: ajenoConCola.id });
  return { ajeno, novedad, foto, validacion, ajenoConCola, ajenoDeOrdenAsignada, propio };
}

beforeEach(async () => {
  await limpiarDb();
  servidor = crearServidorFalso();
  beto = servidor.agregarUsuario('Beto Ruiz', 'beto@catmetal.co', CLAVE, 'jefe');
});

describe('S-03: purga de lo ajeno al perder la visibilidad amplia', () => {
  it('borra los ajenos sin pendientes (con sus hijos) y conserva lo propio, lo protegido y lo asignado', async () => {
    const p = await particionDeJefe(beto.id);
    const otraParticion = consumoServidor({ registrado_por: OTRO });
    await aplicarEntidades(OTRO, [
      { entidad: 'consumptions', id: otraParticion.id, datos: { ...otraParticion } },
    ]);

    const borrados = await purgarAjenosSinVisibilidad(beto.id);
    expect(borrados).toBe(1);
    expect(await db.consumos.get([beto.id, p.ajeno.id])).toBeUndefined();
    expect(await db.novedades.get([beto.id, p.novedad.id])).toBeUndefined();
    expect(await db.evidencias.get([beto.id, p.foto.id])).toBeUndefined();
    expect(await db.validaciones.get([beto.id, p.validacion.id])).toBeUndefined();
    expect(await db.consumos.get([beto.id, p.ajenoConCola.id])).toBeDefined();
    expect(await db.consumos.get([beto.id, p.ajenoDeOrdenAsignada.id])).toBeDefined();
    expect(await db.consumos.get([beto.id, p.propio.id])).toBeDefined();
    expect(await db.consumos.get([OTRO, otraParticion.id])).toBeDefined();
    expect(await db.outbox.where('user_id').equals(beto.id).count()).toBe(1);
  });

  it('al iniciar sesión con el rol bajado (jefe → supervisor) se purga en el acto', async () => {
    const s = gestor();
    await s.iniciarSesion('beto@catmetal.co', CLAVE);
    const p = await particionDeJefe(beto.id);
    const propioPendiente = await registrarConsumoLocal(beto.id, {
      order_id: uuidv7(),
      material_id: uuidv7(),
      cantidad: 1,
      unidad: 'kg',
      lote: 'L',
    });

    // El admin le baja el rol; el próximo login trae el perfil nuevo.
    beto.rol = 'supervisor';
    beto.permisos = permisosDeRol('supervisor');
    await s.iniciarSesion('beto@catmetal.co', CLAVE);
    expect(s.estado().permisos).not.toContain('consumos.validar');

    expect(await db.consumos.get([beto.id, p.ajeno.id])).toBeUndefined();
    expect(await db.consumos.get([beto.id, p.ajenoConCola.id])).toBeDefined();
    expect(await db.consumos.get([beto.id, p.propio.id])).toBeDefined();
    expect(await db.consumos.get([beto.id, propioPendiente.id])).toBeDefined();
  });

  it('también con el refresh (la sesión de la cookie trae el perfil nuevo)', async () => {
    const s = gestor();
    await s.iniciarSesion('beto@catmetal.co', CLAVE);
    const p = await particionDeJefe(beto.id);
    beto.rol = 'supervisor';
    beto.permisos = permisosDeRol('supervisor');
    expect(await s.refrescar()).not.toBeNull();
    expect(await db.consumos.get([beto.id, p.ajeno.id])).toBeUndefined();
  });

  it('sin bajada de rol no se borra nada (jefe que vuelve a entrar)', async () => {
    const s = gestor();
    await s.iniciarSesion('beto@catmetal.co', CLAVE);
    const p = await particionDeJefe(beto.id);
    await s.iniciarSesion('beto@catmetal.co', CLAVE);
    await s.refrescar();
    expect(await db.consumos.get([beto.id, p.ajeno.id])).toBeDefined();
  });
});
