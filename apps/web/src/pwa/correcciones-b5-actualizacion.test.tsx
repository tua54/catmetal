// B5 (cliente; ADR 0026): ante `CLIENTE_DESACTUALIZADO` la app muestra un aviso bloqueante
// ("Hay una versión nueva de la app. Actualizando…"), busca el Service Worker nuevo
// (`registration.update()`), lo activa (`SKIP_WAITING`) y recarga. Si no hay versión nueva (sin
// red), el aviso sigue y se reintenta en el siguiente disparador de sync.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RegisterSWOptions } from 'vite-plugin-pwa/types';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ProveedorAvisos } from '../components/ui';
import { AvisoActualizacion } from './AvisoActualizacion';
import {
  avisarClienteDesactualizado,
  crearStoreEstadoPwa,
  registrarServiceWorker,
  useEstadoPwa,
} from './registro';

const estadoInicial = useEstadoPwa.getState();

beforeEach(() => {
  useEstadoPwa.setState(estadoInicial, true);
});

afterEach(() => {
  useEstadoPwa.setState(estadoInicial, true);
});

interface RegistroFalso {
  update: Mock<() => Promise<void>>;
  installing: unknown;
  waiting: unknown;
}

function registrar(enLinea = true) {
  const store = crearStoreEstadoPwa();
  let opciones: RegisterSWOptions = {};
  const actualizarSW = vi.fn(() => Promise.resolve());
  registrarServiceWorker(
    (o) => {
      opciones = o;
      return actualizarSW;
    },
    { store, intervaloMs: 60_000, enLinea: () => enLinea, alError: vi.fn() },
  );
  const registro: RegistroFalso = {
    update: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    installing: null,
    waiting: null,
  };
  opciones.onRegisteredSW?.('/sw.js', registro as unknown as ServiceWorkerRegistration);
  return { store, opciones, actualizarSW, registro };
}

describe('B5: actualización forzada del Service Worker', () => {
  it('con una versión en espera: la activa y recarga sin preguntar', async () => {
    const { store, opciones, actualizarSW } = registrar();
    opciones.onNeedRefresh?.();
    avisarClienteDesactualizado({ version_minima: 3 }, store);
    await vi.waitFor(() => expect(actualizarSW).toHaveBeenCalledWith(true));
    expect(store.getState()).toMatchObject({ desactualizado: true, versionMinima: 3 });
  });

  it('sin versión en espera: busca la nueva con registration.update() y la activa al instalarse', async () => {
    const { store, opciones, actualizarSW, registro } = registrar();
    registro.update.mockImplementation(() => {
      registro.installing = {};
      return Promise.resolve();
    });
    avisarClienteDesactualizado({ version_minima: 3 }, store);
    await vi.waitFor(() => expect(registro.update).toHaveBeenCalledTimes(1));
    expect(actualizarSW).not.toHaveBeenCalled();
    // Termina de instalarse y queda en espera: se activa sola (no espera al botón).
    opciones.onNeedRefresh?.();
    expect(actualizarSW).toHaveBeenCalledWith(true);
    expect(store.getState().sinVersionNueva).toBe(false);
  });

  it('sin red (o sin versión nueva): el aviso sigue y se reintenta en el siguiente aviso', async () => {
    const sinRed = registrar(false);
    avisarClienteDesactualizado({ version_minima: 3 }, sinRed.store);
    await vi.waitFor(() => expect(sinRed.store.getState().sinVersionNueva).toBe(true));
    expect(sinRed.registro.update).not.toHaveBeenCalled();
    expect(sinRed.actualizarSW).not.toHaveBeenCalled();
    expect(sinRed.store.getState().desactualizado).toBe(true);

    const conRed = registrar(true);
    conRed.registro.update.mockRejectedValueOnce(new Error('Failed to update'));
    avisarClienteDesactualizado({ version_minima: 3 }, conRed.store);
    await vi.waitFor(() => expect(conRed.store.getState().sinVersionNueva).toBe(true));
    // Siguiente sync, siguiente 426: se vuelve a buscar.
    avisarClienteDesactualizado({ version_minima: 3 }, conRed.store);
    await vi.waitFor(() => expect(conRed.registro.update).toHaveBeenCalledTimes(2));
  });

  it('sin Service Worker registrado (desarrollo) solo marca el estado', () => {
    const store = crearStoreEstadoPwa();
    avisarClienteDesactualizado({ version_minima: 'x' }, store);
    expect(store.getState()).toMatchObject({
      desactualizado: true,
      versionMinima: null,
      sinVersionNueva: true,
    });
  });
});

describe('B5: aviso bloqueante', () => {
  it('tapa la app con "Hay una versión nueva de la app. Actualizando…" y no se puede cerrar', async () => {
    const usuario = userEvent.setup();
    useEstadoPwa.setState({ desactualizado: true, sinVersionNueva: false });
    render(
      <ProveedorAvisos>
        <button type="button">Registrar consumo</button>
        <AvisoActualizacion />
      </ProveedorAvisos>,
    );
    const dialogo = screen.getByRole('alertdialog', {
      name: 'Hay una versión nueva de la app. Actualizando…',
    });
    expect(dialogo).toHaveTextContent('Sus registros pendientes siguen guardados en esta tablet');
    await usuario.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('Registrar consumo').closest('[inert]')).not.toBeNull();
  });

  it('sin versión nueva disponible: lo explica y permite reintentar', async () => {
    const usuario = userEvent.setup();
    const forzar = vi.fn(() => Promise.resolve());
    useEstadoPwa.setState({
      desactualizado: true,
      sinVersionNueva: true,
      forzarActualizacion: forzar,
    });
    render(
      <ProveedorAvisos>
        <AvisoActualizacion />
      </ProveedorAvisos>,
    );
    const dialogo = screen.getByRole('alertdialog');
    expect(dialogo).toHaveTextContent('Todavía no se pudo descargar la versión nueva');
    await usuario.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(forzar).toHaveBeenCalledTimes(1);
  });
});
