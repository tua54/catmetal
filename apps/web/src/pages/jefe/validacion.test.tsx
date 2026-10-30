// Panel del jefe · Validación de consumos, montado con el router real, la sesión real y Dexie sobre
// fake-indexeddb. Solo la red se simula, con respuestas del contrato de packages/shared.

import { esUuidV7, uuidv7, type ColaValidacion, type Perfil } from '@catmetal/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../datos/db';
import { consumoServidor, evidenciaServidor, novedadServidor } from '../../datos/pruebas/fabricas';
import {
  crearServidorJefe,
  elementoCola,
  entrarComoJefeEnLinea,
  errorApi,
  eventoLinea,
  json,
  ORDEN_A,
  ORDEN_B,
  resumenOrden,
  SUPERVISOR_ANA,
  SUPERVISOR_JUAN,
  TOKEN,
  type ServidorJefe,
} from '../../features/validacion/pruebas/servidor-jefe';
import { entrarSinConexion, reiniciarApp, renderizarApp } from '../../test/app';

let perfil: Perfil;
let servidor: ServidorJefe;
const crearUrl = vi.fn(() => 'blob:evidencia');
const liberarUrl = vi.fn();

function cola(elementos: ColaValidacion['elementos'], pendientes = elementos.length) {
  return json({ elementos, pendientes, siguiente_cursor: null } satisfies ColaValidacion);
}

async function tarjeta(material: string) {
  const lista = await screen.findByRole('list', { name: 'Consumos por validar' });
  return within(lista).getByRole('region', { name: new RegExp(material) });
}

beforeEach(async () => {
  await reiniciarApp();
  crearUrl.mockClear();
  liberarUrl.mockClear();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: crearUrl });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: liberarUrl });
  servidor = crearServidorJefe();
  servidor.en('GET', `/reports/orders/${ORDEN_A}/summary`, () => json(resumenOrden()));
  servidor.en('GET', `/orders/${ORDEN_A}/audit`, () =>
    json({ order_id: ORDEN_A, codigo: 'OP-2026-0587', eventos: [], siguiente_cursor: null }),
  );
});
afterEach(reiniciarApp);

