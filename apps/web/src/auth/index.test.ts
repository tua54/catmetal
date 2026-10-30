import { describe, expect, it } from 'vitest';
import * as auth from './index';

describe('API pública de auth', () => {
  it('expone la sesión única, su cliente y el hook de React', () => {
    expect(auth.sesion).toBeInstanceOf(auth.GestorSesion);
    expect(auth.clienteApi).toBe(auth.sesion.api);
    expect(auth.useSesion.getState()).toMatchObject({ modo: 'sin_sesion', usuario: null });
    expect(auth.ITERACIONES_VERIFICADOR).toBe(600_000);
    expect(auth.NOMBRE_CANDADO_REFRESH).toBe('catmetal-refresh');
  });
});
