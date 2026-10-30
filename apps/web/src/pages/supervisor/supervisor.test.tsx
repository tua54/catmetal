// Pantallas del supervisor montadas con el router real, la sesión real (offline) y Dexie sobre
// fake-indexeddb. jsdom no tiene canvas: la recompresión de `browser-image-compression` se simula
// devolviendo un JPEG CON EXIF, para comprobar que lo que se guarda en Dexie ya no lo tiene.

import { uuidv7, type Perfil } from '@catmetal/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../datos/db';
import { registrarConsumoLocal } from '../../datos/outbox';
import { consumoServidor } from '../../datos/pruebas/fabricas';
import type { ConsumoLocal, MutacionOutbox } from '../../datos/tipos';
import { tieneExif } from '../../features/consumos/fotos';
import {
  entrarSinConexion,
  reiniciarApp,
  renderizarApp,
  sincronizacionFalsa,
} from '../../test/app';

vi.mock('browser-image-compression', async () => {
  const { jpegConExif } = await import('../../features/consumos/pruebas/jpeg');
  return {
    default: vi.fn(() =>
      Promise.resolve(new Blob([jpegConExif() as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })),
    ),
  };
});

const ORDEN = uuidv7();
const ARENA = uuidv7();
const RESINA = uuidv7();
const GRAFITO = uuidv7();
const BENTONITA = uuidv7();
const AHORA = '2026-10-29T15:00:00.000Z';

let perfil: Perfil;
const liberarUrl = vi.fn();

async function sembrar(conAsignacion = true) {
  const u = perfil.id;
  await db.ordenes.put({
    user_id: u,
    id: ORDEN,
    codigo: 'OP-2026-0587',
    linea: 'Moldeo 1',
    estado: 'en_proceso',
    fecha_inicio: AHORA,
    fecha_fin: null,
    creada_por: uuidv7(),
    created_at: AHORA,
    updated_at: AHORA,
    revocada: false,
  });
  if (conAsignacion) {
    await db.asignaciones.put({
      user_id: u,
      id: uuidv7(),
      order_id: ORDEN,
      supervisor_id: u,
      asignado_por: null,
      activo: true,
    });
  }
  await db.planeados.bulkPut([
    {
      user_id: u,
      id: uuidv7(),
      order_id: ORDEN,
      material_id: ARENA,
      cantidad_planeada: 100,
      unidad: 'kg',
    },
    {
      user_id: u,
      id: uuidv7(),
      order_id: ORDEN,
      material_id: RESINA,
      cantidad_planeada: 50,
      unidad: 'l',
    },
  ]);
  const material = (
    id: string,
    codigo: string,
    nombre: string,
    unidad: 'kg' | 'l',
    activo = true,
  ) => ({
    user_id: u,
    id,
    codigo,
    nombre,
    unidad,
    costo_unitario_cop: 1000,
    activo,
  });
  await db.materiales.bulkPut([
    material(ARENA, 'MP-001', 'Arena sílice', 'kg'),
    material(RESINA, 'MP-002', 'Resina furánica', 'l'),
    material(GRAFITO, 'MP-006', 'Grafito', 'kg'),
    material(BENTONITA, 'MP-007', 'Bentonita sódica', 'kg', false),
  ]);
  await db.settings.put({ user_id: u, clave: 'tolerancia_pct', valor: 5 });
}

/** Consumo propio "ya sincronizado": su creación se aplicó y el servidor lo tiene con `servidor`. */
async function sembrarConsumo(
  cambios: Partial<ConsumoLocal>,
  servidor: Parameters<typeof consumoServidor>[0] | null,
  lote = 'L-1',
): Promise<string> {
  const { id, mutation_id } = await registrarConsumoLocal(perfil.id, {
    order_id: ORDEN,
    material_id: ARENA,
    cantidad: 10,
    unidad: 'kg',
    lote,
  });
  await db.outbox.update(mutation_id, { estado: 'aplicada' });
  const fila = await db.consumos.get([perfil.id, id]);
  await db.consumos.update([perfil.id, id], {
    ...cambios,
    ...(servidor
      ? {
          servidor: consumoServidor({
            id,
            order_id: ORDEN,
            material_id: ARENA,
            registrado_por: perfil.id,
            client_created_at: fila?.client_created_at,
            lote,
            ...servidor,
          }),
          version: servidor.version ?? 1,
        }
      : {}),
  });
  return id;
}

