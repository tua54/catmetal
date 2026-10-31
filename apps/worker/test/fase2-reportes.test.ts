// Tarea 2.4: GET /api/v1/reports/orders/:id/summary y GET /api/v1/reports/orders/:id/export.csv.
// D1 local real; consumos con fixtures SQL que respetan los triggers (fase2-auditoria-helpers).
import { BOM_CSV, fechaHoraBogotaCsv, type ResumenOrden, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ENCABEZADO_CSV, LOTE_CSV } from '../src/dominio/reportes';
import {
  type Autor,
  decidirConsumo,
  type FilaConsumo,
  materialConNombre,
  registrarConsumo,
  registrarNovedad,
  renombrar,
} from './fase2-auditoria-helpers';
import {
  api,
  asignar,
  esperarError,
  nuevaOrden,
  planear,
  sesion,
  type SesionDeRol,
} from './fase2-helpers';
import { insertar, sentenciaInsert } from './fixtures-db';

// Pruebas con PBKDF2 y muchas peticiones: con la máquina cargada superan el límite por defecto de
// 5 s. Mismo valor que las demás pruebas pesadas del worker; no cambia ninguna aserción.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let admin: SesionDeRol;
let jefe: SesionDeRol;
let sup: SesionDeRol;
let supAjeno: SesionDeRol;
let supInactivo: SesionDeRol;

let orden: string;
let codigo: string;
type ClaveMaterial = 'arena' | 'resina' | 'alcohol' | 'aditivo' | 'ferro';
const m = {} as Record<ClaveMaterial, { id: string; codigo: string }>;
type ClaveConsumo = 'a1' | 'a2' | 'a3' | 'a4' | 'a5' | 'r1' | 'r2' | 'al1' | 'ad1' | 'f1';
const c = {} as Record<ClaveConsumo, FilaConsumo>;

const autor = (s: SesionDeRol): Autor => ({ id: s.usuario.id, deviceId: s.deviceId });

async function ok<T>(respuesta: Response): Promise<T> {
  expect(respuesta.status, await respuesta.clone().text()).toBe(200);
  return respuesta.json<T>();
}

