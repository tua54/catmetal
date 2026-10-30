// A7 (ADR 0022, Enmienda 1): con la cuota de almacenamiento agotada, la app muestra un aviso
// persistente y accesible, "Almacenamiento lleno: sincroniza o libera espacio", mientras dure.

import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useEstadoSync } from '../../sync';
import { entrarSinConexion, reiniciarApp, renderizarApp } from '../../test/app';

beforeEach(reiniciarApp);
afterEach(reiniciarApp);

describe('A7: aviso de almacenamiento lleno', () => {
  it('aparece como alerta mientras dura y desaparece al resolverse', async () => {
    await entrarSinConexion('supervisor');
    renderizarApp('/supervisor');
    await screen.findByRole('heading', { level: 1, name: 'Mis órdenes en proceso' });
    expect(
      screen.queryByText('Almacenamiento lleno: sincroniza o libera espacio'),
    ).not.toBeInTheDocument();

    act(() => useEstadoSync.setState({ almacenamientoLleno: true }));
    const titulo = screen.getByText('Almacenamiento lleno: sincroniza o libera espacio');
    // Se anuncia al aparecer (región `alert`), con el tono indicado también en texto.
    const aviso = titulo.closest('[role="alert"]');
    expect(aviso).not.toBeNull();
    expect(aviso).toHaveTextContent(
      'Advertencia: Almacenamiento lleno: sincroniza o libera espacio',
    );

    act(() => useEstadoSync.setState({ almacenamientoLleno: false }));
    expect(
      screen.queryByText('Almacenamiento lleno: sincroniza o libera espacio'),
    ).not.toBeInTheDocument();
  });
});
