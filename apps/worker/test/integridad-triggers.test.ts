// Comportamiento de los triggers de inmutabilidad (migrations/0001_triggers.sql, ADR 0006) sobre
// la D1 local real. Cada prueba crea sus propios datos con ids nuevos.
import { uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  ahora,
  crearAuditoria,
  crearConsumo,
  crearDispositivo,
  crearEscenario,
  crearEvidencia,
  crearMaterial,
  crearMutacionSync,
  crearNovedad,
  crearOrden,
  crearUsuario,
  decidir,
  type Escenario,
  insertar,
  sentenciaDecidir,
  sentenciaInsert,
  valoresConsumo,
  valoresValidacion,
} from './fixtures-db';

async function ejecutar(sql: string, ...parametros: (string | number | null)[]) {
  return env.DB.prepare(sql)
    .bind(...parametros)
    .run();
}

async function fila<T = Record<string, unknown>>(sql: string, ...parametros: (string | number)[]) {
  return env.DB.prepare(sql)
    .bind(...parametros)
    .first<T>();
}

describe('audit_log', () => {
  it('UPDATE falla con "audit_log es inmutable"', async () => {
    const id = await crearAuditoria();
    await expect(ejecutar(`UPDATE audit_log SET accion = 'otra' WHERE id = ?`, id)).rejects.toThrow(
      /audit_log es inmutable/,
    );
    expect(await fila('SELECT accion FROM audit_log WHERE id = ?', id)).toEqual({
      accion: 'crear',
    });
  });

  it('DELETE falla con "audit_log es inmutable"', async () => {
    const id = await crearAuditoria();
    await expect(ejecutar('DELETE FROM audit_log WHERE id = ?', id)).rejects.toThrow(
      /audit_log es inmutable/,
    );
    expect(await fila('SELECT id FROM audit_log WHERE id = ?', id)).toEqual({ id });
  });

  it('seq crece en cada inserción', async () => {
    const a = await crearAuditoria();
    const b = await crearAuditoria();
    const seqA = await fila<{ seq: number }>('SELECT seq FROM audit_log WHERE id = ?', a);
    const seqB = await fila<{ seq: number }>('SELECT seq FROM audit_log WHERE id = ?', b);
    expect(seqB?.seq).toBeGreaterThan(seqA?.seq ?? Infinity);
  });

  it('insertar un seq explícito menor al máximo falla', async () => {
    await crearAuditoria();
    await crearAuditoria();
    // Como seq no tiene huecos (audit_log_seq_sin_saltos), los únicos valores libres por debajo
    // del máximo son 0 y los negativos.
    for (const seq of [0, -1]) {
      await expect(crearAuditoria({ seq })).rejects.toThrow(/audit_log\.seq debe ser creciente/);
    }
  });

  it('un seq explícito igual al máximo + 1 se acepta (restauración ordenada)', async () => {
    const maximo = await fila<{ m: number }>('SELECT MAX(seq) AS m FROM audit_log');
    const id = await crearAuditoria({ seq: (maximo?.m ?? 0) + 1 });
    expect(await fila('SELECT seq FROM audit_log WHERE id = ?', id)).toEqual({
      seq: (maximo?.m ?? 0) + 1,
    });
    // Y el siguiente automático continúa sin hueco.
    const siguiente = await crearAuditoria();
    expect(await fila('SELECT seq FROM audit_log WHERE id = ?', siguiente)).toEqual({
      seq: (maximo?.m ?? 0) + 2,
    });
  });

  it('un seq explícito con salto falla (audit_log_seq_sin_saltos, H11)', async () => {
    const maximo = await fila<{ m: number }>('SELECT MAX(seq) AS m FROM audit_log');
    for (const seq of [(maximo?.m ?? 0) + 2, (maximo?.m ?? 0) + 5, Number.MAX_SAFE_INTEGER]) {
      await expect(crearAuditoria({ seq })).rejects.toThrow(/audit_log\.seq no admite saltos/);
    }
    // El cursor sigue sano: la siguiente inserción automática funciona y es max + 1.
    const id = await crearAuditoria();
    expect(await fila('SELECT seq FROM audit_log WHERE id = ?', id)).toEqual({
      seq: (maximo?.m ?? 0) + 1,
    });
  });

  it('un INSERT … SELECT de varias filas no deja huecos', async () => {
    const antes = await fila<{ m: number }>('SELECT MAX(seq) AS m FROM audit_log');
    const t = ahora();
    await ejecutar(
      `INSERT INTO audit_log (id, entidad, entidad_id, accion, server_at, created_at, updated_at)
       SELECT ? || value, 'prueba', 'x', 'lote', ?, ?, ? FROM json_each('[1,2,3]')`,
      uuidv7(),
      t,
      t,
      t,
    );
    const despues = await fila<{ m: number }>('SELECT MAX(seq) AS m FROM audit_log');
    expect((despues?.m ?? 0) - (antes?.m ?? 0)).toBe(3);
  });
});

