// B3 (docs/correcciones-v1.1.md; docs/spec.md §4 "IDs"): una colisión de clave primaria con una
// fila que ya existe es un `conflicto`, nunca una sobrescritura ni un `rechazada`. La respuesta no
// lleva NINGÚN dato de la fila existente (`servidor` ausente): nada de otro usuario se filtra.
// La idempotencia por clave natural (ADR 0016, M2) se conserva: si la fila existente es la MISMA
// que describe la mutación (mismo autor y datos de identidad), sigue siendo `aplicada`.
// Worker real, sesiones reales y D1 local real (sin mocks).
import { type Consumo, MENSAJES_ERROR, type ResultadoMutacion, uuidv7 } from '@catmetal/shared';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  cuerpoConsumo,
  escenarioOrden,
  novedadOk,
  registrar,
  registrarOk,
} from './fase2-consumos-helpers';
import { esperarError, sesion, type SesionDeRol } from './fase2-helpers';
import {
  contar,
  crearConsumo,
  crearNovedadMut,
  decidirMut,
  editarConsumoMut,
  filaSync,
  pushOk,
} from './fase3-helpers';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let supervisor: SesionDeRol;
let otroSupervisor: SesionDeRol;
let jefe: SesionDeRol;
let jefe2: SesionDeRol;

beforeAll(async () => {
  [supervisor, otroSupervisor, jefe, jefe2] = await Promise.all([
    sesion('supervisor'),
    sesion('supervisor'),
    sesion('jefe'),
    sesion('jefe'),
  ]);
});

/** Resultado de una colisión: `conflicto` con el código y el mensaje neutros, sin `servidor`. */
const COLISION = {
  resultado: 'conflicto',
  code: 'ID_DUPLICADO',
  message: MENSAJES_ERROR.ID_DUPLICADO,
};

/** La respuesta serializada no contiene ninguno de estos valores de la fila ajena. */
function sinFiltrar(r: ResultadoMutacion | undefined, ajenos: readonly string[]): void {
  expect(r?.servidor).toBeUndefined();
  const texto = JSON.stringify(r);
  for (const valor of ajenos) {
    expect(texto, `filtra ${valor}`).not.toContain(valor);
  }
}

/** Consumo de `supervisor` en su propia orden (la fila "ajena" para `otroSupervisor`). */
async function consumoAjeno(): Promise<Consumo> {
  const { orden, material } = await escenarioOrden(jefe, supervisor);
  return registrarOk(supervisor.token, cuerpoConsumo(orden, material, { lote: 'L-AJENO-B3' }));
}

