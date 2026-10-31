import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { AreaTexto, Campo } from './Campo';
import { SelectCorto } from './SelectCorto';

describe('Campo', () => {
  it('asocia la etiqueta visible y la ayuda con el input', () => {
    render(<Campo etiqueta="Lote" ayuda="Número impreso en el saco." />);

    const campo = screen.getByRole('textbox', { name: 'Lote' });
    expect(campo).toHaveAccessibleDescription('Número impreso en el saco.');
    expect(campo).not.toHaveAttribute('aria-invalid');
  });

  it('con error marca aria-invalid y describe el error (ícono + texto)', () => {
    render(<Campo etiqueta="Lote" ayuda="Ayuda" error="El lote es obligatorio." requerido />);

    const campo = screen.getByRole('textbox', { name: /Lote/ });
    expect(campo).toHaveAttribute('aria-invalid', 'true');
    expect(campo).toBeRequired();
    expect(campo).toHaveAccessibleDescription('Ayuda El lote es obligatorio.');
    expect(screen.getByText('(obligatorio)')).toHaveClass('sr-only');
  });

  it('la variante numérica usa inputMode decimal, texto y cifras tabulares', async () => {
    const usuario = userEvent.setup();
    render(<Campo etiqueta="Cantidad utilizada" numerico sufijo="kg" />);

    const campo = screen.getByRole('textbox', { name: 'Cantidad utilizada' });
    expect(campo).toHaveAttribute('inputmode', 'decimal');
    expect(campo).toHaveAttribute('type', 'text');
    expect(campo).toHaveClass('cifras');
    await usuario.type(campo, '125,5');
    expect(campo).toHaveValue('125,5');
  });
});

describe('AreaTexto', () => {
  function AreaControlada() {
    const [valor, setValor] = useState('');
    return (
      <AreaTexto
        etiqueta="Justificación"
        maxLength={500}
        mostrarContador
        value={valor}
        onChange={(evento) => setValor(evento.target.value)}
      />
    );
  }

  it('muestra el contador de caracteres enlazado como descripción', async () => {
    const usuario = userEvent.setup();
    render(<AreaControlada />);

    const area = screen.getByRole('textbox', { name: 'Justificación' });
    await usuario.type(area, 'Reproceso');
    expect(screen.getByText('9/500 caracteres')).toBeInTheDocument();
    expect(area).toHaveAccessibleDescription('9/500 caracteres');
  });
});

describe('SelectCorto', () => {
  it('es un select nativo con etiqueta, opción vacía y error accesible', async () => {
    const usuario = userEvent.setup();
    render(
      <SelectCorto
        etiqueta="Unidad"
        textoVacio="Seleccione…"
        opciones={[
          { valor: 'kg', etiqueta: 'kg' },
          { valor: 'l', etiqueta: 'l' },
        ]}
        error="Elija una unidad."
      />,
    );

    const select = screen.getByRole('combobox', { name: 'Unidad' });
    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(select).toHaveAccessibleDescription('Elija una unidad.');
    expect(screen.getAllByRole('option')).toHaveLength(3);
    await usuario.selectOptions(select, 'l');
    expect(select).toHaveValue('l');
  });
});
