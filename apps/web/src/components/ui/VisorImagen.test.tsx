import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Boton } from './Boton';
import { VisorImagen } from './VisorImagen';

function Escenario() {
  const [abierto, setAbierto] = useState(false);
  return (
    <>
      <Boton variante="fantasma" onClick={() => setAbierto(true)}>
        evidencia_sellado_4471.jpg
      </Boton>
      <VisorImagen
        abierto={abierto}
        src="blob:http://localhost/2f1c0b8e-evidencia"
        alt="Sellado defectuoso del lote 4471"
        titulo="evidencia_sellado_4471.jpg"
        alCerrar={() => setAbierto(false)}
      />
    </>
  );
}

describe('VisorImagen', () => {
  it('abre un diálogo con la imagen blob:, foco en "Cerrar" y título visible', async () => {
    const usuario = userEvent.setup();
    render(<Escenario />);
    await usuario.click(screen.getByRole('button', { name: 'evidencia_sellado_4471.jpg' }));

    const dialogo = screen.getByRole('dialog', { name: 'evidencia_sellado_4471.jpg' });
    expect(dialogo).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('img', { name: 'Sellado defectuoso del lote 4471' })).toHaveAttribute(
      'src',
      'blob:http://localhost/2f1c0b8e-evidencia',
    );
    const cerrar = screen.getByRole('button', { name: 'Cerrar' });
    expect(cerrar).toHaveFocus();
    expect(cerrar).toHaveClass('min-h-14');
  });

  it('"Ampliar" es un botón de alternar que cambia el tamaño de la imagen', async () => {
    const usuario = userEvent.setup();
    render(<Escenario />);
    await usuario.click(screen.getByRole('button', { name: 'evidencia_sellado_4471.jpg' }));

    const ampliar = screen.getByRole('button', { name: 'Ampliar' });
    const imagen = screen.getByRole('img');
    expect(ampliar).toHaveAttribute('aria-pressed', 'false');
    expect(imagen).toHaveClass('object-contain');
    await usuario.click(ampliar);
    expect(ampliar).toHaveAttribute('aria-pressed', 'true');
    expect(imagen).toHaveClass('w-[200%]');
  });

  it('se cierra con el botón y con Escape, y devuelve el foco', async () => {
    const usuario = userEvent.setup();
    render(<Escenario />);
    const disparador = screen.getByRole('button', { name: 'evidencia_sellado_4471.jpg' });

    await usuario.click(disparador);
    await usuario.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(disparador).toHaveFocus();

    await usuario.keyboard('{Enter}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await usuario.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(disparador).toHaveFocus();
  });
});
