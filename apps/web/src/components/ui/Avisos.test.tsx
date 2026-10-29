import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Aviso } from './Aviso';
import { Boton } from './Boton';
import type { DatosAviso } from './contexto-avisos';
import { ProveedorAvisos } from './ProveedorAvisos';
import { useAvisos } from './useAvisos';

describe('Aviso (en línea)', () => {
  it('estático por defecto: sin rol vivo, con el tono dicho en texto', () => {
    render(<Aviso tono="advertencia" titulo="3 registros sin sincronizar" />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Advertencia:')).toHaveClass('sr-only');
  });

  it('con anunciar: alert para error/advertencia y status para info/éxito', () => {
    const { rerender } = render(<Aviso tono="error" titulo="Falló" anunciar />);
    expect(screen.getByRole('alert')).toHaveTextContent('Error: Falló');
    rerender(<Aviso tono="exito" titulo="Listo" anunciar />);
    expect(screen.getByRole('status')).toHaveTextContent('Éxito: Listo');
  });

  it('el botón cerrar mide 44 px y llama a alCerrar', async () => {
    const usuario = userEvent.setup();
    const alCerrar = vi.fn();
    render(<Aviso titulo="Información" alCerrar={alCerrar} />);
    const cerrar = screen.getByRole('button', { name: 'Cerrar aviso' });
    expect(cerrar).toHaveClass('size-11');
    await usuario.click(cerrar);
    expect(alCerrar).toHaveBeenCalledTimes(1);
  });
});

function Disparador({ aviso }: { aviso: DatosAviso }) {
  const { mostrar } = useAvisos();
  return <Boton onClick={() => mostrar(aviso)}>Mostrar</Boton>;
}

describe('ProveedorAvisos (toasts)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Con temporizadores falsos se usa fireEvent: user-event espera tiempos reales entre eventos.
  function montar(aviso: DatosAviso) {
    render(
      <ProveedorAvisos>
        <Disparador aviso={aviso} />
      </ProveedorAvisos>,
    );
  }

  function pulsar(nombre: string) {
    fireEvent.click(screen.getByRole('button', { name: nombre }));
  }

  it('las regiones vivas existen antes de mostrar un toast', () => {
    montar({ titulo: 'x' });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
  });

  it('un toast de éxito va en la región status y no desaparece antes de 5 s', () => {
    montar({ tono: 'exito', titulo: 'Consumo validado', duracionMs: 1_000 });
    pulsar('Mostrar');

    expect(screen.getByRole('status')).toHaveTextContent('Consumo validado');
    act(() => {
      vi.advanceTimersByTime(4_900);
    });
    expect(screen.getByText('Consumo validado')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText('Consumo validado')).not.toBeInTheDocument();
  });

  it('un toast de error va en la región alert y no se cierra solo', () => {
    montar({ tono: 'error', titulo: 'No se pudo sincronizar' });
    pulsar('Mostrar');

    expect(screen.getByRole('alert')).toHaveTextContent('No se pudo sincronizar');
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText('No se pudo sincronizar')).toBeInTheDocument();

    pulsar('Cerrar aviso');
    expect(screen.queryByText('No se pudo sincronizar')).not.toBeInTheDocument();
  });

  it('se pausa mientras tiene el foco', () => {
    montar({ tono: 'info', titulo: 'Versión nueva' });
    pulsar('Mostrar');

    act(() => {
      screen.getByRole('button', { name: 'Cerrar aviso' }).focus();
    });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText('Versión nueva')).toBeInTheDocument();
  });

  it('useAvisos fuera del proveedor lanza un error claro', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Disparador aviso={{ titulo: 'x' }} />)).toThrow(
      'useAvisos debe usarse dentro de <ProveedorAvisos>.',
    );
  });
});