const RUTA_REGISTRO = `/supervisor/ordenes/${ORDEN}/registrar`;

async function abrirRegistro(sincronizacion = sincronizacionFalsa()) {
  const resultado = renderizarApp(RUTA_REGISTRO, { sincronizacion });
  await screen.findByRole('heading', { level: 1, name: 'Registro de consumo · OP-2026-0587' });
  return resultado;
}

async function elegirMaterial(usuario: UserEvent, nombre: string) {
  const combo = screen.getByRole('combobox', { name: /Materia prima/ });
  await usuario.clear(combo);
  await usuario.type(combo, nombre.slice(0, 4));
  await usuario.click(screen.getByRole('option', { name: new RegExp(nombre) }));
}

const interruptor = () => screen.getByRole('switch', { name: '¿Hay una novedad en este consumo?' });

async function mutaciones(): Promise<MutacionOutbox[]> {
  return (await db.outbox.toArray()).sort((a, b) => a.seq_local - b.seq_local);
}

beforeEach(async () => {
  await reiniciarApp();
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:prueba'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: liberarUrl });
  perfil = await entrarSinConexion('supervisor', 'Juan Suárez');
  await sembrar();
});
afterEach(reiniciarApp);

describe('Mis órdenes en proceso', () => {
  it('lista las órdenes asignadas con su avance y accesos', async () => {
    await sembrarConsumo({}, null);
    renderizarApp('/supervisor');
    const lista = await screen.findByRole('list', { name: 'Órdenes en proceso' });
    const orden = within(lista).getByRole('region', { name: 'Orden OP-2026-0587' });
    expect(orden).toHaveTextContent('Línea Moldeo 1');
    // Arena 10/100 = 10 %, resina 0 % → promedio 5 %.
    expect(
      within(orden).getByRole('progressbar', { name: 'Avance de la orden OP-2026-0587' }),
    ).toHaveAttribute('aria-valuenow', '5');
    expect(
      within(orden).getByRole('link', { name: 'Registrar consumo en la orden OP-2026-0587' }),
    ).toHaveAttribute('href', RUTA_REGISTRO);
    expect(
      within(orden).getByRole('link', { name: 'Ver detalle de la orden OP-2026-0587' }),
    ).toHaveAttribute('href', `/supervisor/ordenes/${ORDEN}`);
  });

  it('sin órdenes asignadas muestra el estado vacío', async () => {
    await db.asignaciones.clear();
    renderizarApp('/supervisor');
    expect(
      await screen.findByRole('heading', { name: 'No tiene órdenes en proceso asignadas' }),
    ).toBeInTheDocument();
  });
});

describe('Detalle de orden', () => {
  it('muestra planeado vs consumido con barras accesibles y marca lo que supera la tolerancia', async () => {
    await sembrarConsumo({ cantidad: 110, base_local: null }, { cantidad: 110 });
    renderizarApp(`/supervisor/ordenes/${ORDEN}`);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Orden OP-2026-0587' }),
    ).toBeInTheDocument();
    // El subtítulo dinámico se fija en un efecto, después del primer render.
    await waitFor(() =>
      expect(screen.getByRole('banner')).toHaveTextContent('Orden OP-2026-0587 · Línea Moldeo 1'),
    );
    expect(screen.getByText(/El servidor confirma la tolerancia/)).toBeInTheDocument();

    const arena = screen.getByRole('progressbar', { name: 'Arena sílice' });
    expect(arena).toHaveAttribute('aria-valuenow', '100');
    expect(arena).toHaveAttribute(
      'aria-valuetext',
      '110 kg de 100 kg (110 %). Supera la tolerancia',
    );
    expect(screen.getByRole('progressbar', { name: 'Resina furánica' })).toHaveAttribute(
      'aria-valuetext',
      '0 l de 50 l (0 %)',
    );
    expect(
      screen.getByRole('link', { name: 'Registrar consumo en la orden OP-2026-0587' }),
    ).toHaveAttribute('href', RUTA_REGISTRO);
  });
});

