import { describe, expect, it } from 'vitest';
import {
  CLAVE_EVENTO_SESION,
  crearCanalSesion,
  leerEventoSesion,
  NOMBRE_CANAL_SESION,
  type EventoSesion,
} from './canal-sesion';
import { almacenCompartido, busDifusion } from './pruebas/canal-falso';

describe('canal de sesión entre pestañas (ADR 0023)', () => {
  it('BroadcastChannel: entrega a las demás pestañas y nunca a sí misma; el mensaje no lleva secretos', () => {
    const bus = busDifusion();
    const a = crearCanalSesion({ crearCanal: bus.crearCanal, origen: 'pestana-a', ahora: () => 1 });
    const b = crearCanalSesion({ crearCanal: bus.crearCanal, origen: 'pestana-b' });
    const recibidosA: EventoSesion[] = [];
    const recibidosB: EventoSesion[] = [];
    a.escuchar((e) => recibidosA.push(e));
    b.escuchar((e) => recibidosB.push(e));

    a.emitir('logout', 'u1');
    expect(recibidosB).toEqual([
      { v: 1, tipo: 'logout', user_id: 'u1', origen: 'pestana-a', at: 1 },
    ]);
    expect(recibidosA).toEqual([]);
    // Solo estas claves: ni tokens, ni contraseñas, ni datos del perfil.
    expect(Object.keys(bus.mensajes[0] as object).sort()).toEqual([
      'at',
      'origen',
      'tipo',
      'user_id',
      'v',
    ]);

    b.cerrar();
    a.emitir('bloqueo', 'u1');
    expect(recibidosB).toHaveLength(1);
  });

  it('ignora los mensajes que no tienen la forma exacta y los propios', () => {
    const bus = busDifusion();
    const b = crearCanalSesion({ crearCanal: bus.crearCanal, origen: 'b' });
    const recibidos: EventoSesion[] = [];
    b.escuchar((e) => recibidos.push(e));
    const intruso = bus.crearCanal(NOMBRE_CANAL_SESION);
    for (const basura of [
      null,
      'logout',
      [],
      { v: 2, tipo: 'logout', user_id: null, origen: 'x', at: 1 },
      { v: 1, tipo: 'borrar-todo', user_id: null, origen: 'x', at: 1 },
      { v: 1, tipo: 'logout', user_id: 7, origen: 'x', at: 1 },
      { v: 1, tipo: 'logout', user_id: null, origen: '', at: 1 },
      { v: 1, tipo: 'logout', user_id: null, origen: 'x', at: Number.NaN },
      { v: 1, tipo: 'logout', user_id: null, origen: 'b', at: 1 },
    ]) {
      intruso.postMessage(basura);
    }
    expect(recibidos).toEqual([]);
    intruso.postMessage({
      v: 1,
      tipo: 'cambio-usuario',
      user_id: null,
      origen: 'x',
      at: 5,
      extra: 1,
    });
    // Los campos de más no pasan al evento.
    expect(recibidos).toEqual([
      { v: 1, tipo: 'cambio-usuario', user_id: null, origen: 'x', at: 5 },
    ]);
    expect(leerEventoSesion({ v: 1, tipo: 'bloqueo', user_id: 'u', origen: 'o', at: 0 })).toEqual({
      v: 1,
      tipo: 'bloqueo',
      user_id: 'u',
      origen: 'o',
      at: 0,
    });
  });

  it('sin BroadcastChannel usa localStorage y el evento storage de las demás pestañas', () => {
    const compartido = almacenCompartido();
    const pa = compartido.pestana();
    const pb = compartido.pestana();
    let reloj = 10;
    const a = crearCanalSesion({ crearCanal: null, ...pa, origen: 'a', ahora: () => reloj });
    const b = crearCanalSesion({ crearCanal: null, ...pb, origen: 'b' });
    const recibidosA: EventoSesion[] = [];
    const recibidosB: EventoSesion[] = [];
    a.escuchar((e) => recibidosA.push(e));
    b.escuchar((e) => recibidosB.push(e));

    a.emitir('bloqueo', 'u1');
    reloj += 1;
    a.emitir('bloqueo', 'u1');
    expect(recibidosB.map((e) => [e.tipo, e.at])).toEqual([
      ['bloqueo', 10],
      ['bloqueo', 11],
    ]);
    expect(recibidosA).toEqual([]);
    const guardado = JSON.parse(compartido.datos.get(CLAVE_EVENTO_SESION)!) as object;
    expect(Object.keys(guardado).sort()).toEqual(['at', 'origen', 'tipo', 'user_id', 'v']);

    // Otra clave o un valor que no es JSON se ignoran.
    pa.almacen.setItem(
      'otra',
      JSON.stringify({ v: 1, tipo: 'logout', user_id: null, origen: 'x', at: 1 }),
    );
    pa.almacen.setItem(CLAVE_EVENTO_SESION, '{no es json');
    expect(recibidosB).toHaveLength(2);

    b.cerrar();
    reloj += 1;
    a.emitir('logout', 'u1');
    expect(recibidosB).toHaveLength(2);
  });

  it('sin canal ni almacenamiento, emitir no falla', () => {
    const c = crearCanalSesion({ crearCanal: null, almacen: null, ventana: null });
    expect(() => c.emitir('logout', null)).not.toThrow();
    const roto = crearCanalSesion({
      crearCanal: null,
      almacen: {
        setItem: () => {
          throw new DOMException('cuota', 'QuotaExceededError');
        },
      },
      ventana: null,
    });
    expect(() => roto.emitir('logout', null)).not.toThrow();
  });

  it('con el BroadcastChannel real del entorno llega a la otra instancia', async () => {
    const a = crearCanalSesion({ origen: 'real-a' });
    const b = crearCanalSesion({ origen: 'real-b' });
    const recibido = new Promise<EventoSesion>((resolver) => b.escuchar(resolver));
    a.emitir('cambio-usuario', 'u2');
    await expect(recibido).resolves.toMatchObject({ tipo: 'cambio-usuario', user_id: 'u2' });
    a.cerrar();
    b.cerrar();
  });
});