beforeAll(async () => {
  [admin, jefe, sup, supAjeno, supInactivo] = await Promise.all([
    sesion('admin'),
    sesion('jefe'),
    sesion('supervisor'),
    sesion('supervisor'),
    sesion('supervisor'),
  ]);
  await renombrar(sup.usuario.id, 'Laura Gómez');
  await renombrar(jefe.usuario.id, 'Carlos Jefe');
  m.arena = await materialConNombre('Arena sílice', 'kg', 350);
  m.resina = await materialConNombre('Resina furánica', 'kg', 9800);
  m.alcohol = await materialConNombre('Alcohol isopropílico', 'l', 4200);
  m.aditivo = await materialConNombre('Aditivo inoculante', 'g', 12);
  m.ferro = await materialConNombre('Ferrosilicio', 'kg', 7000);

  orden = await nuevaOrden(jefe.usuario.id);
  const fila = await env.DB.prepare('SELECT codigo FROM production_orders WHERE id = ?')
    .bind(orden)
    .first<{ codigo: string }>();
  codigo = fila?.codigo ?? '';
  await planear(orden, m.arena.id, 1000, 'kg');
  await planear(orden, m.resina.id, 50_000, 'g');
  await planear(orden, m.alcohol.id, 2000, 'ml');
  await planear(orden, m.aditivo.id, 2, 'kg');
  await asignar(orden, sup.usuario.id, admin.usuario.id);
  await asignar(orden, supInactivo.usuario.id, admin.usuario.id, 0);

  const s = autor(sup);
  const j = autor(jefe);
  c.a1 = await registrarConsumo({
    orderId: orden,
    materialId: m.arena.id,
    autor: s,
    cantidad: 300,
    snapshot: 350,
    lote: 'L-100',
  });
  await decidirConsumo(c.a1, j, 'aprobado');
  c.a2 = await registrarConsumo({
    orderId: orden,
    materialId: m.arena.id,
    autor: s,
    cantidad: 800,
    snapshot: 350,
    requiereNovedad: true,
  });
  c.a3 = await registrarConsumo({
    orderId: orden,
    materialId: m.arena.id,
    autor: s,
    cantidad: 500,
    snapshot: 350,
  });
  await decidirConsumo(c.a3, j, 'rechazado', 'Lote equivocado; revisar "remisión"');
  c.a4 = await registrarConsumo({
    orderId: orden,
    materialId: m.arena.id,
    autor: s,
    cantidad: 0.333,
    snapshot: 350,
  });
  c.r1 = await registrarConsumo({
    orderId: orden,
    materialId: m.resina.id,
    autor: s,
    cantidad: 2.5,
    cantidadPlan: 2500,
    snapshot: 9800,
  });
  await registrarNovedad(c.r1, s);
  c.r2 = await registrarConsumo({
    orderId: orden,
    materialId: m.resina.id,
    autor: s,
    cantidad: 1500,
    unidad: 'g',
    cantidadPlan: 1500,
    snapshot: 9800,
  });
  await decidirConsumo(c.r2, j, 'aprobado');
  c.al1 = await registrarConsumo({
    orderId: orden,
    materialId: m.alcohol.id,
    autor: s,
    cantidad: 750,
    unidad: 'ml',
    cantidadPlan: 750,
    snapshot: 4200,
  });
  c.ad1 = await registrarConsumo({
    orderId: orden,
    materialId: m.aditivo.id,
    autor: s,
    cantidad: 0.125,
    unidad: 'kg',
    cantidadPlan: 0.125,
    snapshot: 12,
  });
  c.f1 = await registrarConsumo({
    orderId: orden,
    materialId: m.ferro.id,
    autor: s,
    cantidad: 20,
    snapshot: 7000,
    requiereNovedad: true,
  });
  await registrarNovedad(c.f1, s);
  c.a5 = await registrarConsumo({
    orderId: orden,
    materialId: m.arena.id,
    autor: s,
    cantidad: 480,
    snapshot: 350,
    corrigeA: String(c.a3.id),
    registroTardio: true,
  });
});

// ---------------------------------------------------------------------------------------------
// Resumen
// ---------------------------------------------------------------------------------------------

function porMaterial(resumen: ResumenOrden) {
  return Object.fromEntries(resumen.materiales.map((x) => [x.material_id, x]));
}

