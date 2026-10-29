import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Boton } from './Boton';
import { DialogoConfirmacion, type ConfigMotivo } from './DialogoConfirmacion';
import { SelectBuscable } from './SelectBuscable';

function Escenario({
  motivo,
  alConfirmar = () => undefined,
  conCombo = false,
}: {
  motivo?: ConfigMotivo;
  alConfirmar?: (motivo?: string) => void;
  conCombo?: boolean;
}) {
  const [abierto, setAbierto] = useState(false);
  return (
    <>
      <p>Contenido de fondo</p>
      <Boton onClick={() => setAbierto(true)}>{motivo ? 'Rechazar' : 'Validar gasto'}</Boton>
      <DialogoConfirmacion
        abierto={abierto}
        titulo={motivo ? 'Rechazar consumo' : '¿Validar este gasto?'}
        descripcion="Queda registrado en la auditoría."
        textoConfirmar={motivo ? 'Confirmar rechazo' : 'Validar'}
        tono={motivo ? 'peligro' : 'exito'}
        motivo={motivo}
        alCancelar={() => setAbierto(false)}
        alConfirmar={(texto) => {
          alConfirmar(texto);
          setAbierto(false);
        }}
      >
        {conCombo && (
          <SelectBuscable
            etiqueta="Supervisor"
            opciones={[{ valor: 'js', etiqueta: 'Juan S.' }]}
            valor={null}
            alCambiar={() => undefined}
          />
        )}
      </DialogoConfirmacion>
    </>
  );
}

describe('DialogoConfirmacion', () => {
  it('abre un alertdialog modal con título y descripción, y enfoca "Cancelar"', async () => {
    const usuario = userEvent.setup();
    render(<Escenario />);
    await usuario.click(screen.getByRole('button', { name: 'Validar gasto' }));

    const dialogo = screen.getByRole('alertdialog', { name: '¿Validar este gasto?' });
    expect(dialogo).toHaveAttribute('aria-modal', 'true');
    expect(dialogo).toHaveAccessibleDescription('Queda registrado en la auditoría.');
    expect(screen.getByRole('button', { name: 'Cancelar' })).toHaveFocus();
  });

  it('atrapa el foco: Tab y Shift+Tab dan la vuelta dentro del diálogo', async () => {
    const usuario = userEvent.setup();
    render(<Escenario />);
    await usuario.click(screen.getByRole('button', { name: 'Validar gasto' }));

    const cancelar = screen.getByRole('button', { name: 'Cancelar' });
    const confirmar = screen.getByRole('button', { name: 'Validar' });
    expect(cancelar).toHaveFocus();
    await usuario.tab();
    expect(confirmar).toHaveFocus();
    await usuario.tab();
    expect(cancelar).toHaveFocus();
    await usuario.tab({ shift: true });
    expect(confirmar).toHaveFocus();
  });

  it('vuelve inerte el resto de la página mientras está abierto', async () => {
    const usuario = userEvent.setup();
    const { container } = render(<Escenario />);
    await usuario.click(screen.getByRole('button', { name: 'Validar gasto' }));

    expect(container).toHaveAttribute('inert');
    await usuario.keyboard('{Escape}');
    expect(container).not.toHaveAttribute('inert');
  });

  it('Escape cierra y devuelve el foco al botón que lo abrió', async () => {
    const usuario = userEvent.setup();
    render(<Escenario />);
    const disparador = screen.getByRole('button', { name: 'Validar gasto' });
    await usuario.click(disparador);

    await usuario.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(disparador).toHaveFocus();
  });

  it('confirma sin motivo cuando no se pide', async () => {
    const usuario = userEvent.setup();
    const alConfirmar = vi.fn();
    render(<Escenario alConfirmar={alConfirmar} />);
    await usuario.click(screen.getByRole('button', { name: 'Validar gasto' }));
    await usuario.click(screen.getByRole('button', { name: 'Validar' }));
    expect(alConfirmar).toHaveBeenCalledWith(undefined);
  });

  it('rechazo: el motivo es obligatorio, se valida el mínimo y se entrega recortado', async () => {
    const usuario = userEvent.setup();
    const alConfirmar = vi.fn();
    render(<Escenario motivo={{ etiqueta: 'Motivo del rechazo' }} alConfirmar={alConfirmar} />);
    await usuario.click(screen.getByRole('button', { name: 'Rechazar' }));

    const campo = screen.getByRole('textbox', { name: /Motivo del rechazo/ });
    expect(campo).toHaveFocus();
    expect(campo).toBeRequired();

    await usuario.click(screen.getByRole('button', { name: 'Confirmar rechazo' }));
    expect(alConfirmar).not.toHaveBeenCalled();
    expect(campo).toHaveAttribute('aria-invalid', 'true');
    expect(campo).toHaveAccessibleDescription(/Motivo del rechazo es obligatorio\./);
    expect(campo).toHaveFocus();

    await usuario.type(campo, '  no');
    await usuario.click(screen.getByRole('button', { name: 'Confirmar rechazo' }));
    expect(alConfirmar).not.toHaveBeenCalled();
    expect(campo).toHaveAccessibleDescription(/Escriba al menos 3 caracteres\./);

    await usuario.type(campo, ' coincide con la báscula  ');
    expect(campo).not.toHaveAttribute('aria-invalid');
    await usuario.click(screen.getByRole('button', { name: 'Confirmar rechazo' }));
    expect(alConfirmar).toHaveBeenCalledWith('no coincide con la báscula');
  });

  it('el motivo se reinicia al volver a abrir', async () => {
    const usuario = userEvent.setup();
    render(<Escenario motivo={{}} />);
    await usuario.click(screen.getByRole('button', { name: 'Rechazar' }));
    await usuario.type(screen.getByRole('textbox', { name: /Motivo/ }), 'borrador');
    await usuario.click(screen.getByRole('button', { name: 'Cancelar' }));
    await usuario.click(screen.getByRole('button', { name: 'Rechazar' }));
    expect(screen.getByRole('textbox', { name: /Motivo/ })).toHaveValue('');
  });

  it('Escape dentro de un combobox abierto cierra la lista, no el diálogo', async () => {
    const usuario = userEvent.setup();
    render(<Escenario conCombo />);
    await usuario.click(screen.getByRole('button', { name: 'Validar gasto' }));

    const combo = screen.getByRole('combobox', { name: 'Supervisor' });
    await usuario.click(combo);
    expect(combo).toHaveAttribute('aria-expanded', 'true');
    await usuario.keyboard('{Escape}');
    expect(combo).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
});