describe('nada se borra (<tabla>_no_delete)', () => {
  // Fixture mínimo y válido por tabla: [tabla, cláusula WHERE, parámetros].
  const casos: [string, () => Promise<[string, string[]]>][] = [
    ['users', async () => ['id = ?', [await crearUsuario()]]],
    ['devices', async () => ['id = ?', [await crearDispositivo(await crearUsuario())]]],
    ['materials', async () => ['id = ?', [await crearMaterial()]]],
    ['production_orders', async () => ['id = ?', [await crearOrden(await crearUsuario('jefe'))]]],
    [
      'order_supervisors',
      async () => {
        const e = await crearEscenario();
        await insertar('order_supervisors', {
          order_id: e.orden,
          user_id: e.supervisor,
          asignado_por: e.jefe,
          created_at: ahora(),
          updated_at: ahora(),
        });
        return ['order_id = ? AND user_id = ?', [e.orden, e.supervisor]];
      },
    ],
    [
      'order_planned_materials',
      async () => {
        const e = await crearEscenario();
        await insertar('order_planned_materials', {
          order_id: e.orden,
          material_id: e.material,
          cantidad_planeada: 500,
          unidad: 'kg',
          created_at: ahora(),
          updated_at: ahora(),
        });
        return ['order_id = ? AND material_id = ?', [e.orden, e.material]];
      },
    ],
    ['consumptions', async () => ['id = ?', [await crearConsumo(await crearEscenario())]]],
    [
      'incidents',
      async () => {
        const e = await crearEscenario();
        return ['id = ?', [await crearNovedad(await crearConsumo(e), e.supervisor)]];
      },
    ],
    [
      'evidences',
      async () => {
        const e = await crearEscenario();
        const novedad = await crearNovedad(await crearConsumo(e), e.supervisor);
        return ['id = ?', [await crearEvidencia(novedad)]];
      },
    ],
    [
      'validations',
      async () => {
        const e = await crearEscenario();
        const consumo = await crearConsumo(e);
        await decidir(consumo, e.jefe, 'aprobado');
        const v = await fila<{ id: string }>(
          'SELECT id FROM validations WHERE consumption_id = ?',
          consumo,
        );
        return ['id = ?', [v?.id ?? '']];
      },
    ],
    [
      'sync_mutations',
      async () => {
        const usuario = await crearUsuario();
        const id = await crearMutacionSync(usuario, await crearDispositivo(usuario));
        return ['mutation_id = ?', [id]];
      },
    ],
    ['settings', () => Promise.resolve(['clave = ?', ['tolerancia_pct']])],
  ];

  it('la lista cubre las 12 tablas de la ADR 0006', () => {
    expect(casos.map(([tabla]) => tabla).sort()).toEqual(
      [
        'consumptions',
        'incidents',
        'validations',
        'evidences',
        'production_orders',
        'users',
        'sync_mutations',
        'order_supervisors',
        'order_planned_materials',
        'materials',
        'settings',
        'devices',
      ].sort(),
    );
  });

  it.each(casos)('DELETE en %s falla y la fila sigue ahí', async (tabla, preparar) => {
    const [donde, parametros] = await preparar();
    const contar = () =>
      fila<{ n: number }>(`SELECT COUNT(*) AS n FROM ${tabla} WHERE ${donde}`, ...parametros);
    expect((await contar())?.n).toBe(1);
    await expect(ejecutar(`DELETE FROM ${tabla} WHERE ${donde}`, ...parametros)).rejects.toThrow(
      new RegExp(`${tabla} no admite DELETE`),
    );
    expect((await contar())?.n).toBe(1);
  });
});

