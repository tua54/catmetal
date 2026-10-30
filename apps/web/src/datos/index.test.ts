import { describe, expect, it } from 'vitest';
import * as datos from './index';

describe('API pública de la capa de datos', () => {
  it('expone las operaciones del outbox, las consultas y la aplicación de cambios', () => {
    for (const nombre of [
      'db',
      'obtenerInstalacionId',
      'registrarConsumoLocal',
      'editarConsumoLocal',
      'registrarNovedadLocal',
      'registrarConsumoConNovedadLocal',
      'aprobarLocal',
      'rechazarLocal',
      'siguienteLote',
      'marcarEnviando',
      'aplicarResultados',
      'programarReintento',
      'contarPendientes',
      'pendientesPorUsuario',
      'purgarAplicadasAntiguas',
      'puedeBorrarDatosDeUsuario',
      'borrarDatosDeUsuario',
      'registrosDelDia',
      'planeadoVsConsumido',
      'aplicarCambios',
      'aplicarEntidades',
      'completarSnapshot',
      'completarHidratacion',
      'leerMetaSync',
    ] as const) {
      expect(typeof datos[nombre]).not.toBe('undefined');
    }
  });

  it('las constantes de estados coinciden con la ADR 0012', () => {
    expect(datos.ESTADOS_LOCALES).toEqual([
      'pendiente_sync',
      'sincronizado',
      'aprobado',
      'rechazado',
      'conflicto',
      'rechazado_sync',
    ]);
    expect(datos.ESTADOS_SUBIDA).toEqual(['pendiente', 'subida', 'bloqueada', 'remota']);
    expect(datos.ACCIONES_TRAZABILIDAD).toHaveLength(6);
  });
});
