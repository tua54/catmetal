// Prueba de humo de la página de muestra /diseno, montada con el router real de la app.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../../App';
import { createQueryClient } from '../../lib/query-client';
import { routes } from '../../routes';

async function abrirDiseno() {
  const router = createMemoryRouter(routes, { initialEntries: ['/diseno'] });
  render(<App router={router} queryClient={createQueryClient()} />);
  await screen.findByRole('heading', { level: 1, name: 'Sistema visual · Componentes base' });
}

describe('Página /diseno', () => {
  it('toma el título de la barra del handle de la ruta y muestra las secciones', async () => {
    await abrirDiseno();
    // La primera barra es la de la app; las otras dos son las muestras dentro de <main>.
    const [barraApp] = screen.getAllByRole('banner');
    expect(within(barraApp as HTMLElement).getByText('Sistema visual')).toBeInTheDocument();
    expect(
      within(barraApp as HTMLElement).getByText('Componentes base · Catmetal'),
    ).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Nuevo registro de material' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Resumen de la orden' })).toHaveTextContent(
      '$ 4.182.300',
    );
  });

  it('bloquea la novedad cuando la cantidad supera el plan más la tolerancia', async () => {
    const usuario = userEvent.setup();
    await abrirDiseno();
    const interruptor = screen.getByRole('switch', { name: '¿Hay una novedad en este consumo?' });
    expect(interruptor).toHaveAttribute('aria-checked', 'false');

    const cantidad = screen.getByRole('textbox', { name: /Cantidad utilizada/ });
    await usuario.clear(cantidad);
    await usuario.type(cantidad, '130');
    expect(interruptor).toHaveAttribute('aria-checked', 'true');
    expect(interruptor).toHaveAttribute('aria-disabled', 'true');
    expect(interruptor).toHaveAccessibleDescription(/la novedad es obligatoria/);
    expect(screen.getByRole('textbox', { name: /Justificación/ })).toBeInTheDocument();
  });

  it('rechazar exige motivo y muestra un toast al confirmar', async () => {
    const usuario = userEvent.setup();
    await abrirDiseno();
    await usuario.click(screen.getAllByRole('button', { name: 'Rechazar' })[0] as HTMLElement);

    const dialogo = screen.getByRole('alertdialog', { name: 'Rechazar consumo' });
    await usuario.type(
      within(dialogo).getByRole('textbox', { name: /Motivo del rechazo/ }),
      'No coincide con la báscula',
    );
    await usuario.click(within(dialogo).getByRole('button', { name: 'Rechazar' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(await screen.findByText('Motivo: No coincide con la báscula')).toBeInTheDocument();
  });

  it('abre la evidencia en el visor y la cierra con Escape', async () => {
    const usuario = userEvent.setup();
    await abrirDiseno();
    await usuario.click(screen.getByRole('button', { name: 'evidencia_sellado_4471.jpg' }));
    expect(screen.getByRole('dialog', { name: 'evidencia_sellado_4471.jpg' })).toBeInTheDocument();
    await usuario.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