describe('Registrar consumo', () => {
  it('registra sin novedad en Dexie, muestra la cantidad interpretada y limpia el formulario', async () => {
    const usuario = userEvent.setup();
    const { sincronizacion } = await abrirRegistro();

    await elegirMaterial(usuario, 'Arena sílice');
    const cantidad = screen.getByRole('textbox', { name: /Cantidad utilizada/ });
    await usuario.type(cantidad, '12,5');
    expect(cantidad).toHaveAccessibleDescription(/Se registrará: 12,5 kg/);
    await usuario.type(screen.getByRole('textbox', { name: /Lote/ }), 'L-4471');
    await usuario.click(
      screen.getByRole('button', { name: 'Guardar registro (se sincroniza al recuperar señal)' }),
    );

    expect(await screen.findByText('Registro guardado en esta tablet')).toBeInTheDocument();
    const [mutacion] = await mutaciones();
    expect(mutacion).toMatchObject({
      tipo: 'consumo.crear',
      user_id: perfil.id,
      estado: 'pendiente',
      payload: {
        order_id: ORDEN,
        material_id: ARENA,
        cantidad: 12.5,
        unidad: 'kg',
        lote: 'L-4471',
      },
    });
    expect(await db.consumos.count()).toBe(1);
    expect(sincronizacion.cambioLocal).toHaveBeenCalledTimes(1);

    // Formulario limpio y el foco de vuelta en el material.
    expect(cantidad).toHaveValue('');
    expect(screen.getByRole('combobox', { name: /Materia prima/ })).toHaveFocus();

    // Registros de hoy y trazabilidad, desde Dexie.
    const hoy = await screen.findByRole('list', { name: 'Registros de hoy — Orden OP-2026-0587' });
    expect(within(hoy).getByText('Arena sílice')).toBeInTheDocument();
    expect(within(hoy).getByText('Pendiente de sync')).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Trazabilidad de este dispositivo' })).getByText(
        /Juan S\. registró consumo/,
      ),
    ).toBeInTheDocument();
  });

  it('valida los campos con mensajes en español', async () => {
    const usuario = userEvent.setup();
    await abrirRegistro();
    const cantidad = screen.getByRole('textbox', { name: /Cantidad utilizada/ });
    await usuario.type(cantidad, '1,2345');
    await usuario.click(screen.getByRole('button', { name: /Guardar registro/ }));
    expect(await screen.findByText('Elija la materia prima.')).toBeInTheDocument();
    expect(cantidad).toHaveAccessibleDescription(/Escriba una cantidad válida/);
    expect(screen.getByText('El lote es obligatorio.')).toBeInTheDocument();
    expect(await db.outbox.count()).toBe(0);
  });

  it('limita la unidad a las convertibles con la del plan del material (S11)', async () => {
    const usuario = userEvent.setup();
    await abrirRegistro();
    const unidad = () => screen.getByRole('combobox', { name: /Unidad/ });
    const opciones = () =>
      within(unidad())
        .getAllByRole('option')
        .map((o) => o.textContent);

    await elegirMaterial(usuario, 'Arena sílice');
    expect(opciones()).toEqual(['kg', 'g']);

    await elegirMaterial(usuario, 'Resina furánica');
    expect(opciones()).toEqual(['l', 'ml']);
    expect(unidad()).toHaveValue('l');
  });

  it('activa y bloquea la novedad si supera el plan más la tolerancia (S7)', async () => {
    const usuario = userEvent.setup();
    await sembrarConsumo({}, null); // 10 kg ya registrados en esta tablet
    await abrirRegistro();
    await elegirMaterial(usuario, 'Arena sílice');
    const cantidad = screen.getByRole('textbox', { name: /Cantidad utilizada/ });

    // 10 + 95 = 105 kg: justo en el límite (plan 100 + 5 %), no obliga.
    await usuario.type(cantidad, '95');
    expect(interruptor()).toHaveAttribute('aria-checked', 'false');

    await usuario.clear(cantidad);
    await usuario.type(cantidad, '96');
    expect(interruptor()).toHaveAttribute('aria-checked', 'true');
    expect(interruptor()).toHaveAttribute('aria-disabled', 'true');
    expect(interruptor()).toHaveAccessibleDescription(
      'Con este registro la orden llevaría 106 kg de este material; lo planeado más la tolerancia (5 %) es 105 kg. La novedad es obligatoria.',
    );
    await usuario.click(interruptor());
    expect(interruptor()).toHaveAttribute('aria-checked', 'true');

    // Bajando la cantidad se libera.
    await usuario.clear(cantidad);
    await usuario.type(cantidad, '5');
    expect(interruptor()).toHaveAttribute('aria-checked', 'false');
    expect(interruptor()).not.toHaveAttribute('aria-disabled');

    // Sin justificar no se guarda.
    await usuario.clear(cantidad);
    await usuario.type(cantidad, '200');
    await usuario.type(screen.getByRole('textbox', { name: /Lote/ }), 'L-9');
    await usuario.click(screen.getByRole('button', { name: /Guardar registro/ }));
    expect(await screen.findByText('Elija el tipo de novedad.')).toBeInTheDocument();
    expect(await db.outbox.where('estado').equals('pendiente').count()).toBe(0);
  });

  it('un material fuera del plan también obliga la novedad (P10)', async () => {
    const usuario = userEvent.setup();
    await abrirRegistro();
    await elegirMaterial(usuario, 'Grafito');
    expect(interruptor()).toHaveAttribute('aria-checked', 'true');
    expect(interruptor()).toHaveAccessibleDescription(/no está en el plan/);
    // Los materiales inactivos no se ofrecen.
    await usuario.clear(screen.getByRole('combobox', { name: /Materia prima/ }));
    await usuario.type(screen.getByRole('combobox', { name: /Materia prima/ }), 'Bento');
    expect(screen.queryByRole('option', { name: /Bentonita/ })).not.toBeInTheDocument();
  });

  it('registra con novedad y foto: JPEG sin EXIF guardado en Dexie con su mutación', async () => {
    const usuario = userEvent.setup();
    await abrirRegistro();
    await elegirMaterial(usuario, 'Arena sílice');
    await usuario.type(screen.getByRole('textbox', { name: /Cantidad utilizada/ }), '20');
    await usuario.type(screen.getByRole('textbox', { name: /Lote/ }), 'L-4471');
    await usuario.click(interruptor());

    await usuario.selectOptions(
      screen.getByRole('combobox', { name: /Tipo de novedad/ }),
      'Reproceso',
    );
    await usuario.type(
      screen.getByRole('textbox', { name: /Justificación/ }),
      'Reproceso por sellado defectuoso',
    );
    const entrada = screen.getByLabelText(/Adjuntar evidencia/);
    expect(entrada).toHaveAttribute('accept', 'image/*');
    expect(entrada).toHaveAttribute('capture', 'environment');
    await usuario.upload(
      entrada,
      new File([new Uint8Array([1, 2, 3])], 'IMG_0001.jpg', { type: 'image/jpeg' }),
    );
    expect(await screen.findByText('1 foto adjunta')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Foto 1 de la evidencia' })).toHaveAttribute(
      'src',
      'blob:prueba',
    );

    await usuario.click(screen.getByRole('button', { name: /Guardar registro/ }));
    expect(await screen.findByText('Registro guardado en esta tablet')).toBeInTheDocument();

    const [crear, novedad] = await mutaciones();
    expect(crear?.tipo).toBe('consumo.crear');
    expect(novedad).toMatchObject({
      tipo: 'novedad.crear',
      payload: { tipo: 'reproceso', descripcion: 'Reproceso por sellado defectuoso' },
    });
    const [evidencia] = await db.evidencias.toArray();
    expect(evidencia).toMatchObject({ mime: 'image/jpeg', estado_subida: 'pendiente' });
    const bytes = new Uint8Array(evidencia?.datos ?? new ArrayBuffer(0));
    expect(bytes.length).toBeGreaterThan(0);
    expect(tieneExif(bytes)).toBe(false);
    expect(new TextDecoder('latin1').decode(bytes)).not.toMatch(/GPS/);
    if (novedad?.tipo === 'novedad.crear') {
      expect(novedad.payload.evidencias).toEqual([
        expect.objectContaining({
          id: evidencia?.id,
          mime: 'image/jpeg',
          tamano_bytes: bytes.length,
        }),
      ]);
    }
    expect(screen.queryByText('1 foto adjunta')).not.toBeInTheDocument();
  });

  it('permite quitar una foto adjunta antes de guardar', async () => {
    const usuario = userEvent.setup();
    await abrirRegistro();
    await usuario.click(interruptor());
    await usuario.upload(
      screen.getByLabelText(/Adjuntar evidencia/),
      new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' }),
    );
    await usuario.click(await screen.findByRole('button', { name: 'Quitar foto 1' }));
    expect(screen.getByText('Sin fotos adjuntas')).toBeInTheDocument();
    expect(liberarUrl).toHaveBeenCalledWith('blob:prueba');
  });
});