describe('consumptions', () => {
  it('editar un pendiente incrementando version en 1 funciona', async () => {
    const e = await crearEscenario();
    const id = await crearConsumo(e);
    await ejecutar(
      `UPDATE consumptions SET cantidad = 12, cantidad_en_unidad_plan = 12, lote = 'L-002',
       version = version + 1, updated_at = ? WHERE id = ?`,
      ahora(),
      id,
    );
    expect(await fila('SELECT cantidad, lote, version FROM consumptions WHERE id = ?', id)).toEqual(
      { cantidad: 12, lote: 'L-002', version: 2 },
    );
  });

  it('editar sin incrementar version (o saltando versiones) falla', async () => {
    const e = await crearEscenario();
    const id = await crearConsumo(e);
    await expect(
      ejecutar('UPDATE consumptions SET cantidad = 12 WHERE id = ?', id),
    ).rejects.toThrow(/incrementar version en 1/);
    await expect(
      ejecutar('UPDATE consumptions SET cantidad = 12, version = version + 2 WHERE id = ?', id),
    ).rejects.toThrow(/incrementar version en 1/);
    expect(await fila('SELECT cantidad, version FROM consumptions WHERE id = ?', id)).toEqual({
      cantidad: 10.5,
      version: 1,
    });
  });

  it.each([
    ['registrado_por', (e: Escenario) => Promise.resolve(e.jefe)],
    ['device_id', (e: Escenario) => Promise.resolve(e.dispositivoJefe)],
    ['order_id', (e: Escenario) => crearOrden(e.jefe)],
    ['client_created_at', () => Promise.resolve('2020-01-01T00:00:00.000Z')],
    ['server_received_at', () => Promise.resolve('2020-01-01T00:00:00.000Z')],
    ['created_at', () => Promise.resolve('2020-01-01T00:00:00.000Z')],
    ['registro_tardio', () => Promise.resolve(1)],
  ] as const)('cambiar %s falla (autoría inmutable)', async (columna, nuevoValor) => {
    const e = await crearEscenario();
    const id = await crearConsumo(e);
    await expect(
      ejecutar(
        `UPDATE consumptions SET ${columna} = ?, version = version + 1 WHERE id = ?`,
        await nuevoValor(e),
        id,
      ),
    ).rejects.toThrow(/la autoría de un consumo es inmutable/);
  });

  it('cambiar corrige_a falla (autoría inmutable)', async () => {
    const e = await crearEscenario();
    const rechazado = await crearConsumo(e);
    await decidir(rechazado, e.jefe, 'rechazado');
    const id = await crearConsumo(e);
    await expect(
      ejecutar(
        'UPDATE consumptions SET corrige_a = ?, version = version + 1 WHERE id = ?',
        rechazado,
        id,
      ),
    ).rejects.toThrow(/la autoría de un consumo es inmutable/);
  });

  it('cambiar el estado sin fila de validación falla', async () => {
    const e = await crearEscenario();
    const id = await crearConsumo(e);
    await expect(env.DB.batch([sentenciaDecidir(id, 'aprobado')])).rejects.toThrow(
      /solo cambia con su validación/,
    );
    expect(await fila('SELECT estado FROM consumptions WHERE id = ?', id)).toEqual({
      estado: 'pendiente',
    });
  });

  it('un UPDATE que contradice la validación falla y el batch no deja nada', async () => {
    const e = await crearEscenario();
    const id = await crearConsumo(e);
    // La validación ya aplica "aprobado" (validations_aplica_decision); el UPDATE posterior a
    // "rechazado" lo frena consumptions_decidido_inmutable.
    await expect(
      env.DB.batch([
        sentenciaInsert('validations', valoresValidacion(id, e.jefe, 'aprobado')),
        sentenciaDecidir(id, 'rechazado'),
      ]),
    ).rejects.toThrow(/aprobado o rechazado es inmutable|solo cambia con su validación/);
    // El batch es atómico: tampoco quedó la validación y el consumo sigue pendiente.
    expect(await fila('SELECT id FROM validations WHERE consumption_id = ?', id)).toBeNull();
    expect(await fila('SELECT estado, version FROM consumptions WHERE id = ?', id)).toEqual({
      estado: 'pendiente',
      version: 1,
    });
  });

  it.each(['aprobado', 'rechazado'] as const)(
    'insertar la validación aplica la decisión %s y version + 1 (validations_aplica_decision)',
    async (decision) => {
      const e = await crearEscenario();
      const id = await crearConsumo(e);
      const motivo = decision === 'rechazado' ? 'No corresponde al lote' : null;
      const validacion = valoresValidacion(id, e.jefe, decision, motivo);
      await insertar('validations', validacion);
      expect(
        await fila('SELECT estado, version, updated_at FROM consumptions WHERE id = ?', id),
      ).toEqual({ estado: decision, version: 2, updated_at: validacion.server_received_at });
    },
  );

  it('el UPDATE explícito tras la validación (patrón anterior) ya no aplica', async () => {
    const e = await crearEscenario();
    const id = await crearConsumo(e);
    await expect(
      env.DB.batch([
        sentenciaInsert('validations', valoresValidacion(id, e.jefe, 'aprobado')),
        sentenciaDecidir(id, 'aprobado'),
      ]),
    ).rejects.toThrow(/aprobado o rechazado es inmutable/);
  });

  it.each(['aprobado', 'rechazado'] as const)(
    'cualquier UPDATE de un consumo %s falla',
    async (decision) => {
      const e = await crearEscenario();
      const id = await crearConsumo(e);
      await decidir(id, e.jefe, decision);
      const otroMaterial = await crearMaterial();
      const cambios: [string, string | number][] = [
        ['cantidad', 99],
        ['unidad', 'g'],
        ['material_id', otroMaterial],
        ['lote', 'L-999'],
        ['requiere_novedad', 1],
        ['updated_at', ahora()],
      ];
      for (const [columna, valor] of cambios) {
        await expect(
          ejecutar(
            `UPDATE consumptions SET ${columna} = ?, version = version + 1 WHERE id = ?`,
            valor,
            id,
          ),
          columna,
        ).rejects.toThrow(/un consumo aprobado o rechazado es inmutable/);
      }
      // Volver a pendiente lo frenan tres triggers (decidido_inmutable, estado_con_validacion y
      // validado_no_se_edita); SQLite no documenta cuál se dispara primero.
      await expect(
        ejecutar(
          `UPDATE consumptions SET estado = 'pendiente', version = version + 1 WHERE id = ?`,
          id,
        ),
      ).rejects.toThrow(
        /aprobado o rechazado es inmutable|solo cambia con su validación|con validación no se edita/,
      );
      expect(
        await fila('SELECT estado, cantidad, version FROM consumptions WHERE id = ?', id),
      ).toEqual({ estado: decision, cantidad: 10.5, version: 2 });
    },
  );

  it('corrige_a a un consumo rechazado funciona', async () => {
    const e = await crearEscenario();
    const rechazado = await crearConsumo(e);
    await decidir(rechazado, e.jefe, 'rechazado');
    const correccion = await crearConsumo(e, { corrige_a: rechazado });
    expect(await fila('SELECT corrige_a FROM consumptions WHERE id = ?', correccion)).toEqual({
      corrige_a: rechazado,
    });
  });

  it('corrige_a a un consumo pendiente, aprobado o inexistente falla', async () => {
    const e = await crearEscenario();
    const pendiente = await crearConsumo(e);
    const aprobado = await crearConsumo(e);
    await decidir(aprobado, e.jefe, 'aprobado');
    for (const objetivo of [pendiente, aprobado]) {
      await expect(crearConsumo(e, { corrige_a: objetivo })).rejects.toThrow(
        /corrige_a solo puede apuntar a un consumo rechazado/,
      );
    }
    // Con un id inexistente lo frenan dos triggers BEFORE INSERT (corrige_rechazado y
    // insercion_valida: "misma orden"); SQLite no documenta cuál se dispara primero.
    await expect(crearConsumo(e, { corrige_a: uuidv7() })).rejects.toThrow(
      /corrige_a solo puede apuntar a un consumo rechazado|corrige_a debe ser un consumo de la misma orden/,
    );
  });

  it('dos correcciones del mismo rechazado fallan (índice único parcial)', async () => {
    const e = await crearEscenario();
    const rechazado = await crearConsumo(e);
    await decidir(rechazado, e.jefe, 'rechazado');
    await crearConsumo(e, { corrige_a: rechazado });
    await expect(crearConsumo(e, { corrige_a: rechazado })).rejects.toThrow(
      /UNIQUE constraint failed: consumptions\.corrige_a/,
    );
  });

  it('varios consumos sin corrige_a conviven (el índice único es parcial)', async () => {
    const e = await crearEscenario();
    await crearConsumo(e);
    await crearConsumo(e);
    const n = await fila<{ n: number }>(
      'SELECT COUNT(*) AS n FROM consumptions WHERE order_id = ? AND corrige_a IS NULL',
      e.orden,
    );
    expect(n?.n).toBe(2);
  });
});

