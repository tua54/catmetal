// F6-09: el `inert` del fondo es una pila. Cerrar un diálogo mientras la pantalla de bloqueo está
// visible no devuelve la app a la vida bajo la capa opaca.

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CapaModal } from './CapaModal';

function Escenario({ dialogo = false, bloqueo = false }: { dialogo?: boolean; bloqueo?: boolean }) {
  return (
    <>
      <h1>Contenido de la app</h1>
      <button type="button">Abrir diálogo</button>
      <CapaModal abierto={dialogo} alCerrar={() => undefined} idTitulo="t-dialogo">
        <h2 id="t-dialogo">Diálogo</h2>
        <button type="button">Aceptar</button>
      </CapaModal>
      <CapaModal abierto={bloqueo} alCerrar={() => undefined} idTitulo="t-bloqueo">
        <h2 id="t-bloqueo">Bloqueo</h2>
        <input aria-label="Contraseña" />
      </CapaModal>
    </>
  );
}

function capa(nombre: string): HTMLElement {
  const panel = screen.getByRole('dialog', { name: nombre });
  return panel.parentElement!;
}

afterEach(() => {
  document.body.classList.remove('overflow-hidden');
});

describe('CapaModal: inert del fondo como pila (F6-09)', () => {
  it('abrir un diálogo, bloquear y cerrar el diálogo: el fondo sigue inerte hasta desbloquear', () => {
    const { container, rerender } = render(<Escenario />);
    screen.getByRole('button', { name: 'Abrir diálogo' }).focus();

    rerender(<Escenario dialogo />);
    expect(container).toHaveAttribute('inert');

    rerender(<Escenario dialogo bloqueo />);
    const campo = screen.getByRole('textbox', { name: 'Contraseña' });
    expect(campo).toHaveFocus();
    expect(capa('Diálogo')).toHaveAttribute('inert');
    expect(capa('Bloqueo')).not.toHaveAttribute('inert');

    // El diálogo se cierra solo (p. ej. terminó una petición) con el bloqueo visible.
    rerender(<Escenario bloqueo />);
    expect(container).toHaveAttribute('inert');
    expect(document.body).toHaveClass('overflow-hidden');
    // El foco no vuelve al disparador inerte: se queda en la capa de bloqueo.
    expect(campo).toHaveFocus();

    rerender(<Escenario />);
    expect(container).not.toHaveAttribute('inert');
    expect(document.body).not.toHaveClass('overflow-hidden');
  });

  it('desbloquear con el diálogo abierto deja inerte solo lo que el diálogo retiene', () => {
    const { container, rerender } = render(<Escenario dialogo />);
    rerender(<Escenario dialogo bloqueo />);

    rerender(<Escenario dialogo />);
    expect(container).toHaveAttribute('inert');
    expect(capa('Diálogo')).not.toHaveAttribute('inert');
    expect(document.body).toHaveClass('overflow-hidden');

    rerender(<Escenario />);
    expect(container).not.toHaveAttribute('inert');
    expect(document.body).not.toHaveClass('overflow-hidden');
  });

  it('no quita un inert ni un bloqueo de scroll que no puso', () => {
    const ajeno = document.createElement('div');
    ajeno.setAttribute('inert', '');
    document.body.appendChild(ajeno);
    document.body.classList.add('overflow-hidden');
    try {
      const { rerender } = render(<Escenario />);
      rerender(<Escenario dialogo />);
      rerender(<Escenario />);
      expect(ajeno).toHaveAttribute('inert');
      expect(document.body).toHaveClass('overflow-hidden');
    } finally {
      ajeno.remove();
    }
  });
});