describe('GET /reports/orders/:id/summary', () => {
  it('real vs planeado con conversiones, costos congelados y totales', async () => {
    const resumen: ResumenOrden = await ok(
      await api(`/reports/orders/${orden}/summary`, { token: jefe.token }),
    );
    expect(resumen).toMatchObject({
      order_id: orden,
      codigo,
      estado: 'en_proceso',
      tolerancia_pct: 5,
    });
    const materiales = porMaterial(resumen);
    // Arena: 300 (aprobado) + 800 (pendiente) + 0,333 + 480 (corrección); el rechazado (500) no cuenta.
    expect(materiales[m.arena.id]).toEqual({
      material_id: m.arena.id,
      codigo: m.arena.codigo,
      nombre: 'Arena sílice',
      unidad: 'kg',
      cantidad_planeada: 1000,
      consumido: 1580.333,
      porcentaje: 158.03,
      // 105.000 + 280.000 + round(116,55) = 117 + 168.000
      costo_cop: 553_117,
      registros: 4,
      excede_tolerancia: true,
    });
    // Resina: plan en g, material en kg. 2,5 kg = 2500 g y 1500 g; costo en kg × 9800.
    expect(materiales[m.resina.id]).toMatchObject({
      unidad: 'g',
      cantidad_planeada: 50_000,
      consumido: 4000,
      porcentaje: 8,
      costo_cop: 24_500 + 14_700,
      registros: 2,
      excede_tolerancia: false,
    });
    // Alcohol: plan y consumo en ml, material en l: 0,75 l × 4200.
    expect(materiales[m.alcohol.id]).toMatchObject({
      unidad: 'ml',
      consumido: 750,
      porcentaje: 37.5,
      costo_cop: 3150,
    });
    // Aditivo: plan y consumo en kg, material en g: 125 g × 12.
    expect(materiales[m.aditivo.id]).toMatchObject({
      unidad: 'kg',
      consumido: 0.125,
      porcentaje: 6.25,
      costo_cop: 1500,
    });
    expect(resumen.materiales.map((x) => x.codigo)).toEqual(
      [...resumen.materiales.map((x) => x.codigo)].sort(),
    );
    expect(resumen.materiales_fuera_de_plan).toEqual([
      {
        material_id: m.ferro.id,
        codigo: m.ferro.codigo,
        nombre: 'Ferrosilicio',
        unidad: 'kg',
        consumido: 20,
        costo_cop: 140_000,
        registros: 1,
      },
    ]);
    expect(resumen.totales).toEqual({
      materiales_consumidos: 9,
      costo_total_cop: 553_117 + 39_200 + 3150 + 1500 + 140_000,
      // a2 (requiere novedad, sin novedad), r1 (con novedad), f1 (ambas); a5 no tiene novedad.
      novedades_abiertas: 3,
      novedades_faltantes: 1,
      pendientes: 7,
      aprobados: 2,
      rechazados: 1,
    });
  });

  it('el costo es el congelado: cambiar el costo del material después no cambia el total', async () => {
    const antes: ResumenOrden = await ok(
      await api(`/reports/orders/${orden}/summary`, { token: jefe.token }),
    );
    await env.DB.prepare('UPDATE materials SET costo_unitario_cop = ? WHERE id IN (?, ?)')
      .bind(999_999, m.arena.id, m.ferro.id)
      .run();
    const despues: ResumenOrden = await ok(
      await api(`/reports/orders/${orden}/summary`, { token: jefe.token }),
    );
    expect(despues.totales.costo_total_cop).toBe(antes.totales.costo_total_cop);
    expect(despues).toEqual(antes);
  });

  it('el admin y el supervisor asignado ven el mismo resumen', async () => {
    const delJefe = await ok(await api(`/reports/orders/${orden}/summary`, { token: jefe.token }));
    for (const token of [admin.token, sup.token]) {
      expect(await ok(await api(`/reports/orders/${orden}/summary`, { token }))).toEqual(delJefe);
    }
  });

  it('una orden sin consumos da ceros', async () => {
    const vacia = await nuevaOrden(jefe.usuario.id, 'planeada');
    await planear(vacia, m.arena.id, 10);
    const resumen: ResumenOrden = await ok(
      await api(`/reports/orders/${vacia}/summary`, { token: admin.token }),
    );
    expect(resumen.estado).toBe('planeada');
    expect(resumen.materiales).toEqual([
      expect.objectContaining({
        consumido: 0,
        porcentaje: 0,
        costo_cop: 0,
        registros: 0,
        excede_tolerancia: false,
      }),
    ]);
    expect(resumen.materiales_fuera_de_plan).toEqual([]);
    expect(resumen.totales).toEqual({
      materiales_consumidos: 0,
      costo_total_cop: 0,
      novedades_abiertas: 0,
      novedades_faltantes: 0,
      pendientes: 0,
      aprobados: 0,
      rechazados: 0,
    });
  });

  it('supervisor no asignado o con asignación inactiva → 404; orden inexistente → 404', async () => {
    for (const token of [supAjeno.token, supInactivo.token]) {
      await esperarError(
        await api(`/reports/orders/${orden}/summary`, { token }),
        404,
        'NO_ENCONTRADO',
      );
    }
    await esperarError(
      await api(`/reports/orders/${uuidv7()}/summary`, { token: jefe.token }),
      404,
      'NO_ENCONTRADO',
    );
  });

  it('id inválido → 400; sin token → 401', async () => {
    await esperarError(
      await api('/reports/orders/123/summary', { token: jefe.token }),
      400,
      'VALIDACION',
    );
    await esperarError(await api(`/reports/orders/${orden}/summary`), 401, 'NO_AUTENTICADO');
  });
});

// ---------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------