describe('validations', () => {
  it('autoaprobación falla (S9)', async () => {
    const e = await crearEscenario();
    // El jefe registra un consumo y lo intenta aprobar él mismo.
    const id = await crearConsumo(e, { registrado_por: e.jefe, device_id: e.dispositivoJefe });
    await expect(
      insertar('validations', valoresValidacion(id, e.jefe, 'aprobado')),
    ).rejects.toThrow(/nadie valida un consumo que registró/);
    await expect(
      insertar('validations', valoresValidacion(id, e.jefe, 'rechazado', 'Error mío')),
    ).rejects.toThrow(/nadie valida un consumo que registró/);
  });

  it('aprobar con requiere_novedad = 1 sin novedad falla; con novedad funciona', async () => {
    const e = await crearEscenario();
    const id = await crearConsumo(e, { requiere_novedad: 1 });
    await expect(decidir(id, e.jefe, 'aprobado')).rejects.toThrow(
      /no se aprueba un consumo que requiere novedad/,
    );
    await crearNovedad(id, e.supervisor);
    await decidir(id, e.jefe, 'aprobado');
    expect(await fila('SELECT estado FROM consumptions WHERE id = ?', id)).toEqual({
      estado: 'aprobado',
    });
  });

  it('rechazar con requiere_novedad = 1 sin novedad sí se permite', async () => {
    const e = await crearEscenario();
    const id = await crearConsumo(e, { requiere_novedad: 1 });
    await decidir(id, e.jefe, 'rechazado');
    expect(await fila('SELECT estado FROM consumptions WHERE id = ?', id)).toEqual({
      estado: 'rechazado',
    });
  });

  it('rechazo sin motivo o con motivo de 2 caracteres falla', async () => {
    const e = await crearEscenario();
    const id = await crearConsumo(e);
    await expect(
      insertar('validations', valoresValidacion(id, e.jefe, 'rechazado', null)),
    ).rejects.toThrow(/validations_motivo_si_rechaza/);
    await expect(
      insertar('validations', valoresValidacion(id, e.jefe, 'rechazado', 'ok')),
    ).rejects.toThrow(/validations_motivo_si_rechaza/);
  });

  it('una segunda validación del mismo consumo falla', async () => {
    const e = await crearEscenario();
    const otroJefe = await crearUsuario('jefe');
    const id = await crearConsumo(e);
    await decidir(id, e.jefe, 'aprobado');
    // Contra un consumo ya decidido, el trigger lo detiene antes que el índice único.
    await expect(
      insertar('validations', valoresValidacion(id, otroJefe, 'rechazado', 'Cambio de opinión')),
    ).rejects.toThrow(/solo se validan consumos pendientes/);
  });

  it('dos validaciones en el mismo batch: la segunda falla y no queda ninguna', async () => {
    const e = await crearEscenario();
    const otroJefe = await crearUsuario('jefe');
    const id = await crearConsumo(e);
    // Desde la ADR 0010 la primera ya deja el consumo decidido, así que la segunda la frena el
    // BEFORE INSERT (validations_reglas) antes de llegar al índice único, que queda como respaldo.
    await expect(
      env.DB.batch([
        sentenciaInsert('validations', valoresValidacion(id, e.jefe, 'aprobado')),
        sentenciaInsert('validations', valoresValidacion(id, otroJefe, 'aprobado')),
      ]),
    ).rejects.toThrow(
      /solo se validan consumos pendientes|UNIQUE constraint failed: validations\.consumption_id/,
    );
    expect(await fila('SELECT id FROM validations WHERE consumption_id = ?', id)).toBeNull();
    expect(await fila('SELECT estado FROM consumptions WHERE id = ?', id)).toEqual({
      estado: 'pendiente',
    });
  });

  it('UPDATE de una validación falla', async () => {
    const e = await crearEscenario();
    const id = await crearConsumo(e);
    await decidir(id, e.jefe, 'rechazado');
    await expect(
      ejecutar(`UPDATE validations SET motivo = 'Otro motivo' WHERE consumption_id = ?`, id),
    ).rejects.toThrow(/validations es inmutable/);
  });
});

