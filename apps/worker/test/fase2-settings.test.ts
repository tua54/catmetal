// Configuración: /api/v1/settings (leer: autenticado; tolerancia: admin.gestionar, auditada).
import { type Configuracion, TOLERANCIA_PCT_DEFECTO } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { ejecutarPlan } from '../src/dominio/plan';
import { cambiarTolerancia, leerTolerancia, toleranciaDeResultado } from '../src/dominio/settings';
import {
  api,
  auditoriaDesde,
  contextoDe,
  esperarError,
  json,
  sesion,
  type SesionDeRol,
  ultimoSeq,
} from './fase2-helpers';

let admin: SesionDeRol;
let jefe: SesionDeRol;
let supervisor: SesionDeRol;

beforeAll(async () => {
  [admin, jefe, supervisor] = await Promise.all([
    sesion('admin'),
    sesion('jefe'),
    sesion('supervisor'),
  ]);
});

function cambiar(token: string | undefined, body: unknown) {
  return api('/settings/tolerancia', { method: 'PATCH', token, body });
}

describe('GET /settings', () => {
  it.each(['supervisor', 'jefe', 'admin'] as const)(
    'un %s lee solo la tolerancia (sin la época de sync)',
    async (rol) => {
      const token = { supervisor, jefe, admin }[rol].token;
      const respuesta = await api('/settings', { token });
      expect(respuesta.status).toBe(200);
      expect(await respuesta.json<Configuracion>()).toEqual({
        tolerancia_pct: TOLERANCIA_PCT_DEFECTO,
      });
    },
  );

  it('sin sesión responde 401', async () => {
    await esperarError(await api('/settings'), 401, 'NO_AUTENTICADO');
  });
});

describe('PATCH /settings/tolerancia', () => {
  it.each(['supervisor', 'jefe'] as const)('un %s recibe 403', async (rol) => {
    const token = { supervisor, jefe }[rol].token;
    await esperarError(await cambiar(token, { tolerancia_pct: 9 }), 403, 'PERMISO_DENEGADO');
  });

  it('sin sesión responde 401', async () => {
    await esperarError(await cambiar(undefined, { tolerancia_pct: 9 }), 401, 'NO_AUTENTICADO');
  });

  it.each([{ tolerancia_pct: -1 }, { tolerancia_pct: 101 }, { tolerancia_pct: 1.234 }, {}])(
    'rechaza %j con 400',
    async (body) => {
      await esperarError(await cambiar(admin.token, body), 400, 'VALIDACION');
    },
  );

  it('el admin la cambia; queda auditada con antes y después', async () => {
    const antes = await ultimoSeq();
    const respuesta = await cambiar(admin.token, { tolerancia_pct: 7.5 });
    expect(respuesta.status).toBe(200);
    expect(await respuesta.json<Configuracion>()).toEqual({ tolerancia_pct: 7.5 });
    expect(await (await api('/settings', { token: supervisor.token })).json()).toEqual({
      tolerancia_pct: 7.5,
    });
    const filas = await auditoriaDesde(antes);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      entidad: 'settings',
      entidad_id: 'tolerancia_pct',
      accion: 'settings.tolerancia',
      actor_id: admin.usuario.id,
      device_id: admin.deviceId,
    });
    expect(json(filas[0]?.datos_antes ?? null)).toMatchObject({
      clave: 'tolerancia_pct',
      valor: 5,
    });
    expect(json(filas[0]?.datos_despues ?? null)).toMatchObject({
      clave: 'tolerancia_pct',
      valor: 7.5,
      actualizado_por: admin.usuario.id,
    });
    const fila = await env.DB.prepare(
      `SELECT valor, actualizado_por FROM settings WHERE clave = 'tolerancia_pct'`,
    ).first<{ valor: string; actualizado_por: string }>();
    expect(fila).toEqual({ valor: '7.5', actualizado_por: admin.usuario.id });
    expect(await leerTolerancia(env.DB)).toBe(7.5);
  });

  it('si otro admin la cambió entre la lectura y la escritura: 409 y sin auditoría', async () => {
    const ctx = await contextoDe('admin');
    const plan = await cambiarTolerancia(ctx, { tolerancia_pct: 3 });
    expect((await cambiar(admin.token, { tolerancia_pct: 4 })).status).toBe(200);
    const antes = await ultimoSeq();
    await expect(ejecutarPlan(env.DB, plan)).rejects.toMatchObject({ code: 'CONFLICTO' });
    expect(await auditoriaDesde(antes)).toHaveLength(0);
    expect(await leerTolerancia(env.DB)).toBe(4);
  });

  it('toleranciaDeResultado usa la de la spec si no hay fila o el valor no es válido', () => {
    expect(toleranciaDeResultado(undefined)).toBe(TOLERANCIA_PCT_DEFECTO);
    const resultado = (valor: string) =>
      ({ results: [{ valor }], success: true, meta: {} }) as unknown as D1Result;
    expect(toleranciaDeResultado(resultado('"cinco"'))).toBe(TOLERANCIA_PCT_DEFECTO);
    expect(toleranciaDeResultado(resultado('-2'))).toBe(TOLERANCIA_PCT_DEFECTO);
    expect(toleranciaDeResultado(resultado('6'))).toBe(6);
  });
});
