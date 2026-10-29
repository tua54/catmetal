import { describe, expect, it } from 'vitest';
import * as shared from './index';

describe('@catmetal/shared', () => {
  it('expone su nombre de paquete', () => {
    expect(shared.NOMBRE_PAQUETE).toBe('@catmetal/shared');
  });

  it('exporta desde el punto de entrada todos los módulos del contrato', () => {
    const esperados = [
      'ROLES',
      'ESTADOS_ORDEN',
      'TIPOS_MUTACION',
      'ZONA_HORARIA',
      'PERMISOS',
      'PERMISOS_POR_ROL',
      'tienePermiso',
      'CODIGOS_ERROR',
      'MENSAJES_ERROR',
      'ESTADO_HTTP_POR_CODIGO',
      'crearError',
      'MAGNITUD',
      'convertir',
      'excedeTolerancia',
      'formatearCOP',
      'parsearCantidad',
      'diaBogota',
      'uuidv7',
      'esUuidV7',
      'mutacionSchema',
      'syncPushRequestSchema',
      'syncPullQuerySchema',
      'listarOrdenesQuerySchema',
      'idParamSchema',
    ];
    for (const nombre of esperados) {
      expect(shared, nombre).toHaveProperty(nombre);
    }
  });
});