describe('incidents y sync_mutations', () => {
  it('UPDATE de una novedad falla', async () => {
    const e = await crearEscenario();
    const novedad = await crearNovedad(await crearConsumo(e), e.supervisor);
    await expect(
      ejecutar(`UPDATE incidents SET descripcion = 'cambiada' WHERE id = ?`, novedad),
    ).rejects.toThrow(/incidents es inmutable/);
  });

  it('UPDATE de una mutación procesada falla', async () => {
    const usuario = await crearUsuario();
    const id = await crearMutacionSync(usuario, await crearDispositivo(usuario));
    await expect(
      ejecutar(`UPDATE sync_mutations SET resultado = 'conflicto' WHERE mutation_id = ?`, id),
    ).rejects.toThrow(/sync_mutations es inmutable/);
  });

  it('una mutación repetida (mismo mutation_id) falla por PK', async () => {
    const usuario = await crearUsuario();
    const dispositivo = await crearDispositivo(usuario);
    const id = await crearMutacionSync(usuario, dispositivo);
    await expect(
      insertar('sync_mutations', {
        mutation_id: id,
        user_id: usuario,
        device_id: dispositivo,
        tipo: 'consumo.crear',
        resultado: 'aplicada',
        respuesta_json: '{}',
        procesada_at: ahora(),
        created_at: ahora(),
        updated_at: ahora(),
      }),
    ).rejects.toThrow(/UNIQUE constraint failed: sync_mutations\.mutation_id/);
  });
});

describe('evidences', () => {
  async function evidenciaNueva() {
    const e = await crearEscenario();
    return crearEvidencia(await crearNovedad(await crearConsumo(e), e.supervisor));
  }

  it('marcar subido 0→1 con subido_at funciona', async () => {
    const id = await evidenciaNueva();
    const t = ahora();
    await ejecutar(
      'UPDATE evidences SET subido = 1, subido_at = ?, updated_at = ? WHERE id = ?',
      t,
      t,
      id,
    );
    expect(await fila('SELECT subido, subido_at FROM evidences WHERE id = ?', id)).toEqual({
      subido: 1,
      subido_at: t,
    });
  });

  it('marcar subido sin subido_at falla (CHECK de coherencia)', async () => {
    const id = await evidenciaNueva();
    await expect(ejecutar('UPDATE evidences SET subido = 1 WHERE id = ?', id)).rejects.toThrow(
      /evidences_subido_coherente/,
    );
  });

  it('cambiar sha256, volver subido a 0 o cambiar otra columna falla', async () => {
    const id = await evidenciaNueva();
    await expect(
      ejecutar(
        'UPDATE evidences SET subido = 1, subido_at = ?, sha256 = ? WHERE id = ?',
        ahora(),
        'c'.repeat(64),
        id,
      ),
    ).rejects.toThrow(/una evidencia solo admite marcarse como subida/);
    await expect(
      ejecutar(`UPDATE evidences SET sha256 = ? WHERE id = ?`, 'c'.repeat(64), id),
    ).rejects.toThrow(/una evidencia solo admite marcarse como subida/);

    await ejecutar('UPDATE evidences SET subido = 1, subido_at = ? WHERE id = ?', ahora(), id);
    await expect(
      ejecutar('UPDATE evidences SET subido = 0, subido_at = NULL WHERE id = ?', id),
    ).rejects.toThrow(/una evidencia solo admite marcarse como subida/);
    await expect(
      ejecutar(`UPDATE evidences SET storage_key = 'otra' WHERE id = ?`, id),
    ).rejects.toThrow(/una evidencia solo admite marcarse como subida/);
  });

  it('CHECK de mime, tamaño (≤ 5 MiB) y sha256 hex', async () => {
    const e = await crearEscenario();
    const novedad = await crearNovedad(await crearConsumo(e), e.supervisor);
    const evidencia = (extra: Record<string, string | number>) => ({
      id: uuidv7(),
      incident_id: novedad,
      storage_key: `evidencias/${uuidv7()}.jpg`,
      mime: 'image/jpeg',
      tamano_bytes: 1000,
      sha256: 'd'.repeat(64),
      created_at: ahora(),
      updated_at: ahora(),
      ...extra,
    });
    await insertar('evidences', evidencia({ tamano_bytes: 5_242_880 }));
    await expect(insertar('evidences', evidencia({ tamano_bytes: 5_242_881 }))).rejects.toThrow(
      /evidences_tamano_valido/,
    );
    await expect(insertar('evidences', evidencia({ tamano_bytes: 0 }))).rejects.toThrow(
      /evidences_tamano_valido/,
    );
    await expect(insertar('evidences', evidencia({ mime: 'image/gif' }))).rejects.toThrow(
      /evidences_mime_valido/,
    );
    await expect(insertar('evidences', evidencia({ sha256: 'D'.repeat(64) }))).rejects.toThrow(
      /evidences_sha256_hex/,
    );
    await expect(insertar('evidences', evidencia({ sha256: 'd'.repeat(63) }))).rejects.toThrow(
      /evidences_sha256_hex/,
    );
  });
});

