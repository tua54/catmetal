import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { Avatar } from './Avatar';
import { BarraSuperior } from './BarraSuperior';
import { BloqueNovedad } from './BloqueNovedad';
import { Chip } from './Chip';
import { cx, iniciales, normalizarBusqueda, unirIds } from './clases';
import { EstadoVacio } from './EstadoVacio';
import { LineaTiempo, type EventoLinea } from './LineaTiempo';
import { FilaRegistro, ListaRegistros } from './ListaRegistros';
import { PildoraConexion } from './PildoraConexion';
import { Tarjeta } from './Tarjeta';

describe('ListaRegistros / FilaRegistro', () => {
  it('muestra material, cantidad con coma decimal, hora de Bogotá, novedad y chip', () => {
    render(
      <ListaRegistros etiqueta="Registros de hoy">
        <FilaRegistro
          material="Arena sílice"
          cantidad={125.5}
          unidad="kg"
          fechaHora="2026-10-29T15:24:00Z"
          conNovedad
          estado={<Chip estado="pendiente_sync" />}
        />
      </ListaRegistros>,
    );

    const lista = screen.getByRole('list', { name: 'Registros de hoy' });
    const fila = within(lista).getByRole('listitem');
    expect(fila).toHaveTextContent('Arena sílice');
    expect(fila).toHaveTextContent('125,5 kg');
    expect(within(fila).getByText('10:24 a. m.')).toHaveAttribute(
      'datetime',
      '2026-10-29T15:24:00Z',
    );
    expect(fila).toHaveTextContent('con novedad');
    expect(fila).toHaveTextContent('Pendiente de sync');
    expect(within(fila).queryByRole('button')).not.toBeInTheDocument();
  });

  it('fila accionable: toda la fila es un botón (≥ 56 px)', async () => {
    const usuario = userEvent.setup();
    const alPresionar = vi.fn();
    render(
      <ListaRegistros etiqueta="Registros">
        <FilaRegistro
          material="Chatarra de acero"
          cantidad={1250}
          unidad="kg"
          fechaHora="2026-10-29T13:52:00Z"
          estado={<Chip estado="rechazado" />}
          alPresionar={alPresionar}
        />
      </ListaRegistros>,
    );
    const boton = screen.getByRole('button', { name: /Chatarra de acero.*1\.250 kg.*Rechazado/ });
    expect(boton).toHaveClass('min-h-14');
    await usuario.click(boton);
    expect(alPresionar).toHaveBeenCalledTimes(1);
  });
});

describe('LineaTiempo', () => {
  const eventos: EventoLinea[] = [
    {
      id: '1',
      fechaHora: '2026-10-29T15:24:00Z',
      actor: 'Juan S.',
      rol: 'supervisor',
      descripcion: 'Registró 125,5 kg + novedad.',
      tipo: 'novedad',
    },
    {
      id: '2',
      fechaHora: '2026-10-29T14:48:00Z',
      actor: 'Roberto M.',
      rol: 'jefe',
      descripcion: 'Rechazó el consumo.',
      tipo: 'rechazo',
    },
  ];

  it('variante completa: lista ordenada con hora, actor, rol, descripción y tipo en texto', () => {
    render(<LineaTiempo etiqueta="Trazabilidad completa de la orden" eventos={eventos} />);
    const lista = screen.getByRole('list', { name: 'Trazabilidad completa de la orden' });
    expect(lista.tagName).toBe('OL');
    const [primero, segundo] = within(lista).getAllByRole('listitem');
    expect(primero).toHaveTextContent('Registro con novedad: 10:24 a. m. — Juan S. (supervisor)');
    expect(primero).toHaveTextContent('Registró 125,5 kg + novedad.');
    expect(primero?.querySelector('.bg-warning-700')).not.toBeNull();
    expect(segundo).toHaveTextContent('Rechazo:');
    expect(segundo?.querySelector('.bg-danger-700')).not.toBeNull();
  });

  it('variante compacta: una línea con hora, actor y descripción', () => {
    render(<LineaTiempo etiqueta="Este dispositivo" eventos={eventos} variante="compacta" />);
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent(
      '10:24 a. m. · Juan S. Registró 125,5 kg + novedad.',
    );
  });
});