/** Parser mínimo de CSV con `;`, comillas dobles y CRLF (para leer lo que exporta el Worker). */
function parsearCsv(texto: string): string[][] {
  const filas: string[][] = [];
  let fila: string[] = [];
  let celda = '';
  let entreComillas = false;
  for (let i = 0; i < texto.length; i += 1) {
    const ch = texto.charAt(i);
    if (entreComillas) {
      if (ch === '"' && texto.charAt(i + 1) === '"') {
        celda += '"';
        i += 1;
      } else if (ch === '"') {
        entreComillas = false;
      } else {
        celda += ch;
      }
    } else if (ch === '"') {
      entreComillas = true;
    } else if (ch === ';') {
      fila.push(celda);
      celda = '';
    } else if (ch === '\r' && texto.charAt(i + 1) === '\n') {
      fila.push(celda);
      filas.push(fila);
      fila = [];
      celda = '';
      i += 1;
    } else {
      expect(ch === '\r' || ch === '\n', 'CR o LF sueltos fuera de comillas').toBe(false);
      celda += ch;
    }
  }
  expect(celda === '' && fila.length === 0, 'el archivo termina en CRLF').toBe(true);
  return filas;
}

interface Descarga {
  respuesta: Response;
  bytes: Uint8Array;
  texto: string;
  filas: string[][];
}

async function descargar(orderId: string, token: string): Promise<Descarga> {
  const respuesta = await api(`/reports/orders/${orderId}/export.csv`, { token });
  expect(respuesta.status).toBe(200);
  const bytes = new Uint8Array(await respuesta.arrayBuffer());
  const texto = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  expect(texto.startsWith(BOM_CSV)).toBe(true);
  return { respuesta, bytes, texto, filas: parsearCsv(texto.slice(1)) };
}

const columna = (nombre: (typeof ENCABEZADO_CSV)[number]): number => ENCABEZADO_CSV.indexOf(nombre);

