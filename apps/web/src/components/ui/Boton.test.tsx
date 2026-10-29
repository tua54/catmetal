import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Boton } from './Boton';

describe('Boton', () => {
  it('es un botón con nombre accesible, type="button" por defecto y ejecuta onClick', async () => {
    const usuario = userEvent.setup();
    const alHacerClic = vi.fn();
    render(<Boton onClick={alHacerClic}>Guardar registro</Boton>);

    const boton = screen.getByRole('button', { name: 'Guardar registro' });
    expect(boton).toHaveAttribute('type', 'button');
    await usuario.click(boton);
    expect(alHacerClic).toHaveBeenCalledTimes(1);
  });

  it('aplica la variante y el tamaño grande (objetivo táctil de 56 px)', () => {
    render(
      <Boton variante="exito" tamano="grande" anchoCompleto>
        Validar gasto
      </Boton>,
    );
    const boton = screen.getByRole('button', { name: 'Validar gasto' });
    expect(boton).toHaveClass('bg-success-700', 'min-h-14', 'w-full');
  });

  it('usa contorno rojo en la variante peligro y relleno en peligroRelleno', () => {
    render(
      <>
        <Boton variante="peligro">Rechazar</Boton>
        <Boton variante="peligroRelleno">Confirmar rechazo</Boton>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Rechazar' })).toHaveClass(
      'border-danger-700',
      'bg-white',
    );
    expect(screen.getByRole('button', { name: 'Confirmar rechazo' })).toHaveClass('bg-danger-700');
  });

  it('en estado cargando marca aria-busy, anuncia el texto e ignora los clics', async () => {
    const usuario = userEvent.setup();
    const alHacerClic = vi.fn();
    render(
      <Boton cargando textoCargando="Guardando" onClick={alHacerClic}>
        Guardar
      </Boton>,
    );

    const boton = screen.getByRole('button', { name: /Guardar/ });
    expect(boton).toHaveAttribute('aria-busy', 'true');
    expect(boton).toHaveAttribute('aria-disabled', 'true');
    expect(boton).toHaveTextContent('Guardando');
    await usuario.click(boton);
    expect(alHacerClic).not.toHaveBeenCalled();
  });

  it('con motivoDeshabilitado sigue enfocable, explica el motivo y no ejecuta la acción', async () => {
    const usuario = userEvent.setup();
    const alHacerClic = vi.fn();
    render(
      <Boton motivoDeshabilitado="Falta la novedad del supervisor." onClick={alHacerClic}>
        Validar gasto
      </Boton>,
    );

    const boton = screen.getByRole('button', { name: 'Validar gasto' });
    expect(boton).not.toBeDisabled();
    expect(boton).toHaveAttribute('aria-disabled', 'true');
    expect(boton).toHaveAccessibleDescription('Falta la novedad del supervisor.');

    await usuario.tab();
    expect(boton).toHaveFocus();
    await usuario.keyboard('{Enter}');
    await usuario.click(boton);
    expect(alHacerClic).not.toHaveBeenCalled();
  });

  it('con disabled nativo queda deshabilitado', () => {
    render(<Boton disabled>Deshabilitado</Boton>);
    expect(screen.getByRole('button', { name: 'Deshabilitado' })).toBeDisabled();
  });
});
