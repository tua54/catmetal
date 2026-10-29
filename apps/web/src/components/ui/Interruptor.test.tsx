import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Interruptor } from './Interruptor';

function Controlado() {
  const [activado, setActivado] = useState(false);
  return (
    <Interruptor
      etiqueta="¿Hay una novedad en este consumo?"
      activado={activado}
      alCambiar={setActivado}
      ayuda="Actívelo si hubo reproceso, merma o daño."
    />
  );
}

describe('Interruptor', () => {
  it('es un switch con nombre visible y ayuda', () => {
    render(<Controlado />);
    const interruptor = screen.getByRole('switch', { name: '¿Hay una novedad en este consumo?' });
    expect(interruptor).toHaveAttribute('aria-checked', 'false');
    expect(interruptor).toHaveAccessibleDescription('Actívelo si hubo reproceso, merma o daño.');
  });

  it('cambia con Espacio, con Enter y al tocar la etiqueta', async () => {
    const usuario = userEvent.setup();
    render(<Controlado />);
    const interruptor = screen.getByRole('switch');

    await usuario.tab();
    expect(interruptor).toHaveFocus();
    await usuario.keyboard(' ');
    expect(interruptor).toHaveAttribute('aria-checked', 'true');
    await usuario.keyboard('{Enter}');
    expect(interruptor).toHaveAttribute('aria-checked', 'false');
    await usuario.click(screen.getByText('¿Hay una novedad en este consumo?'));
    expect(interruptor).toHaveAttribute('aria-checked', 'true');
  });

  it('bloqueado: no cambia, sigue enfocable y explica el motivo', async () => {
    const usuario = userEvent.setup();
    const alCambiar = vi.fn();
    render(
      <Interruptor
        etiqueta="Novedad obligatoria"
        activado
        alCambiar={alCambiar}
        bloqueado
        motivoBloqueo="El consumo supera la tolerancia."
      />,
    );
    const interruptor = screen.getByRole('switch', { name: 'Novedad obligatoria' });
    expect(interruptor).toHaveAttribute('aria-disabled', 'true');
    expect(interruptor).toHaveAttribute('aria-checked', 'true');
    expect(interruptor).toHaveAccessibleDescription('El consumo supera la tolerancia.');

    await usuario.tab();
    expect(interruptor).toHaveFocus();
    await usuario.keyboard(' ');
    await usuario.click(interruptor);
    expect(alCambiar).not.toHaveBeenCalled();
    expect(interruptor).toHaveAttribute('aria-checked', 'true');
  });

  it('deshabilitado: no es operable', () => {
    render(
      <Interruptor etiqueta="Filtro" activado={false} alCambiar={() => undefined} deshabilitado />,
    );
    expect(screen.getByRole('switch', { name: 'Filtro' })).toBeDisabled();
  });
});