describe('GET /reports/orders/:id/export.csv', () => {
  it('UTF-8 con BOM, cabeceras de descarga, separador ; y CRLF', async () => {
    const { respuesta, bytes, texto, filas } = await descargar(orden, jefe.token);
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(respuesta.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(respuesta.headers.get('Content-Disposition')).toBe(
      `attachment; filename="${codigo}-consumos.csv"`,
    );
    expect(respuesta.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(respuesta.headers.get('Cache-Control')).toBe('no-store');
    expect(texto.slice(1).split('\r\n')[0]).toBe(ENCABEZADO_CSV.join(';'));
    expect(filas[0]).toEqual([...ENCABEZADO_CSV]);
    // Una fila por consumo (incluidos los rechazados), en orden de registro (id UUID v7).
    const ids = filas.slice(1).map((f) => f[columna('Id consumo')]);
    expect(ids).toEqual(
      Object.values(c)
        .map((x) => x.id)
        .sort(),
    );
    expect(filas.slice(1).every((f) => f.length === ENCABEZADO_CSV.length)).toBe(true);
  });

  it('cada columna con su valor: coma decimal, Sí/No, Bogotá, validación y corrección', async () => {
    const { filas, texto } = await descargar(orden, jefe.token);
    const porId = new Map(filas.slice(1).map((f) => [f[columna('Id consumo')], f]));
    const valor = (id: unknown, nombre: (typeof ENCABEZADO_CSV)[number]) =>
      porId.get(String(id))?.[columna(nombre)];

    expect(valor(c.a1.id, 'Orden')).toBe(codigo);
    expect(valor(c.a1.id, 'Supervisor')).toBe('Laura Gómez');
    expect(valor(c.a1.id, 'Código material')).toBe(m.arena.codigo);
    expect(valor(c.a1.id, 'Material')).toBe('Arena sílice');
    expect(valor(c.a1.id, 'Lote')).toBe('L-100');
    expect(valor(c.a1.id, 'Estado')).toBe('Aprobado');
    expect(valor(c.a1.id, 'Validado por')).toBe('Carlos Jefe');
    expect(valor(c.a1.id, 'Fecha de validación (Bogotá)')).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    );
    expect(valor(c.a1.id, 'Fecha y hora de registro (Bogotá)')).toBe(
      fechaHoraBogotaCsv(String(c.a1.client_created_at)),
    );
    expect(valor(c.a1.id, 'Costo del consumo (COP)')).toBe('105000');
    expect(valor(c.a1.id, 'Motivo de rechazo')).toBe('');

    expect(valor(c.a4.id, 'Cantidad')).toBe('0,333');
    expect(valor(c.a4.id, 'Costo del consumo (COP)')).toBe('117');
    expect(valor(c.r1.id, 'Cantidad')).toBe('2,5');
    expect(valor(c.r1.id, 'Cantidad en unidad del plan')).toBe('2500');
    expect(valor(c.r1.id, 'Unidad')).toBe('kg');
    expect(valor(c.r1.id, 'Unidad del plan')).toBe('g');
    expect(valor(c.r1.id, 'Con novedad')).toBe('Sí');
    expect(valor(c.r1.id, 'Costo unitario congelado (COP)')).toBe('9800');
    expect(valor(c.al1.id, 'Cantidad')).toBe('750');
    expect(valor(c.al1.id, 'Costo del consumo (COP)')).toBe('3150');
    expect(valor(c.f1.id, 'Unidad del plan')).toBe('kg');
    expect(valor(c.f1.id, 'Requiere novedad')).toBe('Sí');
    expect(valor(c.a2.id, 'Requiere novedad')).toBe('Sí');
    expect(valor(c.a2.id, 'Con novedad')).toBe('No');
    expect(valor(c.a2.id, 'Estado')).toBe('Pendiente');
    expect(valor(c.a2.id, 'Validado por')).toBe('');

    expect(valor(c.a3.id, 'Estado')).toBe('Rechazado');
    expect(valor(c.a3.id, 'Motivo de rechazo')).toBe('Lote equivocado; revisar "remisión"');
    // El motivo lleva ; y comillas: va entre comillas con las internas duplicadas.
    expect(texto).toContain('"Lote equivocado; revisar ""remisión"""');
    expect(valor(c.a5.id, 'Corrige a')).toBe(c.a3.id);
    expect(valor(c.a5.id, 'Registro tardío')).toBe('Sí');
    expect(valor(c.a1.id, 'Registro tardío')).toBe('No');
    // Ningún número con punto decimal.
    for (const nombre of [
      'Cantidad',
      'Cantidad en unidad del plan',
      'Costo del consumo (COP)',
    ] as const) {
      for (const f of filas.slice(1)) {
        expect(f[columna(nombre)]).toMatch(/^\d+(,\d+)?$/);
      }
    }
  });

  it('neutraliza fórmulas en las celdas de texto', async () => {
    const otra = await nuevaOrden(jefe.usuario.id);
    await asignar(otra, sup.usuario.id, admin.usuario.id);
    const lotes = ['=HYPERLINK("x")', '+1', '-2', '@SUM(A1)', '\tL-1', '\rL-2', 'L;3', 'Normal'];
    for (const lote of lotes) {
      await registrarConsumo({
        orderId: otra,
        materialId: m.arena.id,
        autor: autor(sup),
        cantidad: 1,
        lote,
      });
    }
    await renombrar(supAjeno.usuario.id, '=cmd|/C calc!A0');
    await insertar('order_supervisors', {
      order_id: otra,
      user_id: supAjeno.usuario.id,
      asignado_por: admin.usuario.id,
      activo: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await registrarConsumo({
      orderId: otra,
      materialId: m.arena.id,
      autor: autor(supAjeno),
      cantidad: 2,
    });

    const { filas, texto } = await descargar(otra, sup.token);
    const lotesCsv = filas.slice(1).map((f) => f[columna('Lote')]);
    expect(lotesCsv).toEqual([
      `'=HYPERLINK("x")`,
      "'+1",
      "'-2",
      "'@SUM(A1)",
      "'\tL-1",
      "'\rL-2",
      'L;3',
      'Normal',
      'L-2026-001',
    ]);
    expect(texto).toContain(`;"'=HYPERLINK(""x"")";`);
    expect(texto).toContain(`;"'\rL-2";`);
    expect(texto).toContain(`;"L;3";`);
    expect(filas.at(-1)?.[columna('Supervisor')]).toBe("'=cmd|/C calc!A0");
  });

  it('pagina por lotes: una orden con más de dos lotes sale completa y sin repetidos', async () => {
    const grande = await nuevaOrden(jefe.usuario.id);
    const total = LOTE_CSV * 2 + 3;
    const ahora = new Date().toISOString();
    const sentencias = Array.from({ length: total }, () =>
      sentenciaInsert('consumptions', {
        id: uuidv7(),
        order_id: grande,
        material_id: m.arena.id,
        cantidad: 1.5,
        unidad: 'kg',
        cantidad_en_unidad_plan: 1.5,
        lote: 'L-G',
        costo_unitario_cop_snapshot: 350,
        registrado_por: sup.usuario.id,
        device_id: sup.deviceId,
        client_created_at: ahora,
        server_received_at: ahora,
        created_at: ahora,
        updated_at: ahora,
      }),
    );
    for (let i = 0; i < sentencias.length; i += 100) {
      await env.DB.batch(sentencias.slice(i, i + 100));
    }
    const { filas } = await descargar(grande, admin.token);
    const ids = filas.slice(1).map((f) => f[columna('Id consumo')]);
    expect(ids).toHaveLength(total);
    expect(new Set(ids).size).toBe(total);
    expect(ids).toEqual([...ids].sort());
    expect(filas.slice(1).every((f) => f[columna('Costo del consumo (COP)')] === '525')).toBe(true);
  });

  it('exactamente un lote lleno también termina bien', async () => {
    const justa = await nuevaOrden(jefe.usuario.id);
    const ahora = new Date().toISOString();
    const sentencias = Array.from({ length: LOTE_CSV }, () =>
      sentenciaInsert('consumptions', {
        id: uuidv7(),
        order_id: justa,
        material_id: m.arena.id,
        cantidad: 2,
        unidad: 'kg',
        cantidad_en_unidad_plan: 2,
        lote: 'L-J',
        costo_unitario_cop_snapshot: 350,
        registrado_por: sup.usuario.id,
        device_id: sup.deviceId,
        client_created_at: ahora,
        server_received_at: ahora,
        created_at: ahora,
        updated_at: ahora,
      }),
    );
    for (let i = 0; i < sentencias.length; i += 100) {
      await env.DB.batch(sentencias.slice(i, i + 100));
    }
    const { filas } = await descargar(justa, jefe.token);
    expect(filas).toHaveLength(LOTE_CSV + 1);
  });

  it('orden sin consumos: solo BOM y encabezado; nombre de archivo saneado', async () => {
    const id = uuidv7();
    const ahora = new Date().toISOString();
    await insertar('production_orders', {
      id,
      codigo: `OP "x";\r\n=1/${id.slice(-6)}`,
      linea: 'Moldeo',
      estado: 'planeada',
      creada_por: jefe.usuario.id,
      created_at: ahora,
      updated_at: ahora,
    });
    const { respuesta, texto } = await descargar(id, jefe.token);
    expect(texto).toBe(`${BOM_CSV}${ENCABEZADO_CSV.join(';')}\r\n`);
    expect(respuesta.headers.get('Content-Disposition')).toBe(
      `attachment; filename="OP_x_1_${id.slice(-6)}-consumos.csv"`,
    );
  });

  it('permisos: jefe, admin y supervisor asignado; los demás 404; sin token 401', async () => {
    for (const token of [admin.token, sup.token]) {
      const { filas } = await descargar(orden, token);
      expect(filas).toHaveLength(Object.keys(c).length + 1);
    }
    for (const token of [supAjeno.token, supInactivo.token]) {
      await esperarError(
        await api(`/reports/orders/${orden}/export.csv`, { token }),
        404,
        'NO_ENCONTRADO',
      );
    }
    await esperarError(
      await api(`/reports/orders/${uuidv7()}/export.csv`, { token: jefe.token }),
      404,
      'NO_ENCONTRADO',
    );
    await esperarError(
      await api('/reports/orders/x/export.csv', { token: jefe.token }),
      400,
      'VALIDACION',
    );
    await esperarError(await api(`/reports/orders/${orden}/export.csv`), 401, 'NO_AUTENTICADO');
  });
});