describe('Registros de hoy', () => {
  it('muestra un chip por estado', async () => {
    await sembrarConsumo({}, null, 'L-PEND');
    await db.outbox.where('estado').equals('aplicada').modify({ estado: 'pendiente' });
    await sembrarConsumo({ estado_local: 'sincronizado' }, { estado: 'pendiente' }, 'L-SINC');
    await sembrarConsumo({ estado_local: 'aprobado' }, { estado: 'aprobado' }, 'L-VAL');
    await sembrarConsumo(
      { estado_local: 'rechazado', motivo_rechazo: 'No coincide' },
      { estado: 'rechazado' },
      'L-RECH',
    );
    await sembrarConsumo(
      { estado_local: 'sincronizado', falta_novedad: true, requiere_novedad: true },
      { estado: 'pendiente', requiere_novedad: true },
      'L-NOV',
    );
    await sembrarConsumo(
      { estado_local: 'conflicto', error_sync: { code: 'CONFLICTO', message: 'x' } },
      { estado: 'pendiente', version: 2 },
      'L-CONF',
    );
    await abrirRegistro();
    const lista = await screen.findByRole('list', {
      name: 'Registros de hoy — Orden OP-2026-0587',
    });
    const fila = (lote: string) =>
      within(lista)
        .getAllByRole('listitem')
        .find((li) => li.textContent?.includes(`Lote ${lote}`)) as HTMLElement;

    expect(fila('L-PEND')).toHaveTextContent('Pendiente de sync');
    expect(fila('L-SINC')).toHaveTextContent('Sincronizado');
    expect(fila('L-VAL')).toHaveTextContent('Validado por jefe');
    expect(within(fila('L-VAL')).queryByRole('button')).not.toBeInTheDocument();
    expect(
      within(fila('L-RECH')).getByRole('button', { name: /Rechazado, ver el motivo/ }),
    ).toBeInTheDocument();
    expect(
      within(fila('L-NOV')).getByRole('button', { name: /Falta novedad, justificar la novedad/ }),
    ).toBeInTheDocument();
    expect(fila('L-CONF')).toHaveTextContent('Conflicto');
    expect(fila('L-CONF')).toHaveTextContent('Este registro cambió en el servidor');
  });

  it('rechazado → ver motivo → crear corrección con corrige_a (S3)', async () => {
    const usuario = userEvent.setup();
    const rechazado = await sembrarConsumo(
      { estado_local: 'rechazado', motivo_rechazo: 'No coincide con la báscula' },
      { estado: 'rechazado' },
      'L-RECH',
    );
    await abrirRegistro();

    await usuario.click(await screen.findByRole('button', { name: /Rechazado, ver el motivo/ }));
    const dialogo = screen.getByRole('dialog', { name: 'Arena sílice' });
    expect(dialogo).toHaveTextContent('Motivo del rechazo: No coincide con la báscula');
    expect(within(dialogo).queryByRole('button', { name: /Editar/ })).not.toBeInTheDocument();
    await usuario.click(within(dialogo).getByRole('button', { name: 'Crear corrección' }));

    expect(
      await screen.findByRole('region', { name: 'Corrección del consumo rechazado' }),
    ).toBeInTheDocument();
    const cantidad = screen.getByRole('textbox', { name: /Cantidad utilizada/ });
    expect(cantidad).toHaveValue('10');
    expect(screen.getByRole('textbox', { name: /Lote/ })).toHaveValue('L-RECH');
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /Materia prima/ })).toHaveFocus(),
    );
    await usuario.clear(cantidad);
    await usuario.type(cantidad, '8');
    await usuario.click(screen.getByRole('button', { name: /Guardar registro/ }));

    expect(await screen.findByText('Corrección guardada en esta tablet')).toBeInTheDocument();
    const nueva = (await mutaciones()).find((m) => m.estado === 'pendiente');
    expect(nueva).toMatchObject({
      tipo: 'consumo.crear',
      payload: { cantidad: 8, corrige_a: rechazado, lote: 'L-RECH' },
    });
    // Vuelve al registro nuevo.
    expect(
      await screen.findByRole('region', { name: 'Nuevo registro de material' }),
    ).toBeInTheDocument();
  });

  it('falta novedad → justificar: guarda la novedad del consumo', async () => {
    const usuario = userEvent.setup();
    const consumo = await sembrarConsumo(
      { estado_local: 'sincronizado', falta_novedad: true, requiere_novedad: true },
      { estado: 'pendiente', requiere_novedad: true },
      'L-NOV',
    );
    const { sincronizacion } = await abrirRegistro();

    await usuario.click(
      await screen.findByRole('button', { name: /Falta novedad, justificar la novedad/ }),
    );
    await usuario.click(
      within(screen.getByRole('dialog', { name: 'Arena sílice' })).getByRole('button', {
        name: 'Justificar novedad',
      }),
    );
    const dialogo = screen.getByRole('dialog', { name: 'Justificar novedad' });
    await usuario.click(within(dialogo).getByRole('button', { name: 'Guardar novedad' }));
    expect(within(dialogo).getByText('Elija el tipo de novedad.')).toBeInTheDocument();

    await usuario.selectOptions(within(dialogo).getByRole('combobox', { name: /Tipo/ }), 'Merma');
    await usuario.type(
      within(dialogo).getByRole('textbox', { name: /Justificación/ }),
      'Merma en el horno',
    );
    await usuario.click(within(dialogo).getByRole('button', { name: 'Guardar novedad' }));

    expect(await screen.findByText('Novedad guardada en esta tablet')).toBeInTheDocument();
    expect(await db.novedades.toArray()).toEqual([
      expect.objectContaining({
        consumption_id: consumo,
        tipo: 'merma',
        descripcion: 'Merma en el horno',
      }),
    ]);
    expect(sincronizacion.cambioLocal).toHaveBeenCalled();
    // Ya no falta la novedad.
    await waitFor(() => expect(screen.queryByText('Falta novedad')).not.toBeInTheDocument());
  });

  it('edita un pendiente propio con la versión esperada (S4)', async () => {
    const usuario = userEvent.setup();
    const consumo = await sembrarConsumo(
      { estado_local: 'sincronizado' },
      { estado: 'pendiente', version: 3 },
      'L-SINC',
    );
    await abrirRegistro();

    await usuario.click(await screen.findByRole('button', { name: /Sincronizado, ver opciones/ }));
    await usuario.click(screen.getByRole('button', { name: 'Editar registro' }));
    expect(
      await screen.findByRole('region', { name: 'Editar registro pendiente' }),
    ).toBeInTheDocument();
    const cantidad = screen.getByRole('textbox', { name: /Cantidad utilizada/ });
    await usuario.clear(cantidad);
    await usuario.type(cantidad, '12');
    await usuario.click(
      screen.getByRole('button', { name: 'Guardar cambios (se sincroniza al recuperar señal)' }),
    );

    expect(await screen.findByText('Cambios guardados en esta tablet')).toBeInTheDocument();
    const edicion = (await mutaciones()).find((m) => m.tipo === 'consumo.editar');
    expect(edicion).toMatchObject({ payload: { id: consumo, cantidad: 12, version: 3 } });
    expect(edicion?.payload).not.toHaveProperty('lote');
  });

  it('perdido en el servidor → chip accionable → enviar de nuevo (ADR 0016)', async () => {
    const usuario = userEvent.setup();
    const perdido = await sembrarConsumo(
      { estado_local: 'sincronizado', perdido_en_restauracion: true },
      { estado: 'pendiente' },
      'L-PERD',
    );
    const { sincronizacion } = await abrirRegistro();

    await usuario.click(
      await screen.findByRole('button', {
        name: /Perdido en el servidor, enviarlo de nuevo de Arena sílice/,
      }),
    );
    const dialogo = screen.getByRole('dialog', { name: 'Arena sílice' });
    expect(dialogo).toHaveTextContent('ya no tiene este registro');
    expect(within(dialogo).queryByRole('button', { name: /Editar/ })).not.toBeInTheDocument();
    await usuario.click(within(dialogo).getByRole('button', { name: 'Enviar de nuevo' }));

    expect(await screen.findByText('Registro puesto en cola para enviar')).toBeInTheDocument();
    expect(sincronizacion.cambioLocal).toHaveBeenCalledTimes(1);
    const enCola = (await mutaciones()).filter((m) => m.estado === 'pendiente');
    expect(enCola).toEqual([
      expect.objectContaining({ tipo: 'consumo.crear', entidad_id: perdido }),
    ]);
    await waitFor(() =>
      expect(screen.queryByText('Perdido en el servidor')).not.toBeInTheDocument(),
    );
  });

  it('un consumo validado no ofrece editar ni corregir; la URL tampoco lo permite', async () => {
    const validado = await sembrarConsumo(
      { estado_local: 'aprobado' },
      { estado: 'aprobado' },
      'L-VAL',
    );
    renderizarApp(`${RUTA_REGISTRO}?editar=${validado}`);
    expect(await screen.findByText('Esa acción ya no está disponible')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Nuevo registro de material' })).toBeInTheDocument();
  });
});

describe('accesibilidad básica', () => {
  it('formulario con etiquetas, encabezados y botón principal grande', async () => {
    await abrirRegistro();
    expect(screen.getByRole('region', { name: 'Nuevo registro de material' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Materia prima/ })).toBeRequired();
    expect(screen.getByRole('textbox', { name: /Cantidad utilizada/ })).toHaveAttribute(
      'inputmode',
      'decimal',
    );
    expect(
      screen.getByRole('region', { name: 'Trazabilidad — este dispositivo' }),
    ).toBeInTheDocument();
    const guardar = screen.getByRole('button', { name: /Guardar registro/ });
    expect(guardar).toHaveClass('min-h-14');
    expect(guardar).toHaveAttribute('form', 'formulario-consumo-nuevo');
  });
});