describe('cola de validación', () => {
  it('muestra el contador, las tarjetas del Figma y filtra por orden y novedad', async () => {
    const conNovedad = elementoCola({
      registro_tardio: true,
      novedades: [
        {
          ...novedadServidor({
            tipo: 'reproceso',
            descripcion: 'Se usaron 8 kg adicionales por reproceso de sellado.',
          }),
          evidencias: [evidenciaServidor({ subido: true })],
        },
      ],
    });
    const faltaNovedad = elementoCola({
      material: { id: uuidv7(), codigo: 'MP-011', nombre: 'Colorante azul #08' },
      supervisor: { id: SUPERVISOR_ANA, nombre: 'Ana Gómez' },
      orden: { id: ORDEN_B, codigo: 'OP-2026-0600' },
      order_id: ORDEN_B,
      requiere_novedad: true,
      falta_novedad: true,
    });
    servidor.en('GET', '/validations/queue', ({ query }) => {
      if (query.get('orden') === ORDEN_B) {
        return cola([faltaNovedad]);
      }
      if (query.get('con_novedad') === 'true') {
        return cola([conNovedad]);
      }
      return cola([conNovedad, faltaNovedad], 7);
    });
    perfil = await entrarComoJefeEnLinea(servidor);
    const usuario = userEvent.setup();
    renderizarApp('/jefe');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Validación de consumos' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('banner')).toHaveTextContent('Validación de Consumos');
    expect(screen.getByRole('banner')).toHaveTextContent('Panel del jefe · Rol: Aprobador');
    const resina = await tarjeta('Resina PET Grado A');
    // El contador es el total del servidor (todas las páginas), no solo lo visible.
    expect(screen.getByText('7 pendientes')).toBeInTheDocument();
    expect(resina).toHaveTextContent('125,5 kg');
    expect(resina).toHaveTextContent('Lote 4471');
    expect(resina).toHaveTextContent('Juan S.');
    expect(resina).toHaveTextContent(/10:24 a\. m\./);
    expect(within(resina).getByText('Con novedad')).toBeInTheDocument();
    expect(within(resina).getByText('Registro tardío')).toBeInTheDocument();
    expect(within(resina).getByText('Justificación del supervisor:')).toBeInTheDocument();
    expect(resina).toHaveTextContent('Reproceso: Se usaron 8 kg adicionales');
    // La primera tarjeta está seleccionada (borde brand-600) y alimenta la columna derecha.
    expect(within(resina).getByRole('button', { pressed: true })).toHaveTextContent(
      'Resina PET Grado A',
    );
    const colorante = await tarjeta('Colorante azul #08');
    expect(within(colorante).getByText('Falta novedad')).toBeInTheDocument();

    const peticionesCola = () => servidor.peticionesA('GET', '/validations/queue');
    await usuario.selectOptions(screen.getByRole('combobox', { name: 'Orden' }), [
      'Orden OP-2026-0600',
    ]);
    await waitFor(() =>
      expect(peticionesCola().some((p) => p.query.get('orden') === ORDEN_B)).toBe(true),
    );
    expect(await screen.findByText('Por validar — Orden OP-2026-0600')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /Resina PET/ })).not.toBeInTheDocument(),
    );

    await usuario.selectOptions(screen.getByRole('combobox', { name: 'Orden' }), [
      'Todas las órdenes',
    ]);
    await usuario.click(screen.getByRole('switch', { name: 'Solo con novedad' }));
    await waitFor(() =>
      expect(peticionesCola().some((p) => p.query.get('con_novedad') === 'true')).toBe(true),
    );
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /Colorante/ })).not.toBeInTheDocument(),
    );
    expect(screen.getByText('1 pendiente')).toBeInTheDocument();
    // Filtro por supervisor: opciones con los nombres de la cola sin filtrar.
    expect(
      within(screen.getByRole('combobox', { name: 'Supervisor' })).getByRole('option', {
        name: 'Ana Gómez',
      }),
    ).toBeInTheDocument();
    expect(peticionesCola().every((p) => p.autorizacion === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('valida con confirmación y envía la versión vista', async () => {
    const elemento = elementoCola();
    let decidido = false;
    servidor.en('GET', '/validations/queue', () => cola(decidido ? [] : [elemento]));
    servidor.en('POST', `/consumptions/${elemento.id}/approve`, () => {
      decidido = true;
      return json({}, 201);
    });
    perfil = await entrarComoJefeEnLinea(servidor);
    const usuario = userEvent.setup();
    renderizarApp('/jefe');

    const resina = await tarjeta('Resina PET Grado A');
    await usuario.click(
      within(resina).getByRole('button', { name: 'Validar gasto de Resina PET Grado A' }),
    );
    const dialogo = await screen.findByRole('alertdialog', { name: '¿Validar este gasto?' });
    expect(dialogo).toHaveTextContent('125,5 kg de Resina PET Grado A');
    expect(servidor.peticionesA('POST', `/consumptions/${elemento.id}/approve`)).toHaveLength(0);
    await usuario.click(within(dialogo).getByRole('button', { name: 'Validar gasto' }));

    expect(await screen.findByText('Consumo validado')).toBeInTheDocument();
    const [envio] = servidor.peticionesA('POST', `/consumptions/${elemento.id}/approve`);
    const cuerpo = envio?.cuerpo as Record<string, unknown>;
    expect(cuerpo.version).toBe(3);
    expect(esUuidV7(cuerpo.id)).toBe(true);
    expect(typeof cuerpo.client_created_at).toBe('string');
    expect(Object.keys(cuerpo).sort()).toEqual(['client_created_at', 'id', 'version']);
    expect(await screen.findByText('No hay consumos por validar')).toBeInTheDocument();
  });

  it('rechazar exige un motivo de 3 a 500 caracteres', async () => {
    const elemento = elementoCola();
    servidor.en('GET', '/validations/queue', () => cola([elemento]));
    servidor.en('POST', `/consumptions/${elemento.id}/reject`, () => json({}, 201));
    perfil = await entrarComoJefeEnLinea(servidor);
    const usuario = userEvent.setup();
    renderizarApp('/jefe');

    const resina = await tarjeta('Resina PET Grado A');
    await usuario.click(
      within(resina).getByRole('button', { name: 'Rechazar Resina PET Grado A' }),
    );
    const dialogo = await screen.findByRole('alertdialog', { name: 'Rechazar consumo' });
    await usuario.click(within(dialogo).getByRole('button', { name: 'Rechazar consumo' }));
    expect(within(dialogo).getByText('Motivo del rechazo es obligatorio.')).toBeInTheDocument();
    await usuario.type(within(dialogo).getByRole('textbox', { name: /Motivo del rechazo/ }), 'no');
    await usuario.click(within(dialogo).getByRole('button', { name: 'Rechazar consumo' }));
    expect(within(dialogo).getByText('Escriba al menos 3 caracteres.')).toBeInTheDocument();
    expect(servidor.peticionesA('POST', `/consumptions/${elemento.id}/reject`)).toHaveLength(0);

    await usuario.type(
      within(dialogo).getByRole('textbox', { name: /Motivo del rechazo/ }),
      ' coincide con el lote',
    );
    await usuario.click(within(dialogo).getByRole('button', { name: 'Rechazar consumo' }));
    expect(await screen.findByText('Consumo rechazado')).toBeInTheDocument();
    const [envio] = servidor.peticionesA('POST', `/consumptions/${elemento.id}/reject`);
    expect(envio?.cuerpo).toMatchObject({ version: 3, motivo: 'no coincide con el lote' });
  });

  it.each([
    [
      'falta la novedad',
      { requiere_novedad: true, falta_novedad: true },
      'Falta la justificación de la novedad: el supervisor debe registrarla',
    ],
    ['es propio', { propio: true }, 'Registrado por usted: requiere otro jefe'],
  ] as const)(
    'deshabilita "Validar gasto" y explica por qué si %s',
    async (_caso, cambios, texto) => {
      const elemento = elementoCola(cambios);
      servidor.en('GET', '/validations/queue', () => cola([elemento]));
      perfil = await entrarComoJefeEnLinea(servidor);
      const usuario = userEvent.setup();
      renderizarApp('/jefe');

      const resina = await tarjeta('Resina PET Grado A');
      const validar = within(resina).getByRole('button', {
        name: 'Validar gasto de Resina PET Grado A',
      });
      expect(validar).toHaveAttribute('aria-disabled', 'true');
      expect(validar).toHaveAccessibleDescription(texto);
      await usuario.click(validar);
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(servidor.peticionesA('POST', `/consumptions/${elemento.id}/approve`)).toHaveLength(0);
    },
  );

  it('ante un 409 avisa con claridad y recarga la cola', async () => {
    const elemento = elementoCola();
    servidor.en('GET', '/validations/queue', () => cola([elemento]));
    servidor.en('POST', `/consumptions/${elemento.id}/approve`, () =>
      errorApi('CONFLICTO', { version_servidor: 4 }),
    );
    perfil = await entrarComoJefeEnLinea(servidor);
    const usuario = userEvent.setup();
    renderizarApp('/jefe');

    const resina = await tarjeta('Resina PET Grado A');
    const cargasAntes = servidor.peticionesA('GET', '/validations/queue').length;
    await usuario.click(
      within(resina).getByRole('button', { name: 'Validar gasto de Resina PET Grado A' }),
    );
    const dialogo = await screen.findByRole('alertdialog');
    await usuario.click(within(dialogo).getByRole('button', { name: 'Validar gasto' }));

    expect(await screen.findByText('El consumo cambió mientras lo revisaba')).toBeInTheDocument();
    await waitFor(() =>
      expect(servidor.peticionesA('GET', '/validations/queue').length).toBeGreaterThan(cargasAntes),
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('abre la evidencia descargándola con el token y libera la URL al cerrar', async () => {
    const evidencia = evidenciaServidor({ subido: true, mime: 'image/png' });
    const elemento = elementoCola({
      novedades: [
        { ...novedadServidor({ descripcion: 'Sellado defectuoso' }), evidencias: [evidencia] },
      ],
    });
    servidor.en('GET', '/validations/queue', () => cola([elemento]));
    servidor.en(
      'GET',
      `/evidences/${evidencia.id}`,
      () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          headers: { 'Content-Type': 'image/png' },
        }),
    );
    perfil = await entrarComoJefeEnLinea(servidor);
    const usuario = userEvent.setup();
    renderizarApp('/jefe');

    const resina = await tarjeta('Resina PET Grado A');
    await usuario.click(within(resina).getByRole('button', { name: /evidencia_1\.png/ }));
    const visor = await screen.findByRole('dialog', { name: 'evidencia_1.png' });
    expect(within(visor).getByRole('img')).toHaveAttribute('src', 'blob:evidencia');
    const [descarga] = servidor.peticionesA('GET', `/evidences/${evidencia.id}`);
    expect(descarga?.autorizacion).toBe(`Bearer ${TOKEN}`);
    const blob = crearUrl.mock.calls[0] as unknown as [Blob];
    expect(blob[0].type).toBe('image/png');
    expect(liberarUrl).not.toHaveBeenCalled();

    await usuario.click(within(visor).getByRole('button', { name: 'Cerrar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(liberarUrl).toHaveBeenCalledWith('blob:evidencia');
  });
});

describe('columna derecha', () => {
  it('muestra el resumen de la orden con el costo en COP y las novedades en ámbar', async () => {
    servidor.en('GET', '/validations/queue', () => cola([elementoCola()]));
    perfil = await entrarComoJefeEnLinea(servidor);
    renderizarApp('/jefe');

    const resumen = await screen.findByRole('region', { name: 'Resumen de la orden' });
    expect(await within(resumen).findByText('$ 4.182.300')).toBeInTheDocument();
    expect(resumen).toHaveTextContent('Materiales consumidos3 registros');
    expect(within(resumen).getByText('1 (1 por sustentar)')).toHaveClass('text-warning-800');
    expect(resumen).toHaveTextContent('Estado de la ordenEn proceso');
    const tabla = within(resumen).getByRole('table', { name: 'Planeado vs consumido' });
    const fila = within(tabla).getByRole('row', { name: /Resina PET Grado A/ });
    expect(fila).toHaveTextContent('100 kg');
    expect(fila).toHaveTextContent('125,5 kg (125,5 %)');
    expect(fila).toHaveTextContent('Supera la tolerancia');
    expect(within(resumen).getByRole('link', { name: 'Gestionar la orden' })).toHaveAttribute(
      'href',
      `/jefe/ordenes/${ORDEN_A}`,
    );
  });

  it('muestra la trazabilidad con colores por tipo y carga más por cursor', async () => {
    servidor.en('GET', '/validations/queue', () => cola([elementoCola()]));
    servidor.en('GET', `/orders/${ORDEN_A}/audit`, ({ query }) =>
      query.get('cursor') === '2'
        ? json({
            order_id: ORDEN_A,
            codigo: 'OP-2026-0587',
            eventos: [
              eventoLinea({
                seq: 3,
                tipo: 'rechazo',
                accion: 'rechazar',
                descripcion: 'Rechazó consumo de Colorante azul #08',
                actor: { id: uuidv7(), nombre: 'Roberto Méndez', rol: 'jefe' },
                client_at: '2026-10-29T14:48:00.000Z',
                server_at: '2026-10-29T14:48:01.000Z',
              }),
            ],
            siguiente_cursor: null,
          })
        : json({
            order_id: ORDEN_A,
            codigo: 'OP-2026-0587',
            eventos: [
              eventoLinea({ seq: 1 }),
              eventoLinea({
                seq: 2,
                tipo: 'novedad',
                accion: 'crear',
                descripcion: 'Registró 125,5 kg de Resina PET + novedad con evidencia',
                actor: { id: SUPERVISOR_JUAN, nombre: 'Juan Suárez', rol: 'supervisor' },
                client_at: '2026-10-29T15:24:00.000Z',
                server_at: '2026-10-29T15:26:00.000Z',
              }),
            ],
            siguiente_cursor: 2,
          }),
    );
    perfil = await entrarComoJefeEnLinea(servidor);
    const usuario = userEvent.setup();
    renderizarApp('/jefe');

    const linea = await screen.findByRole('list', { name: 'Trazabilidad completa de la orden' });
    const eventos = within(linea).getAllByRole('listitem');
    expect(eventos).toHaveLength(2);
    expect(eventos[0]).toHaveTextContent('Evento del sistema');
    expect(eventos[0]).toHaveTextContent('Sistema');
    expect(eventos[0]?.querySelector('.bg-ink-500')).not.toBeNull();
    // Hora del dispositivo (cuándo pasó en planta), actor corto y rol.
    expect(eventos[1]).toHaveTextContent(/10:24 a\. m\. — Juan S\. \(supervisor\)/);
    expect(eventos[1]).toHaveTextContent('Registro con novedad');
    expect(eventos[1]?.querySelector('.bg-warning-700')).not.toBeNull();

    await usuario.click(screen.getByRole('button', { name: 'Cargar más' }));
    await waitFor(() => expect(within(linea).getAllByRole('listitem')).toHaveLength(3));
    const rechazo = within(linea).getAllByRole('listitem')[2];
    expect(rechazo).toHaveTextContent('Rechazo');
    expect(rechazo).toHaveTextContent('Roberto M. (jefe)');
    expect(rechazo?.querySelector('.bg-danger-700')).not.toBeNull();
    expect(
      servidor
        .peticionesA('GET', `/orders/${ORDEN_A}/audit`)
        .some((p) => p.query.get('cursor') === '2'),
    ).toBe(true);
    expect(screen.queryByRole('button', { name: 'Cargar más' })).not.toBeInTheDocument();
  });
});

describe('sin conexión (S5)', () => {
  async function sembrarConsumoDelJefe(jefeId: string): Promise<string> {
    const servidorConsumo = consumoServidor({
      order_id: ORDEN_A,
      registrado_por: SUPERVISOR_JUAN,
      cantidad: 40,
      cantidad_en_unidad_plan: 40,
      version: 2,
    });
    await db.consumos.put({
      user_id: jefeId,
      id: servidorConsumo.id,
      order_id: ORDEN_A,
      material_id: servidorConsumo.material_id,
      cantidad: 40,
      unidad: 'kg',
      lote: 'L-9',
      corrige_a: null,
      registrado_por: SUPERVISOR_JUAN,
      client_created_at: servidorConsumo.client_created_at,
      dia_bogota: '2026-10-29',
      base_local: null,
      servidor: servidorConsumo,
      servidor_diferido: null,
      version: 2,
      estado_local: 'sincronizado',
      ultimo_resultado: null,
      falta_novedad: false,
      requiere_novedad: false,
      registro_tardio: false,
      motivo_rechazo: null,
      error_sync: null,
      conflicto_servidor: null,
      actualizado_at: servidorConsumo.updated_at,
    });
    await db.materiales.put({
      user_id: jefeId,
      id: servidorConsumo.material_id,
      codigo: 'MP-001',
      nombre: 'Arena sílice',
      unidad: 'kg',
      costo_unitario_cop: 1000,
      activo: true,
    });
    await db.usuarios.put({
      user_id: jefeId,
      id: SUPERVISOR_JUAN,
      nombre: 'Juan Suárez',
      rol: 'supervisor',
      activo: true,
    });
    await db.ordenes.put({
      user_id: jefeId,
      id: ORDEN_A,
      codigo: 'OP-2026-0587',
      linea: 'Moldeo 1',
      estado: 'en_proceso',
      fecha_inicio: null,
      fecha_fin: null,
      creada_por: jefeId,
      created_at: servidorConsumo.created_at,
      updated_at: servidorConsumo.updated_at,
      revocada: false,
    });
    return servidorConsumo.id;
  }

  it('muestra la cola guardada en la tablet y encola la validación en el outbox', async () => {
    perfil = await entrarSinConexion('jefe', 'Roberto Méndez');
    const consumoId = await sembrarConsumoDelJefe(perfil.id);
    const usuario = userEvent.setup();
    const { sincronizacion } = renderizarApp('/jefe');

    expect(
      await screen.findByText('Sin conexión: cola guardada en esta tablet'),
    ).toBeInTheDocument();
    const arena = await tarjeta('Arena sílice');
    expect(arena).toHaveTextContent('40 kg');
    expect(arena).toHaveTextContent('Juan S.');
    expect(screen.getByText('1 pendiente')).toBeInTheDocument();
    await usuario.click(
      within(arena).getByRole('button', { name: 'Validar gasto de Arena sílice' }),
    );
    const dialogo = await screen.findByRole('alertdialog');
    await usuario.click(within(dialogo).getByRole('button', { name: 'Validar gasto' }));

    expect(await screen.findByText('Consumo validado en esta tablet')).toBeInTheDocument();
    const [mutacion] = await db.outbox.toArray();
    expect(mutacion?.tipo).toBe('consumo.aprobar');
    expect(mutacion?.payload).toMatchObject({ consumption_id: consumoId, version: 2 });
    expect(sincronizacion.cambioLocal).toHaveBeenCalled();
    expect(await within(arena).findByText('Pendiente de sync')).toBeInTheDocument();
    expect(within(arena).queryByRole('button', { name: /Validar gasto/ })).not.toBeInTheDocument();
  });

  it('si la red se corta al decidir, guarda la decisión en la tablet con la misma versión', async () => {
    servidor.en('GET', '/validations/queue', () => cola([]));
    perfil = await entrarComoJefeEnLinea(servidor);
    const consumoId = await sembrarConsumoDelJefe(perfil.id);
    const elemento = elementoCola({ id: consumoId, version: 2 });
    servidor.en('GET', '/validations/queue', () => cola([elemento]));
    const usuario = userEvent.setup();
    renderizarApp('/jefe');

    const resina = await tarjeta('Resina PET Grado A');
    servidor.caido = true;
    await usuario.click(
      within(resina).getByRole('button', { name: 'Rechazar Resina PET Grado A' }),
    );
    const dialogo = await screen.findByRole('alertdialog');
    await usuario.type(within(dialogo).getByRole('textbox'), 'Cantidad sin soporte');
    await usuario.click(within(dialogo).getByRole('button', { name: 'Rechazar consumo' }));

    expect(await screen.findByText('Consumo rechazado en esta tablet')).toBeInTheDocument();
    const [mutacion] = await db.outbox.toArray();
    expect(mutacion?.tipo).toBe('consumo.rechazar');
    expect(mutacion?.payload).toMatchObject({
      consumption_id: consumoId,
      version: 2,
      motivo: 'Cantidad sin soporte',
    });
    // El mismo id de validación que se intentó enviar por REST: el servidor no puede duplicarla.
    const [intento] = servidor.peticionesA('POST', `/consumptions/${consumoId}/reject`);
    expect((intento?.cuerpo as { id: string }).id).toBe((mutacion?.payload as { id: string }).id);
  });
});
