// N2 (docs/correcciones-v1.2.md; hallazgo R-v12-01 de docs/auditoria/revision-esquema-v1.2.md):
// toda escritura de `users` renueva la marca `escritura_id` (ADR 0028), también las que no se
// auditan: el reinicio de `intentos_fallidos` del login correcto y el SQL del desbloqueo de
// emergencia. Si no, el testigo de concurrencia de la edición del admin (N1: `updated_at` y
// `escritura_id IS <leída>`) queda solo en `updated_at`, y una edición basada en una lectura vieja
// se aplica (y audita un `datos_antes` viejo) cuando la otra escritura cae en el mismo milisegundo.
//
// Técnica (determinista, como correcciones-a1-sesiones.test.ts): el admin lee el usuario; después
// las MISMAS sentencias del login (o el SQL de emergencia) escriben `users` con la hora fijada al
// `updated_at` leído; por último se ejecuta el plan de la edición del admin sobre la lectura vieja.
// D1 local real, sin mocks.
import { uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { generarSqlDesbloqueo } from '../../../scripts/desbloqueo-emergencia-sql.mjs';
import { sentenciasDesbloqueoHeredado } from '../src/auth/sesiones';
import { buscarUsuarioConMarca, planEditarUsuario } from '../src/rutas/usuarios';
import { contarAuditoria, horaFija } from './correcciones-a1-helpers';
import { crearDispositivo, crearUsuario } from './fixtures-db';

/** Usuario con fallos heredados SIN bloqueo, `updated_at = hora` y una marca conocida. */
async function escenario(hora: string) {
  const admin = await crearUsuario('admin');
  const adminDevice = await crearDispositivo(admin);
  const id = await crearUsuario('supervisor');
  const deviceId = await crearDispositivo(id);
  const marcaInicial = uuidv7();
  await env.DB.prepare(
    `UPDATE users SET intentos_fallidos = 3, bloqueado_hasta = NULL, updated_at = ?,
       escritura_id = ? WHERE id = ?`,
  )
    .bind(hora, marcaInicial, id)
    .run();
  const leido = await buscarUsuarioConMarca(env.DB, id);
  if (leido === null) {
    throw new Error('usuario inexistente');
  }
  expect(leido.fila).toMatchObject({ intentos_fallidos: 3, updated_at: hora });
  expect(leido.marca).toBe(marcaInicial);
  return { admin, adminDevice, id, deviceId, leido, marcaInicial };
}

/** Plan del admin (cambiar el nombre) sobre la lectura vieja, 1 ms después de `hora`. */
function editarSobreLecturaVieja(e: Awaited<ReturnType<typeof escenario>>, hora: string) {
  return planEditarUsuario(env.DB, {
    actual: e.leido.fila,
    marcaLeida: e.leido.marca,
    datos: { nombre: 'Nombre del admin' },
    actor: { userId: e.admin, deviceId: e.adminDevice },
    ahora: new Date(Date.parse(hora) + 1).toISOString(),
    alertaReloj: false,
    passwordHash: null,
  });
}

async function filaUsuario(id: string) {
  return env.DB.prepare(
    'SELECT nombre, intentos_fallidos, updated_at, escritura_id FROM users WHERE id = ?',
  )
    .bind(id)
    .first<{
      nombre: string;
      intentos_fallidos: number;
      updated_at: string;
      escritura_id: string | null;
    }>();
}

/**
 * La edición del admin no se aplicó y no auditó. Con `meta.changes` 0, la ruta relee la fila y,
 * como su marca ya no es la leída (y la edición no quita un admin), responde 409 `CONFLICTO`
 * (`motivoNoAplicado` en rutas/usuarios.ts).
 */
async function esperarConflicto(
  e: Awaited<ReturnType<typeof escenario>>,
  cambios: number | undefined,
): Promise<void> {
  expect(cambios, 'la edición basada en la lectura vieja no debe aplicarse').toBe(0);
  expect(await contarAuditoria('users', e.id, 'usuario.editar')).toBe(0);
  const releido = await buscarUsuarioConMarca(env.DB, e.id);
  expect(releido?.marca).not.toBe(e.leido.marca);
  expect(releido?.fila.nombre).not.toBe('Nombre del admin');
}

describe('N2: las escrituras de users sin auditar también renuevan la marca', () => {
  it('login correcto en el mismo milisegundo que la lectura del admin: la edición vieja → 409, sin auditar', async () => {
    const hora = horaFija();
    const e = await escenario(hora);

    // Las sentencias de `users` del login correcto (iniciarSesion), con la hora fijada a la leída.
    await env.DB.batch(sentenciasDesbloqueoHeredado(env.DB, e.id, e.deviceId, false, hora));
    const tras = await filaUsuario(e.id);
    expect(tras).toMatchObject({ intentos_fallidos: 0, updated_at: hora });
    // Sin bloqueo heredado no hay auditoría del desbloqueo (como antes).
    expect(await contarAuditoria('users', e.id, 'usuario.desbloqueado')).toBe(0);

    const [actualizacion] = await env.DB.batch(editarSobreLecturaVieja(e, hora).sentencias);
    await esperarConflicto(e, actualizacion?.meta.changes);
    // La marca nueva nunca es NULL (un NULL reabriría el ABA contra una lectura NULL).
    expect(tras?.escritura_id).not.toBeNull();
    expect(tras?.escritura_id).not.toBe(e.marcaInicial);
  });

  it('desbloqueo de emergencia en el mismo milisegundo: la edición vieja → 409, sin auditar; el SQL sigue idempotente', async () => {
    const hora = horaFija();
    const e = await escenario(hora);
    const fila = await env.DB.prepare('SELECT email FROM users WHERE id = ?')
      .bind(e.id)
      .first<{ email: string }>();
    const sentencias = generarSqlDesbloqueo({ email: fila?.email ?? '', ahora: new Date(hora) });
    for (const sentencia of sentencias) {
      await env.DB.prepare(sentencia).run();
    }
    const tras = await filaUsuario(e.id);
    expect(tras).toMatchObject({ intentos_fallidos: 0, updated_at: hora });

    // Idempotente: el mismo archivo otra vez no cambia nada (ni la marca) ni audita de nuevo.
    for (const sentencia of sentencias) {
      await env.DB.prepare(sentencia).run();
    }
    expect(await filaUsuario(e.id)).toEqual(tras);
    expect(await contarAuditoria('users', e.id, 'usuario.desbloqueado')).toBe(1);

    const [actualizacion] = await env.DB.batch(editarSobreLecturaVieja(e, hora).sentencias);
    await esperarConflicto(e, actualizacion?.meta.changes);
    expect(tras?.escritura_id).not.toBeNull();
    expect(tras?.escritura_id).not.toBe(e.marcaInicial);
  });

  it('sin otra escritura en medio, la misma edición del admin sí se aplica (control)', async () => {
    const hora = horaFija();
    const e = await escenario(hora);
    const [actualizacion] = await env.DB.batch(editarSobreLecturaVieja(e, hora).sentencias);
    expect(actualizacion?.meta.changes).toBe(1);
    expect(await contarAuditoria('users', e.id, 'usuario.editar')).toBe(1);
  });
});
