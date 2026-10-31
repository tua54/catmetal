import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SelectBuscable, type OpcionBuscable } from './SelectBuscable';

const MATERIALES: OpcionBuscable[] = [
  { valor: 'mp-001', etiqueta: 'Arena sílice', secundario: 'MP-001' },
  { valor: 'mp-002', etiqueta: 'Resina furánica', secundario: 'MP-002' },
  { valor: 'mp-003', etiqueta: 'Bentonita sódica', secundario: 'MP-003', deshabilitada: true },
  { valor: 'mp-004', etiqueta: 'Chatarra de acero', secundario: 'MP-004' },
];

function Envoltura({
  inicial = null,
  alCambiar,
}: {
  inicial?: string | null;
  alCambiar?: (valor: string) => void;
}) {
  const [valor, setValor] = useState<string | null>(inicial);
  return (
    <form>
      <SelectBuscable
        etiqueta="Materia prima"
        opciones={MATERIALES}
        valor={valor}
        alCambiar={(nuevo) => {
          setValor(nuevo);
          alCambiar?.(nuevo);
        }}
        ayuda="Busque por nombre o código."
        name="material"
      />
    </form>
  );
}

describe('SelectBuscable', () => {
  it('expone el patrón combobox con etiqueta, ayuda y lista cerrada', () => {
    render(<Envoltura />);

    const combo = screen.getByRole('combobox', { name: 'Materia prima' });
    expect(combo).toHaveAttribute('aria-expanded', 'false');
    expect(combo).toHaveAttribute('aria-autocomplete', 'list');
    expect(combo).toHaveAccessibleDescription('Busque por nombre o código.');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('teclado: ↓ abre, las flechas recorren saltando deshabilitadas y Enter elige', async () => {
    const usuario = userEvent.setup();
    const alCambiar = vi.fn();
    render(<Envoltura alCambiar={alCambiar} />);

    const combo = screen.getByRole('combobox', { name: 'Materia prima' });
    await usuario.tab();
    expect(combo).toHaveFocus();
    await usuario.keyboard('{ArrowDown}');

    expect(combo).toHaveAttribute('aria-expanded', 'true');
    const lista = screen.getByRole('listbox', { name: 'Materia prima' });
    expect(lista).toBeVisible();
    const opciones = screen.getAllByRole('option');
    expect(opciones).toHaveLength(4);
    expect(combo).toHaveAttribute('aria-activedescendant', opciones[0]?.id);

    await usuario.keyboard('{ArrowDown}{ArrowDown}');
    // Salta "Bentonita sódica" (deshabilitada) y llega a "Chatarra de acero".
    expect(combo).toHaveAttribute('aria-activedescendant', opciones[3]?.id);
    await usuario.keyboard('{ArrowUp}');
    expect(combo).toHaveAttribute('aria-activedescendant', opciones[1]?.id);

    await usuario.keyboard('{Enter}');
    expect(alCambiar).toHaveBeenCalledWith('mp-002');
    expect(combo).toHaveValue('Resina furánica — MP-002');
    expect(combo).toHaveAttribute('aria-expanded', 'false');
    expect(combo).toHaveFocus();
  });

  it('↑ con la lista cerrada abre en la última opción y da la vuelta', async () => {
    const usuario = userEvent.setup();
    render(<Envoltura />);
    const combo = screen.getByRole('combobox', { name: 'Materia prima' });
    combo.focus();

    await usuario.keyboard('{ArrowUp}');
    const opciones = screen.getAllByRole('option');
    expect(combo).toHaveAttribute('aria-activedescendant', opciones[3]?.id);
    await usuario.keyboard('{ArrowDown}');
    expect(combo).toHaveAttribute('aria-activedescendant', opciones[0]?.id);
  });

  it('filtra sin distinguir tildes ni mayúsculas, también por el código secundario', async () => {
    const usuario = userEvent.setup();
    render(<Envoltura />);
    const combo = screen.getByRole('combobox', { name: 'Materia prima' });

    await usuario.type(combo, 'FURANICA');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: /Resina furánica/ })).toBeInTheDocument();

    await usuario.clear(combo);
    await usuario.type(combo, 'mp-004');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    // La primera coincidencia queda activa: Enter la elige.
    await usuario.keyboard('{Enter}');
    expect(combo).toHaveValue('Chatarra de acero — MP-004');
  });

  it('anuncia cuando no hay coincidencias', async () => {
    const usuario = userEvent.setup();
    render(<Envoltura />);
    const combo = screen.getByRole('combobox', { name: 'Materia prima' });

    await usuario.type(combo, 'aluminio');
    expect(combo).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('status')).toHaveTextContent('No hay coincidencias.');
  });

  it('Escape cierra la lista y restaura el texto de la opción elegida', async () => {
    const usuario = userEvent.setup();
    render(<Envoltura inicial="mp-001" />);
    const combo = screen.getByRole('combobox', { name: 'Materia prima' });
    expect(combo).toHaveValue('Arena sílice — MP-001');

    await usuario.click(combo);
    await usuario.keyboard('resi');
    expect(combo).toHaveAttribute('aria-expanded', 'true');
    await usuario.keyboard('{Escape}');
    expect(combo).toHaveAttribute('aria-expanded', 'false');
    expect(combo).toHaveValue('Arena sílice — MP-001');
  });

  it('táctil: tocar el campo abre la lista con la elegida marcada y tocar una opción la elige', async () => {
    const usuario = userEvent.setup();
    const alCambiar = vi.fn();
    render(<Envoltura inicial="mp-001" alCambiar={alCambiar} />);

    await usuario.click(screen.getByRole('combobox', { name: 'Materia prima' }));
    expect(screen.getByRole('option', { name: /Arena sílice/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await usuario.click(screen.getByRole('option', { name: /Chatarra de acero/ }));
    expect(alCambiar).toHaveBeenCalledWith('mp-004');
    expect(document.querySelector('input[type="hidden"][name="material"]')).toHaveValue('mp-004');
  });

  it('no permite elegir una opción deshabilitada', async () => {
    const usuario = userEvent.setup();
    const alCambiar = vi.fn();
    render(<Envoltura alCambiar={alCambiar} />);

    await usuario.click(screen.getByRole('button', { name: 'Mostrar opciones' }));
    const deshabilitada = screen.getByRole('option', { name: /Bentonita/ });
    expect(deshabilitada).toHaveAttribute('aria-disabled', 'true');
    await usuario.click(deshabilitada);
    expect(alCambiar).not.toHaveBeenCalled();
  });

  it('con error marca aria-invalid', () => {
    render(
      <SelectBuscable
        etiqueta="Materia prima"
        opciones={MATERIALES}
        valor={null}
        alCambiar={() => undefined}
        error="Elija un material."
      />,
    );
    const combo = screen.getByRole('combobox', { name: 'Materia prima' });
    expect(combo).toHaveAttribute('aria-invalid', 'true');
    expect(combo).toHaveAccessibleDescription('Elija un material.');
  });
});
