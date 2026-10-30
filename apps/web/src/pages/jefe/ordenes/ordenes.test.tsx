// Gestión de órdenes del jefe (tarea 5.2): lista, crear, iniciar, finalizar con `force` explícito y
// exportar CSV. Router, sesión y cliente HTTP reales; solo la red se simula con el contrato.

import {
  uuidv7,
  type DetalleOrden,
  type ListaMateriales,
  type ListaOrdenes,
  type Material,
  type Orden,
} from '@catmetal/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  crearServidorJefe,
  entrarComoJefeEnLinea,
  errorApi,
  json,
  ORDEN_A,
  resumenOrden,
  TOKEN,
  type ServidorJefe,
} from '../../../features/validacion/pruebas/servidor-jefe';
import { reiniciarApp, renderizarApp } from '../../../test/app';

let servidor: ServidorJefe;
const crearUrl = vi.fn(() => 'blob:csv');
const liberarUrl = vi.fn();

const AHORA = '2026-10-29T13:00:00.000Z';

function orden(base: Partial<Orden> = {}): Orden {
  return {
    id: ORDEN_A,
    codigo: 'OP-2026-0587',
    linea: 'Moldeo 1',
    estado: 'en_proceso',
    fecha_inicio: AHORA,
    fecha_fin: null,
    creada_por: uuidv7(),
    created_at: AHORA,
    updated_at: AHORA,
    ...base,
  };
}

function detalle(base: Partial<DetalleOrden> = {}): DetalleOrden {
  return {
    ...orden(),
    tolerancia_pct: 5,
    materiales: [
      {
        material_id: uuidv7(),
        codigo: 'MP-001',
        nombre: 'Arena sílice',
        unidad: 'kg',
        cantidad_planeada: 100,
        consumido: 40,
        porcentaje: 40,
        excede_tolerancia: false,
      },
    ],
    materiales_fuera_de_plan: [],
    supervisores: [
      {
        user_id: uuidv7(),
        nombre: 'Juan Suárez',
        asignado_por: uuidv7(),
        created_at: AHORA,
        updated_at: AHORA,
      },
    ],
    ...base,
  };
}