describe('Tarjeta, BloqueNovedad y EstadoVacio', () => {
  it('Tarjeta con título es una región con encabezado, acento, acciones y pie', () => {
    const { container } = render(
      <Tarjeta
        titulo="Por validar"
        acento
        resaltada
        acciones={<Chip estado="pendientes" cantidad={3} />}
        pie={<button type="button">Guardar</button>}
      >
        Contenido
      </Tarjeta>,
    );
    const region = screen.getByRole('region', { name: 'Por validar' });
    expect(region).toHaveClass('border-brand-600');
    expect(within(region).getByRole('heading', { level: 2, name: 'Por validar' })).toBeVisible();
    expect(region).toHaveTextContent('3 pendientes');
    expect(container.querySelector('.bg-brand-600')).not.toBeNull();
    expect(within(region).getByRole('button', { name: 'Guardar' })).toBeInTheDocument();
  });

  it('Tarjeta sin título no crea una región', () => {
    render(<Tarjeta>Solo contenido</Tarjeta>);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('BloqueNovedad muestra el título y el contenido con fondo ámbar', () => {
    const { container } = render(
      <BloqueNovedad titulo="Justificación del supervisor:">
        <p>Reproceso por sellado defectuoso.</p>
      </BloqueNovedad>,
    );
    expect(screen.getByText('Justificación del supervisor:')).toBeInTheDocument();
    expect(screen.getByText('Reproceso por sellado defectuoso.')).toBeInTheDocument();
    expect(container.firstChild).toHaveClass('bg-warning-100');
  });

  it('EstadoVacio muestra título, texto y acción', () => {
    render(
      <EstadoVacio
        titulo="No hay consumos por validar"
        texto="Aparecerán aquí."
        accion={<button type="button">Ver órdenes</button>}
      />,
    );
    expect(
      screen.getByRole('heading', { level: 3, name: 'No hay consumos por validar' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Aparecerán aquí.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ver órdenes' })).toBeInTheDocument();
  });
});

describe('BarraSuperior y Avatar', () => {
  it('muestra logo, título, subtítulo truncable, píldora y avatar', () => {
    render(
      <MemoryRouter>
        <BarraSuperior
          titulo="Registro de Consumo"
          subtitulo="Orden OP-2026-0587 · Línea Moldeo 1"
          conexion={<PildoraConexion estado="sin_conexion" pendientes={3} />}
          usuario={<Avatar nombre="Juan Suárez" rol="supervisor" />}
        />
      </MemoryRouter>,
    );
    const barra = screen.getByRole('banner');
    expect(barra).toHaveClass('bg-ink-950', 'border-brand-600');
    expect(within(barra).getByRole('img', { name: 'Catmetal' })).toBeInTheDocument();
    expect(within(barra).getByRole('link', { name: 'Catmetal · Inicio' })).toHaveAttribute(
      'href',
      '/',
    );
    expect(within(barra).getByText('Registro de Consumo')).toHaveAttribute(
      'title',
      'Registro de Consumo',
    );
    expect(within(barra).getByText('Orden OP-2026-0587 · Línea Moldeo 1')).toHaveClass('truncate');
    expect(within(barra).getByRole('status')).toHaveTextContent('3 por sincronizar');
    expect(
      within(barra).getByRole('img', { name: 'Usuario: Juan Suárez, supervisor' }),
    ).toHaveTextContent('JS');
  });

  it('Avatar accionable es un botón con nombre de la cuenta', async () => {
    const usuario = userEvent.setup();
    const alPresionar = vi.fn();
    render(<Avatar nombre="Roberto Martínez" alPresionar={alPresionar} />);
    const boton = screen.getByRole('button', { name: 'Cuenta de Roberto Martínez' });
    expect(boton).toHaveTextContent('RM');
    await usuario.click(boton);
    expect(alPresionar).toHaveBeenCalledTimes(1);
  });
});

describe('utilidades de clases', () => {
  it('cx, unirIds, normalizarBusqueda e iniciales', () => {
    expect(cx('a', false, null, undefined, 'b')).toBe('a b');
    expect(unirIds('x', '', 0, false, 'y')).toBe('x y');
    expect(unirIds(undefined)).toBeUndefined();
    expect(normalizarBusqueda('  Resina FURÁNICA ')).toBe('resina furanica');
    expect(iniciales('Juan Suárez')).toBe('JS');
    expect(iniciales('roberto')).toBe('R');
    expect(iniciales('Ana María Gómez Ruiz')).toBe('AR');
    expect(iniciales('   ')).toBe('');
  });
});
