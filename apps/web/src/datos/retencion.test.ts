import { permisosDeRol, uuidv7, type Rol } from '@catmetal/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { crearVerificador } from '../auth/verificador';
import { db } from './db';
import { registrarConsumoLocal } from './outbox';
import { limpiarDb } from './pruebas/fabricas';
import { aplicarRetencionDelDispositivo, DIAS_CADUCIDAD_PERFIL } from './retencion';

const AHORA = new Date('2026-10-29T15:00:00.000Z');
const DIA = 86_400_000;
const haceDias = (dias: number) => new Date(AHORA.getTime() - dias * DIA).toISOString();

async function perfil(
  rol: Rol,
  ultimoAcceso: string | null,
  opciones: { verificador?: boolean } = {},
): Promise<string> {
  const id = uuidv7();
  await db.perfiles.put({
    user_id: id,
    perfil: {
      id,
      nombre: `Usuario ${rol}`,
      email: `${id}@catmetal.test`,
      rol,
      permisos: permisosDeRol(rol),
    },
    device_id: null,
    verificador: opciones.verificador === true ? await crearVerificador('clave', 1_000) : null,
    actualizado_at: ultimoAcceso ?? haceDias(40),
    ultimo_acceso_at: ultimoAcceso,
    cierre_pendiente: false,
  });
  return id;
}

const consumo = () => ({
  order_id: uuidv7(),
  material_id: uuidv7(),
  cantidad: 1,
  unidad: 'kg' as const,
  lote: 'L',
});

/** Registra un consumo y deja su mutación en `estado` (aplicada en `aplicadaAt`). */
async function mutacion(
  userId: string,
  estado: 'pendiente' | 'aplicada' | 'rechazada',
  aplicadaAt: string | null = null,
): Promise<{ id: string; mutation_id: string }> {
  const registrada = await registrarConsumoLocal(userId, consumo());
  if (estado !== 'pendiente') {
    await db.outbox.update(registrada.mutation_id, { estado, aplicada_at: aplicadaAt });
  }
  return registrada;
}

beforeEach(limpiarDb);

describe('retención de la tablet al arrancar (F4-04, ADR 0017 §5)', () => {
  it('purga las aplicadas fuera de la retención en TODAS las particiones (perfiles y meta)', async () => {
    const conPerfil = await perfil('supervisor', haceDias(1));
    const soloMeta = uuidv7();
    await db.meta.put({
      user_id: soloMeta,
      cursor: 0,
      epoca: 'e1',
      ultimo_sync_at: null,
      requiere_snapshot: false,
      motivo_snapshot: null,
      hidrataciones: [],
    });
    const viejaA = await mutacion(conPerfil, 'aplicada', haceDias(31));
    const recienteA = await mutacion(conPerfil, 'aplicada', haceDias(2));
    const viejaB = await mutacion(soloMeta, 'aplicada', haceDias(31));
    const rechazada = await mutacion(soloMeta, 'rechazada');

    const r = await aplicarRetencionDelDispositivo({ ahora: AHORA });

    expect(r).toMatchObject({ particiones: 2, mutaciones_purgadas: 2 });
    expect(await db.outbox.get(viejaA.mutation_id)).toBeUndefined();
    expect(await db.outbox.get(viejaB.mutation_id)).toBeUndefined();
    expect(await db.outbox.get(recienteA.mutation_id)).toBeDefined();
    // Las rechazadas nunca se borran solas (ADR 0012).
    expect(await db.outbox.get(rechazada.mutation_id)).toBeDefined();
  });

  it(`caduca los perfiles sin acceso en ${DIAS_CADUCIDAD_PERFIL} días y sin pendientes, con su partición`, async () => {
    expect(DIAS_CADUCIDAD_PERFIL).toBe(30);
    const caducado = await perfil('supervisor', haceDias(31), { verificador: true });
    const conPendientes = await perfil('supervisor', haceDias(45), { verificador: true });
    const reciente = await perfil('jefe', haceDias(29), { verificador: true });
    const sinAccesoNunca = await perfil('supervisor', null);
    const activo = await perfil('supervisor', haceDias(60));
    const conRechazo = await perfil('supervisor', haceDias(31));

    const viejo = await mutacion(caducado, 'aplicada', haceDias(35));
    await mutacion(conPendientes, 'pendiente');
    const rechazo = await mutacion(conRechazo, 'rechazada');

    const r = await aplicarRetencionDelDispositivo({ ahora: AHORA, excluir: activo });

    expect([...r.perfiles_caducados].sort()).toEqual([caducado, sinAccesoNunca, conRechazo].sort());
    // Perfil, verificador y partición del caducado: fuera.
    expect(await db.perfiles.get(caducado)).toBeUndefined();
    expect(await db.consumos.get([caducado, viejo.id])).toBeUndefined();
    expect(
      await db.trazabilidad.where('[user_id+ts]').between([caducado, ''], [caducado, '￿']).count(),
    ).toBe(0);
    // Con pendientes, reciente o con la sesión activa: se quedan.
    expect(await db.perfiles.get(conPendientes)).toBeDefined();
    expect(await db.perfiles.get(reciente)).toBeDefined();
    expect(await db.perfiles.get(activo)).toBeDefined();
    // Lo rechazado se conserva (dato de planta), aunque el perfil caduque.
    expect(await db.perfiles.get(conRechazo)).toBeUndefined();
    expect(await db.outbox.get(rechazo.mutation_id)).toBeDefined();
    expect(await db.consumos.get([conRechazo, rechazo.id])).toBeDefined();
  });

  it('borra el verificador que haya quedado de un admin (el admin no trabaja offline)', async () => {
    const admin = await perfil('admin', haceDias(1), { verificador: true });
    const jefe = await perfil('jefe', haceDias(1), { verificador: true });
    await db.perfiles.update(admin, { intentos_offline: 3 });

    const r = await aplicarRetencionDelDispositivo({ ahora: AHORA });

    expect(r.verificadores_admin).toBe(1);
    expect(await db.perfiles.get(admin)).toMatchObject({ verificador: null, intentos_offline: 0 });
    expect((await db.perfiles.get(jefe))!.verificador).not.toBeNull();
  });

  it('sin datos no hace nada', async () => {
    expect(await aplicarRetencionDelDispositivo()).toEqual({
      particiones: 0,
      mutaciones_purgadas: 0,
      fotos_liberadas: 0,
      perfiles_caducados: [],
      verificadores_admin: 0,
    });
  });
});