describe('B3: colisión de PK con una fila ajena → conflicto sin datos de la fila', () => {
  it('consumo.crear con el id de un consumo de otro usuario', async () => {
    const ajeno = await consumoAjeno();
    const { orden, material } = await escenarioOrden(jefe, otroSupervisor);
    const m = crearConsumo(orden, material, { id: ajeno.id });

    const [r] = await pushOk(otroSupervisor.token, otroSupervisor.usuario.id, [m]);

    expect(r).toEqual({ indice: 0, mutation_id: m.mutation_id, ...COLISION });
    sinFiltrar(r, [ajeno.order_id, ajeno.material_id, ajeno.registrado_por, 'L-AJENO-B3']);
    // Nunca se sobrescribe: la fila existente sigue igual.
    const [actual] = await pushOk(supervisor.token, supervisor.usuario.id, [
      editarConsumoMut(ajeno.id, 1, { cantidad: 11 }),
    ]);
    expect(actual).toMatchObject({ resultado: 'aplicada', servidor: { order_id: ajeno.order_id } });
    // Se guarda como conflicto (con su payload, como todo lo no aplicado) y el reenvío lo repite.
    expect(await filaSync(m.mutation_id)).toMatchObject({
      user_id: otroSupervisor.usuario.id,
      resultado: 'conflicto',
      payload_json: JSON.stringify(m),
    });
    expect(await pushOk(otroSupervisor.token, otroSupervisor.usuario.id, [m])).toEqual([r]);
  });

  it('las dependientes de una creación en conflicto se rechazan (en el mismo lote)', async () => {
    const ajeno = await consumoAjeno();
    const { orden, material } = await escenarioOrden(jefe, otroSupervisor);
    const crear = crearConsumo(orden, material, { id: ajeno.id });
    const editar = editarConsumoMut(ajeno.id, 1);
    const novedad = crearNovedadMut(ajeno.id);

    const resultados = await pushOk(otroSupervisor.token, otroSupervisor.usuario.id, [
      crear,
      editar,
      novedad,
    ]);

    expect(resultados.map((r) => [r.resultado, r.code])).toEqual([
      ['conflicto', 'ID_DUPLICADO'],
      ['rechazada', 'DEPENDENCIA_RECHAZADA'],
      ['rechazada', 'DEPENDENCIA_RECHAZADA'],
    ]);
    expect(await contar('incidents', 'id = ?', novedad.payload.id)).toBe(0);
  });

  it('novedad.crear con el id de una novedad ajena, o con el id de una evidencia ajena', async () => {
    const ajeno = await consumoAjeno();
    const novedadAjena = await novedadOk(supervisor.token, ajeno.id, {
      id: uuidv7(),
      consumption_id: ajeno.id,
      tipo: 'merma',
      descripcion: 'Descripción AJENA de la novedad B3',
      client_created_at: new Date().toISOString(),
      evidencias: [
        { id: uuidv7(), mime: 'image/jpeg', tamano_bytes: 1234, sha256: 'b'.repeat(64) },
      ],
    });
    const { orden, material } = await escenarioOrden(jefe, otroSupervisor);
    const [propio] = await pushOk(otroSupervisor.token, otroSupervisor.usuario.id, [
      crearConsumo(orden, material),
    ]);
    const consumoPropio = String(propio?.servidor?.id);

    const mismaNovedad = crearNovedadMut(consumoPropio);
    mismaNovedad.payload.id = novedadAjena.id;
    const mismaEvidencia = crearNovedadMut(consumoPropio);
    mismaEvidencia.payload.evidencias = [
      {
        id: novedadAjena.evidencias[0]?.id,
        mime: 'image/jpeg',
        tamano_bytes: 99,
        sha256: 'c'.repeat(64),
      },
    ];
    const resultados = await pushOk(otroSupervisor.token, otroSupervisor.usuario.id, [
      mismaNovedad,
      mismaEvidencia,
    ]);

    for (const r of resultados) {
      expect(r).toMatchObject(COLISION);
      sinFiltrar(r, [ajeno.id, 'Descripción AJENA', supervisor.usuario.id, 'b'.repeat(64)]);
    }
    expect(await contar('incidents', 'consumption_id = ?', consumoPropio)).toBe(0);
  });

  it('consumo.aprobar con el id de una validación de otro jefe', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const [a, b] = await pushOk(supervisor.token, supervisor.usuario.id, [
      crearConsumo(orden, material),
      crearConsumo(orden, material),
    ]);
    const ajena = decidirMut('rechazar', String(a?.servidor?.id), 1);
    expect((await pushOk(jefe.token, jefe.usuario.id, [ajena]))[0]?.resultado).toBe('aplicada');

    const m = decidirMut('aprobar', String(b?.servidor?.id), 1);
    m.payload.id = ajena.payload.id;
    const [r] = await pushOk(jefe2.token, jefe2.usuario.id, [m]);

    expect(r).toMatchObject(COLISION);
    sinFiltrar(r, [String(a?.servidor?.id), jefe.usuario.id, 'Cantidad no coincide']);
    expect(await contar('validations', 'consumption_id = ?', String(b?.servidor?.id))).toBe(0);
  });

  it('un mutation_id que ya usó otro usuario también es conflicto, sin revelar la respuesta guardada', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const m = crearConsumo(orden, material);
    const [suya] = await pushOk(supervisor.token, supervisor.usuario.id, [m]);
    const otra = await escenarioOrden(jefe, otroSupervisor);
    const ajena = { ...crearConsumo(otra.orden, otra.material), mutation_id: m.mutation_id };

    const [r] = await pushOk(otroSupervisor.token, otroSupervisor.usuario.id, [ajena]);

    expect(r).toEqual({ indice: 0, mutation_id: m.mutation_id, ...COLISION });
    sinFiltrar(r, [String(suya?.servidor?.id), supervisor.usuario.id, orden]);
    expect(await contar('consumptions', 'id = ?', ajena.payload.id)).toBe(0);
  });
});

describe('B3: lo que NO cambia', () => {
  it('reintento propio con otro mutation_id y la misma clave natural → aplicada (ADR 0016)', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const m = crearConsumo(orden, material);
    const [primera] = await pushOk(supervisor.token, supervisor.usuario.id, [m]);
    const reintento = { ...m, mutation_id: uuidv7() };

    const [r] = await pushOk(supervisor.token, supervisor.usuario.id, [reintento]);

    expect(r).toMatchObject({ resultado: 'aplicada', servidor: primera?.servidor });
    expect(await contar('consumptions', 'id = ?', m.payload.id)).toBe(1);
  });

  it('REST: el mismo id ajeno responde 409 ID_DUPLICADO sin datos de la fila existente', async () => {
    const ajeno = await consumoAjeno();
    const { orden, material } = await escenarioOrden(jefe, otroSupervisor);
    const respuesta = await registrar(
      otroSupervisor.token,
      cuerpoConsumo(orden, material, { id: ajeno.id }),
    );
    const cuerpo = await esperarError(respuesta, 409, 'ID_DUPLICADO');
    expect(cuerpo.details).toEqual({ entidad: 'consumptions', campos: ['id'] });
    expect(JSON.stringify(cuerpo)).not.toContain(ajeno.order_id);
    // La fila sigue siendo la del dueño.
    expect(
      await contar(
        'consumptions',
        "id = ? AND registrado_por = ? AND order_id = ? AND lote = 'L-AJENO-B3'",
        ajeno.id,
        supervisor.usuario.id,
        ajeno.order_id,
      ),
    ).toBe(1);
  });
});
