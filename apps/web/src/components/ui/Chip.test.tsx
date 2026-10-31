import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Chip, type EstadoChip } from './Chip';
import { PildoraConexion } from './PildoraConexion';

describe('Chip', () => {
  it.each<[EstadoChip, string, string]>([
    ['pendiente_sync', 'Pendiente de sync', 'bg-warning-100'],
    ['sincronizado', 'Sincronizado', 'bg-success-100'],
    ['validado', 'Validado por jefe', 'bg-success-100'],
    ['rechazado', 'Rechazado', 'bg-danger-100'],
    ['falta_novedad', 'Falta novedad', 'bg-warning-100'],
    ['con_novedad', 'Con novedad', 'bg-warning-100'],
  ])('%s muestra texto e ícono además del color', (estado, texto, fondo) => {
    const { container } = render(<Chip estado={estado} />);
    const chip = screen.getByText(texto).parentElement;
    expect(chip).toHaveClass(fondo);
    expect(container.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });

  it('cuenta los pendientes en singular y plural', () => {
    const { rerender } = render(<Chip estado="pendientes" cantidad={3} />);
    expect(screen.getByText('3 pendientes')).toBeInTheDocument();
    rerender(<Chip estado="pendientes" cantidad={1} />);
    expect(screen.getByText('1 pendiente')).toBeInTheDocument();
  });

  it('accionable: es un botón de 44 px cuyo nombre empieza por el texto visible', async () => {
    const usuario = userEvent.setup();
    const alPresionar = vi.fn();
    render(<Chip estado="rechazado" alPresionar={alPresionar} textoAccion="ver motivo" />);

    const boton = screen.getByRole('button', { name: /^Rechazado\s*, ver motivo$/ });
    expect(boton).toHaveClass('min-h-11');
    await usuario.click(boton);
    expect(alPresionar).toHaveBeenCalledTimes(1);
  });

  it('no accionable: no es un control', () => {
    render(<Chip estado="sincronizado" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('PildoraConexion', () => {
  it('sin conexión: región status con el número por sincronizar y punto ámbar', () => {
    const { container } = render(<PildoraConexion estado="sin_conexion" pendientes={3} />);
    const estado = screen.getByRole('status');
    expect(estado).toHaveAttribute('aria-live', 'polite');
    expect(estado).toHaveTextContent('Sin conexión · , 3 por sincronizar');
    expect(container.querySelector('.bg-warning-500')).not.toBeNull();
  });

  it('en línea sin pendientes: "Todo sincronizado" con punto verde', () => {
    const { container } = render(<PildoraConexion estado="en_linea" pendientes={0} />);
    expect(screen.getByRole('status')).toHaveTextContent('En línea · , Todo sincronizado');
    expect(container.querySelector('.bg-success-400')).not.toBeNull();
  });

  it('sincronizando: giro que respeta prefers-reduced-motion', () => {
    const { container } = render(<PildoraConexion estado="sincronizando" pendientes={0} />);
    expect(screen.getByRole('status')).toHaveTextContent('Sincronizando…');
    expect(container.querySelector('svg')).toHaveClass('motion-safe:animate-spin');
  });

  it('sin conexión y sin pendientes dice "Nada pendiente"', () => {
    render(<PildoraConexion estado="sin_conexion" pendientes={0} />);
    expect(screen.getByRole('status')).toHaveTextContent('Nada pendiente');
  });

  it('accionable: botón que abre el estado de sincronización', async () => {
    const usuario = userEvent.setup();
    const alPresionar = vi.fn();
    render(<PildoraConexion estado="en_linea" pendientes={2} alPresionar={alPresionar} />);
    await usuario.click(
      screen.getByRole('button', {
        name: 'En línea, 2 por sincronizar. Ver estado de sincronización',
      }),
    );
    expect(alPresionar).toHaveBeenCalledTimes(1);
  });
});