describe('production_orders', () => {
  it.each(['finalizada', 'cancelada'])('una orden %s no vuelve a en_proceso', async (estado) => {
    const jefe = await crearUsuario('jefe');
    const orden = await crearOrden(jefe, estado);
    await expect(
      ejecutar(`UPDATE production_orders SET estado = 'en_proceso' WHERE id = ?`, orden),
      // Lo frenan production_orders_estado_terminal y production_orders_transicion (orden de disparo
      // no documentado por SQLite).
    ).rejects.toThrow(
      /una orden finalizada o cancelada no cambia de estado|transición de estado de orden no permitida/,
    );
    expect(await fila('SELECT estado FROM production_orders WHERE id = ?', orden)).toEqual({
      estado,
    });
  });

  it('planeada → en_proceso → finalizada funciona y otros campos se pueden actualizar', async () => {
    const jefe = await crearUsuario('jefe');
    const orden = await crearOrden(jefe, 'planeada');
    await ejecutar(
      `UPDATE production_orders SET estado = 'en_proceso', fecha_inicio = ? WHERE id = ?`,
      ahora(),
      orden,
    );
    await ejecutar(
      `UPDATE production_orders SET estado = 'finalizada', fecha_fin = ? WHERE id = ?`,
      ahora(),
      orden,
    );
    await ejecutar(`UPDATE production_orders SET linea = 'Mecanizado' WHERE id = ?`, orden);
    expect(await fila('SELECT estado, linea FROM production_orders WHERE id = ?', orden)).toEqual({
      estado: 'finalizada',
      linea: 'Mecanizado',
    });
  });

  it('un consumo tardío en una orden finalizada se acepta (registro_tardio = 1)', async () => {
    const e = await crearEscenario();
    const orden = await crearOrden(e.jefe, 'finalizada');
    const id = await crearConsumo({ ...e, orden }, { registro_tardio: 1 });
    expect(await fila('SELECT registro_tardio, estado FROM consumptions WHERE id = ?', id)).toEqual(
      {
        registro_tardio: 1,
        estado: 'pendiente',
      },
    );
  });
});