function material(base: Partial<Material>): Material {
  return {
    id: uuidv7(),
    codigo: 'MP-001',
    nombre: 'Arena sílice',
    unidad: 'kg',
    costo_unitario_cop: 1200,
    activo: true,
    created_at: AHORA,
    updated_at: AHORA,
    ...base,
  };
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

describe('lista de órdenes', () => {
  it('lista por estado y pagina por cursor', async () => {
    const otra = uuidv7();
    servidor.en('GET', '/orders', ({ query }) => {
      if (query.get('estado') === 'planeada') {
        return json({
          ordenes: [orden({ id: otra, codigo: 'OP-2026-0600', estado: 'planeada' })],
          siguiente_cursor: null,
        } satisfies ListaOrdenes);
      }
      return json({
        ordenes:
          query.get('cursor') === ORDEN_A
            ? [orden({ id: otra, codigo: 'OP-2026-0600' })]
            : [orden()],
        siguiente_cursor: query.get('cursor') === ORDEN_A ? null : ORDEN_A,
      } satisfies ListaOrdenes);
    });
    await entrarComoJefeEnLinea(servidor);
    const usuario = userEvent.setup();
    renderizarApp('/jefe/ordenes');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Órdenes de producción' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('banner')).toHaveTextContent('Órdenes de producción');
    const lista = await screen.findByRole('list', { name: 'Órdenes de producción' });
    expect(within(lista).getByRole('link', { name: 'Orden OP-2026-0587' })).toHaveAttribute(
      'href',
      `/jefe/ordenes/${ORDEN_A}`,
    );
    expect(lista).toHaveTextContent('En proceso');

    await usuario.click(screen.getByRole('button', { name: 'Cargar más órdenes' }));
    expect(
      await within(lista).findByRole('link', { name: 'Orden OP-2026-0600' }),
    ).toBeInTheDocument();

    await usuario.selectOptions(screen.getByRole('combobox', { name: 'Estado' }), ['Planeada']);
    await waitFor(() =>
      expect(
        servidor.peticionesA('GET', '/orders').some((p) => p.query.get('estado') === 'planeada'),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'Orden OP-2026-0587' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('link', { name: 'Nueva orden' })).toHaveAttribute(
      'href',
      '/jefe/ordenes/nueva',
    );
  });
});

describe('crear orden', () => {
  it('valida el formulario y envía el contrato de POST /orders', async () => {
    const arena = material({});
    const resina = material({ codigo: 'MP-002', nombre: 'Resina furánica', unidad: 'l' });
    servidor.en('GET', '/materials', () =>
      json({ materiales: [arena, resina], siguiente_cursor: null } satisfies ListaMateriales),
    );
    servidor.en('POST', '/orders', ({ cuerpo }) =>
      json(
        { ...orden({ estado: 'planeada', id: (cuerpo as { id: string }).id }), materiales: [] },
        201,
      ),
    );
    await entrarComoJefeEnLinea(servidor);
    const usuario = userEvent.setup();
    const { router } = renderizarApp('/jefe/ordenes/nueva');

    const formulario = await screen.findByRole('form', { name: 'Datos de la orden' });
    await screen.findByRole('combobox', { name: /Material 1/ });
    await waitFor(() => expect(screen.queryByText('Cargando materiales…')).not.toBeInTheDocument());

    await usuario.click(within(formulario).getByRole('button', { name: 'Crear orden' }));
    expect(
      await within(formulario).findByText(
        'El código de la orden debe tener el formato OP-AAAA-NNNN.',
      ),
    ).toBeInTheDocument();
    expect(within(formulario).getByText('Elija el material.')).toBeInTheDocument();
    expect(within(formulario).getByText('Escriba la cantidad planeada.')).toBeInTheDocument();
    expect(servidor.peticionesA('POST', '/orders')).toHaveLength(0);

    await usuario.type(
      within(formulario).getByRole('textbox', { name: /Código de la orden/ }),
      'op-2026-0700',
    );
    await usuario.type(
      within(formulario).getByRole('textbox', { name: /Línea de producción/ }),
      'Moldeo 2',
    );
    const combo = within(formulario).getByRole('combobox', { name: /Material 1/ });
    await usuario.click(combo);
    await usuario.type(combo, 'resina');
    await usuario.click(await screen.findByRole('option', { name: /Resina furánica/ }));
    // Unidades convertibles con la del material (l ↔ ml), con la del material por defecto.
    const unidad = within(formulario).getByRole('combobox', { name: /Unidad 1/ });
    expect(unidad).toHaveValue('l');
    expect(
      within(unidad)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['l', 'ml']);
    await usuario.type(
      within(formulario).getByRole('textbox', { name: /Cantidad planeada 1/ }),
      '120,5',
    );

    await usuario.click(within(formulario).getByRole('button', { name: 'Crear orden' }));
    await waitFor(() => expect(servidor.peticionesA('POST', '/orders')).toHaveLength(1));
    const [envio] = servidor.peticionesA('POST', '/orders');
    const cuerpo = envio?.cuerpo as Record<string, unknown>;
    expect(cuerpo).toMatchObject({
      codigo: 'OP-2026-0700',
      linea: 'Moldeo 2',
      materiales: [{ material_id: resina.id, cantidad_planeada: 120.5, unidad: 'l' }],
    });
    expect(envio?.autorizacion).toBe(`Bearer ${TOKEN}`);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/jefe/ordenes/${String(cuerpo.id)}`),
    );
    expect(await screen.findByText('Orden creada')).toBeInTheDocument();
  });

  it('marca el código si ya existe una orden con él', async () => {
    const arena = material({});
    servidor.en('GET', '/materials', () =>
      json({ materiales: [arena], siguiente_cursor: null } satisfies ListaMateriales),
    );
    servidor.en('POST', '/orders', () =>
      errorApi('CONFLICTO', { entidad: 'production_orders', campos: ['codigo'] }),
    );
    await entrarComoJefeEnLinea(servidor);
    const usuario = userEvent.setup();
    renderizarApp('/jefe/ordenes/nueva');

    const formulario = await screen.findByRole('form', { name: 'Datos de la orden' });
    await usuario.type(
      within(formulario).getByRole('textbox', { name: /Código de la orden/ }),
      'OP-2026-0587',
    );
    await usuario.type(
      within(formulario).getByRole('textbox', { name: /Línea de producción/ }),
      'Moldeo 1',
    );
    const combo = within(formulario).getByRole('combobox', { name: /Material 1/ });
    await usuario.click(combo);
    await usuario.click(await screen.findByRole('option', { name: /Arena sílice/ }));
    await usuario.type(
      within(formulario).getByRole('textbox', { name: /Cantidad planeada 1/ }),
      '10',
    );
    await usuario.click(within(formulario).getByRole('button', { name: 'Crear orden' }));

    expect(
      await within(formulario).findByText('Ya existe una orden con este código.'),
    ).toBeInTheDocument();
    expect(within(formulario).getByRole('textbox', { name: /Código de la orden/ })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });
});

describe('detalle de la orden', () => {
  it('inicia una orden planeada tras confirmar', async () => {
    let estado: Orden['estado'] = 'planeada';
    servidor.en('GET', `/orders/${ORDEN_A}`, () =>
      json(detalle({ estado, fecha_inicio: estado === 'planeada' ? null : AHORA })),
    );
    servidor.en('POST', `/orders/${ORDEN_A}/start`, () => {
      estado = 'en_proceso';
      return json(orden());
    });
    await entrarComoJefeEnLinea(servidor);
    const usuario = userEvent.setup();
    renderizarApp(`/jefe/ordenes/${ORDEN_A}`);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Orden OP-2026-0587' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('banner')).toHaveTextContent('Orden OP-2026-0587 · Línea Moldeo 1');
    expect(screen.getByText('Planeada')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Arena sílice' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Finalizar orden' })).not.toBeInTheDocument();

    await usuario.click(screen.getByRole('button', { name: 'Iniciar orden' }));
    const dialogo = await screen.findByRole('alertdialog', { name: '¿Iniciar la orden?' });
    expect(servidor.peticionesA('POST', `/orders/${ORDEN_A}/start`)).toHaveLength(0);
    await usuario.click(within(dialogo).getByRole('button', { name: 'Iniciar orden' }));

    expect(await screen.findByText('Orden iniciada')).toBeInTheDocument();
    expect(servidor.peticionesA('POST', `/orders/${ORDEN_A}/start`)).toHaveLength(1);
    expect(await screen.findByRole('button', { name: 'Finalizar orden' })).toBeInTheDocument();
  });

  it('si quedan pendientes, muestra cuántos y exige una segunda confirmación para forzar', async () => {
    servidor.en('GET', `/orders/${ORDEN_A}`, () => json(detalle()));
    servidor.en('POST', `/orders/${ORDEN_A}/finish`, ({ cuerpo }) =>
      (cuerpo as { force?: boolean }).force === true
        ? json(orden({ estado: 'finalizada', fecha_fin: AHORA }))
        : errorApi('ORDEN_CON_PENDIENTES', { pendientes: 2 }),
    );
    await entrarComoJefeEnLinea(servidor);
    const usuario = userEvent.setup();
    renderizarApp(`/jefe/ordenes/${ORDEN_A}`);

    await usuario.click(await screen.findByRole('button', { name: 'Finalizar orden' }));
    const primero = await screen.findByRole('alertdialog', { name: '¿Finalizar la orden?' });
    await usuario.click(within(primero).getByRole('button', { name: 'Finalizar orden' }));

    expect(
      await screen.findByText('La orden tiene 2 consumos pendientes de validar'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Validar los pendientes' })).toHaveAttribute(
      'href',
      `/jefe?orden=${ORDEN_A}`,
    );
    const envios = () => servidor.peticionesA('POST', `/orders/${ORDEN_A}/finish`);
    expect(envios().map((p) => p.cuerpo)).toEqual([{}]);

    await usuario.click(screen.getByRole('button', { name: 'Finalizar de todos modos' }));
    const segundo = await screen.findByRole('alertdialog', {
      name: '¿Finalizar con consumos sin validar?',
    });
    expect(segundo).toHaveTextContent('Quedarán 2 consumos pendientes sin validar');
    // Cancelar la segunda confirmación no envía nada.
    await usuario.click(within(segundo).getByRole('button', { name: 'Cancelar' }));
    expect(envios()).toHaveLength(1);

    await usuario.click(screen.getByRole('button', { name: 'Finalizar de todos modos' }));
    const tercero = await screen.findByRole('alertdialog');
    await usuario.click(
      within(tercero).getByRole('button', { name: 'Sí, finalizar con pendientes' }),
    );
    expect(await screen.findByText('Orden finalizada')).toBeInTheDocument();
    expect(envios().map((p) => p.cuerpo)).toEqual([{}, { force: true }]);
  });

  it('exporta el CSV descargándolo con el token', async () => {
    servidor.en('GET', `/orders/${ORDEN_A}`, () => json(detalle()));
    servidor.en(
      'GET',
      `/reports/orders/${ORDEN_A}/export.csv`,
      () =>
        new Response('﻿codigo;material\r\nOP-2026-0587;Arena\r\n', {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="OP-2026-0587-consumos.csv"',
          },
        }),
    );
    const clics: { href: string; download: string }[] = [];
    const clic = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clics.push({ href: this.href, download: this.download });
    });
    await entrarComoJefeEnLinea(servidor);
    const usuario = userEvent.setup();
    renderizarApp(`/jefe/ordenes/${ORDEN_A}`);

    await usuario.click(await screen.findByRole('button', { name: 'Exportar CSV' }));
    await waitFor(() => expect(clics).toHaveLength(1));
    expect(clics[0]).toEqual({ href: 'blob:csv', download: 'OP-2026-0587-consumos.csv' });
    const [descarga] = servidor.peticionesA('GET', `/reports/orders/${ORDEN_A}/export.csv`);
    expect(descarga?.autorizacion).toBe(`Bearer ${TOKEN}`);
    const [blob] = crearUrl.mock.calls[0] as unknown as [Blob];
    expect(await blob.text()).toContain('OP-2026-0587;Arena');
    clic.mockRestore();
  });

  it('muestra un error claro si el CSV no se puede descargar', async () => {
    servidor.en('GET', `/orders/${ORDEN_A}`, () => json(detalle()));
    servidor.en('GET', `/reports/orders/${ORDEN_A}/export.csv`, () => errorApi('PERMISO_DENEGADO'));
    await entrarComoJefeEnLinea(servidor);
    const usuario = userEvent.setup();
    renderizarApp(`/jefe/ordenes/${ORDEN_A}`);

    await usuario.click(await screen.findByRole('button', { name: 'Exportar CSV' }));
    expect(await screen.findByText('No se pudo exportar el CSV')).toBeInTheDocument();
    expect(screen.getByText('No tiene permiso para realizar esta acción.')).toBeInTheDocument();
    expect(crearUrl).not.toHaveBeenCalled();
  });
});

describe('lista vacía (tarea 6.2)', () => {
  it('con filtro ofrece ver todos los estados; sin órdenes, crear la primera', async () => {
    servidor.en('GET', '/orders', () =>
      json({ ordenes: [], siguiente_cursor: null } satisfies ListaOrdenes),
    );
    await entrarComoJefeEnLinea(servidor);
    const usuario = userEvent.setup();
    const { router } = renderizarApp('/jefe/ordenes?estado=finalizada');
    expect(await screen.findByText('No hay órdenes en estado "Finalizada".')).toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: 'Ver todos los estados' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(await screen.findByRole('link', { name: 'Crear una orden' })).toHaveAttribute(
      'href',
      '/jefe/ordenes/nueva',
    );
  });
});