describe('un batch de negocio + auditoría que choca con un trigger no deja nada', () => {
  it('aprobar con autoaprobación revierte también la auditoría', async () => {
    const e = await crearEscenario();
    const id = await crearConsumo(e, { registrado_por: e.jefe, device_id: e.dispositivoJefe });
    const auditoria = uuidv7();
    await expect(
      env.DB.batch([
        sentenciaInsert('audit_log', {
          id: auditoria,
          entidad: 'consumptions',
          entidad_id: id,
          accion: 'aprobar',
          server_at: ahora(),
          created_at: ahora(),
          updated_at: ahora(),
        }),
        sentenciaInsert('validations', valoresValidacion(id, e.jefe, 'aprobado')),
      ]),
    ).rejects.toThrow(/nadie valida un consumo que registró/);
    expect(await fila('SELECT id FROM audit_log WHERE id = ?', auditoria)).toBeNull();
    expect(await fila('SELECT estado FROM consumptions WHERE id = ?', id)).toEqual({
      estado: 'pendiente',
    });
  });

  it('el fixture de consumo es válido (control)', async () => {
    const e = await crearEscenario();
    const valores = valoresConsumo(e);
    await insertar('consumptions', valores);
    expect(
      await fila('SELECT estado, version FROM consumptions WHERE id = ?', String(valores.id)),
    ).toEqual({
      estado: 'pendiente',
      version: 1,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// ADR 0010: integridad reforzada (migrations/0004_integridad_reforzada_triggers.sql)
// ---------------------------------------------------------------------------------------------

describe('consumptions_insercion_valida (H3)', () => {
  it('rechaza un consumo que nace decidido o con version distinta de 1', async () => {
    const e = await crearEscenario();
    const casos: Record<string, string | number>[] = [
      { estado: 'aprobado' },
      { estado: 'rechazado' },
      { version: 2 },
    ];
    for (const extra of casos) {
      await expect(crearConsumo(e, extra)).rejects.toThrow(
        /un consumo nuevo nace pendiente y con version 1/,
      );
    }
  });

  it('rechaza un id que no es UUID en minúsculas de 36 caracteres', async () => {
    const e = await crearEscenario();
    for (const id of [uuidv7().toUpperCase(), uuidv7().replaceAll('-', ''), `${uuidv7()}x`]) {
      await expect(crearConsumo(e, { id })).rejects.toThrow(
        /id de consumo no es un UUID en minúsculas/,
      );
    }
  });

  it('rechaza un dispositivo que no es de quien registra', async () => {
    const e = await crearEscenario();
    await expect(crearConsumo(e, { device_id: e.dispositivoJefe })).rejects.toThrow(
      /el dispositivo no pertenece a quien registra/,
    );
  });

  it('rechaza una corrección de un rechazado de otra orden', async () => {
    const e = await crearEscenario();
    const otraOrden = await crearOrden(e.jefe);
    const rechazado = await crearConsumo({ ...e, orden: otraOrden });
    await decidir(rechazado, e.jefe, 'rechazado');
    await expect(crearConsumo(e, { corrige_a: rechazado })).rejects.toThrow(
      /corrige_a debe ser un consumo de la misma orden/,
    );
  });
});

describe('consumptions_validado_no_se_edita (H1)', () => {
  it('un consumo con validación no se edita aunque siga pendiente', async () => {
    // Aísla el trigger: sin validations_aplica_decision, una validación puede quedar con el consumo
    // pendiente (el caso que encontró la revisión). Se recrea después con el DDL real de 0004.
    const ddl = env.TEST_MIGRATIONS.flatMap((m) => m.queries).find((q) =>
      q.includes('CREATE TRIGGER validations_aplica_decision'),
    );
    expect(ddl).toBeDefined();
    const e = await crearEscenario();
    const id = await crearConsumo(e);
    await ejecutar('DROP TRIGGER validations_aplica_decision');
    try {
      await insertar('validations', valoresValidacion(id, e.jefe, 'aprobado'));
      expect(await fila('SELECT estado FROM consumptions WHERE id = ?', id)).toEqual({
        estado: 'pendiente',
      });
      await expect(
        ejecutar('UPDATE consumptions SET cantidad = 1, version = version + 1 WHERE id = ?', id),
      ).rejects.toThrow(/un consumo con validación no se edita/);
    } finally {
      await ejecutar(ddl ?? '');
    }
    const trigger = await fila(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'validations_aplica_decision'`,
    );
    expect(trigger).toEqual({ name: 'validations_aplica_decision' });
  });
});

describe('validations_validador_jefe (H3)', () => {
  it('un supervisor, un admin o un jefe inactivo no validan', async () => {
    const e = await crearEscenario();
    const id = await crearConsumo(e);
    const otroSupervisor = await crearUsuario('supervisor');
    const admin = await crearUsuario('admin');
    const jefeInactivo = await crearUsuario('jefe');
    await ejecutar('UPDATE users SET activo = 0 WHERE id = ?', jefeInactivo);
    for (const validador of [otroSupervisor, admin, jefeInactivo]) {
      await expect(
        insertar('validations', valoresValidacion(id, validador, 'aprobado')),
      ).rejects.toThrow(/solo un jefe activo valida consumos/);
    }
    expect(await fila('SELECT estado, version FROM consumptions WHERE id = ?', id)).toEqual({
      estado: 'pendiente',
      version: 1,
    });
  });
});

describe('evidences_insercion_valida (H3)', () => {
  it('una evidencia no nace subida', async () => {
    const e = await crearEscenario();
    const novedad = await crearNovedad(await crearConsumo(e), e.supervisor);
    const evidencia = (extra: Record<string, string | number | null>) => ({
      id: uuidv7(),
      incident_id: novedad,
      storage_key: `evidencias/${uuidv7()}.jpg`,
      mime: 'image/jpeg',
      tamano_bytes: 1000,
      sha256: 'e'.repeat(64),
      created_at: ahora(),
      updated_at: ahora(),
      ...extra,
    });
    // El BEFORE INSERT se dispara antes que el CHECK evidences_subido_coherente.
    for (const extra of [
      { subido: 1, subido_at: ahora() },
      { subido: 0, subido_at: ahora() },
      { subido: 1, subido_at: null },
    ]) {
      await expect(insertar('evidences', evidencia(extra))).rejects.toThrow(
        /una evidencia nace sin subir/,
      );
    }
  });
});

describe('production_orders_transicion (H3)', () => {
  it.each([
    ['planeada', 'en_proceso'],
    ['planeada', 'cancelada'],
    ['en_proceso', 'finalizada'],
    ['en_proceso', 'cancelada'],
  ])('%s → %s está permitida', async (desde, hacia) => {
    const orden = await crearOrden(await crearUsuario('jefe'), desde);
    await ejecutar('UPDATE production_orders SET estado = ? WHERE id = ?', hacia, orden);
    expect(await fila('SELECT estado FROM production_orders WHERE id = ?', orden)).toEqual({
      estado: hacia,
    });
  });

  it.each([
    ['planeada', 'finalizada'],
    ['en_proceso', 'planeada'],
  ])('%s → %s no está permitida', async (desde, hacia) => {
    const orden = await crearOrden(await crearUsuario('jefe'), desde);
    await expect(
      ejecutar('UPDATE production_orders SET estado = ? WHERE id = ?', hacia, orden),
    ).rejects.toThrow(/transición de estado de orden no permitida/);
  });
});

describe('settings_valores_validos (H12)', () => {
  const tolerancia = (valor: string) =>
    ejecutar(`UPDATE settings SET valor = ? WHERE clave = 'tolerancia_pct'`, valor);

  it('tolerancia_pct admite números no negativos y rechaza el resto', async () => {
    try {
      for (const valido of ['7.5', '0', '5']) {
        await tolerancia(valido);
      }
      for (const invalido of ['"abc"', '-1', 'null', 'true', '[5]', '{"pct":5}']) {
        await expect(tolerancia(invalido), invalido).rejects.toThrow(
          /valor de configuración no válido/,
        );
      }
    } finally {
      await tolerancia('5');
    }
    expect(await fila(`SELECT valor FROM settings WHERE clave = 'tolerancia_pct'`)).toEqual({
      valor: '5',
    });
  });

  it('sync_epoca debe ser un texto JSON y la clave no cambia', async () => {
    const actual = await fila<{ valor: string }>(
      `SELECT valor FROM settings WHERE clave = 'sync_epoca'`,
    );
    await ejecutar(
      `UPDATE settings SET valor = ? WHERE clave = 'sync_epoca'`,
      JSON.stringify(crypto.randomUUID()),
    );
    await expect(
      ejecutar(`UPDATE settings SET valor = '5' WHERE clave = 'sync_epoca'`),
    ).rejects.toThrow(/valor de configuración no válido/);
    await expect(
      ejecutar(`UPDATE settings SET clave = 'otra' WHERE clave = 'sync_epoca'`),
    ).rejects.toThrow(/valor de configuración no válido/);
    await ejecutar(`UPDATE settings SET valor = ? WHERE clave = 'sync_epoca'`, actual?.valor ?? '');
  });
});

describe('flujos legítimos de planta con todos los triggers (ADR 0010)', () => {
  it('registro, edición pendiente, novedad + evidencia, aprobación y subida posterior de la foto', async () => {
    const e = await crearEscenario();
    const id = await crearConsumo(e, { requiere_novedad: 1 });
    // Edición propia mientras está pendiente.
    await ejecutar(
      'UPDATE consumptions SET cantidad = 11, cantidad_en_unidad_plan = 11, version = version + 1, updated_at = ? WHERE id = ?',
      ahora(),
      id,
    );
    const novedad = await crearNovedad(id, e.supervisor);
    const evidencia = await crearEvidencia(novedad);
    await decidir(id, e.jefe, 'aprobado');
    expect(
      await fila('SELECT estado, version, cantidad FROM consumptions WHERE id = ?', id),
    ).toEqual({ estado: 'aprobado', version: 3, cantidad: 11 });
    // La foto se sube después de aprobado (la subida no depende del estado del consumo).
    const t = ahora();
    await ejecutar(
      'UPDATE evidences SET subido = 1, subido_at = ?, updated_at = ? WHERE id = ?',
      t,
      t,
      evidencia,
    );
    expect(await fila('SELECT subido FROM evidences WHERE id = ?', evidencia)).toEqual({
      subido: 1,
    });
  });

  it('rechazo y consumo corregido en la misma orden', async () => {
    const e = await crearEscenario();
    const rechazado = await crearConsumo(e);
    await decidir(rechazado, e.jefe, 'rechazado');
    const correccion = await crearConsumo(e, { corrige_a: rechazado });
    await decidir(correccion, e.jefe, 'aprobado');
    const { results } = await env.DB.prepare(
      'SELECT id, estado, version FROM consumptions WHERE id IN (?, ?) ORDER BY id',
    )
      .bind(rechazado, correccion)
      .all();
    expect(results).toEqual([
      { id: rechazado, estado: 'rechazado', version: 2 },
      { id: correccion, estado: 'aprobado', version: 2 },
    ]);
  });

  it('registro tardío en una orden finalizada y validación posterior', async () => {
    const e = await crearEscenario();
    const orden = await crearOrden(e.jefe, 'finalizada');
    const id = await crearConsumo({ ...e, orden }, { registro_tardio: 1 });
    await decidir(id, e.jefe, 'aprobado');
    expect(await fila('SELECT estado FROM consumptions WHERE id = ?', id)).toEqual({
      estado: 'aprobado',
    });
  });

  it('desactivar y reactivar un usuario, y reasignar supervisores de una orden', async () => {
    const e = await crearEscenario();
    await ejecutar(
      'UPDATE users SET activo = 0, updated_at = ? WHERE id = ?',
      ahora(),
      e.supervisor,
    );
    await ejecutar(
      'UPDATE users SET activo = 1, updated_at = ? WHERE id = ?',
      ahora(),
      e.supervisor,
    );
    const otro = await crearUsuario('supervisor');
    const asignar = (usuario: string) =>
      insertar('order_supervisors', {
        order_id: e.orden,
        user_id: usuario,
        asignado_por: e.jefe,
        created_at: ahora(),
        updated_at: ahora(),
      });
    const cambiarActivo = (usuario: string, activo: number) =>
      ejecutar(
        'UPDATE order_supervisors SET activo = ?, updated_at = ? WHERE order_id = ? AND user_id = ?',
        activo,
        ahora(),
        e.orden,
        usuario,
      );
    await asignar(e.supervisor);
    await cambiarActivo(e.supervisor, 0);
    await asignar(otro);
    await cambiarActivo(e.supervisor, 1);
    const n = await fila<{ n: number }>(
      'SELECT COUNT(*) AS n FROM order_supervisors WHERE order_id = ? AND activo = 1',
      e.orden,
    );
    expect(n?.n).toBe(2);
  });
});
