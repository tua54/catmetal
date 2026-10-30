import { describe, expect, it } from 'vitest';
import {
  CLAVE_ACTIVIDAD_SESION,
  CLAVE_EVENTO_SESION,
  crearCanalSesion,
  leerEventoSesion,
  leerMarcaActividad,
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
        getItem: () => {
          throw new DOMException('bloqueado', 'SecurityError');
        },
        setItem: () => {
          throw new DOMException('cuota', 'QuotaExceededError');
        },
      },
      ventana: null,
    });
    expect(() => roto.emitir('logout', null)).not.toThrow();
    expect(() => roto.emitir('actividad', 'u1', { at: 1 })).not.toThrow();
    expect(roto.leerMarcaActividad()).toBeNull();
    expect(c.leerMarcaActividad()).toBeNull();
  });

  it('A2: el aviso actividad lleva la hora de la interacción y deja la marca, sin secretos', () => {
    const bus = busDifusion();
    const compartido = almacenCompartido();
    const a = crearCanalSesion({
      crearCanal: bus.crearCanal,
      almacen: compartido.pestana().almacen,
      origen: 'a',
      ahora: () => 100,
    });
    const b = crearCanalSesion({
      crearCanal: bus.crearCanal,
      almacen: compartido.pestana().almacen,
      origen: 'b',
    });
    const recibidos: EventoSesion[] = [];
    b.escuchar((e) => recibidos.push(e));

    a.emitir('actividad', 'u1', { at: 40 });
    expect(recibidos).toEqual([{ v: 1, tipo: 'actividad', user_id: 'u1', origen: 'a', at: 40 }]);
    expect(Object.keys(bus.mensajes[0] as object).sort()).toEqual([
      'at',
      'origen',
      'tipo',
      'user_id',
      'v',
    ]);
    // La marca: solo `user_id` y `at`; la lee cualquier pestaña.
    expect(JSON.parse(compartido.datos.get(CLAVE_ACTIVIDAD_SESION)!)).toEqual({
      user_id: 'u1',
      at: 40,
    });
    expect(b.leerMarcaActividad()).toEqual({ user_id: 'u1', at: 40 });

    // La marca no retrocede con una actividad más vieja del mismo usuario...
    a.emitir('actividad', 'u1', { at: 30 });
    expect(b.leerMarcaActividad()).toEqual({ user_id: 'u1', at: 40 });
    // ...pero sí la reemplaza una de otro usuario o una que sustituye a una marca del futuro.
    a.emitir('actividad', 'u2', { at: 20 });
    expect(b.leerMarcaActividad()).toEqual({ user_id: 'u2', at: 20 });
    compartido.datos.set(CLAVE_ACTIVIDAD_SESION, JSON.stringify({ user_id: 'u2', at: 10_000 }));
    a.emitir('actividad', 'u2', { at: 50 });
    expect(b.leerMarcaActividad()).toEqual({ user_id: 'u2', at: 50 });

    // Los demás tipos no tocan la marca.
    a.emitir('bloqueo', 'u2', { motivo: 'inactividad' });
    a.emitir('logout', null);
    expect(b.leerMarcaActividad()).toEqual({ user_id: 'u2', at: 50 });
  });

  it('A2: bloqueo con motivo; un motivo desconocido o mal formado deja el bloqueo sin motivo', () => {
    const bus = busDifusion();
    const a = crearCanalSesion({ crearCanal: bus.crearCanal, origen: 'a', ahora: () => 7 });
    const b = crearCanalSesion({ crearCanal: bus.crearCanal, origen: 'b' });
    const recibidos: EventoSesion[] = [];
    b.escuchar((e) => recibidos.push(e));

    a.emitir('bloqueo', 'u1', { motivo: 'revocacion' });
    a.emitir('bloqueo', 'u1', { motivo: 'inactividad' });
    a.emitir('bloqueo', 'u1');
    // El motivo solo viaja en `bloqueo`.
    a.emitir('logout', 'u1', { motivo: 'revocacion' });
    expect(recibidos).toEqual([
      { v: 1, tipo: 'bloqueo', user_id: 'u1', origen: 'a', at: 7, motivo: 'revocacion' },
      { v: 1, tipo: 'bloqueo', user_id: 'u1', origen: 'a', at: 7, motivo: 'inactividad' },
      { v: 1, tipo: 'bloqueo', user_id: 'u1', origen: 'a', at: 7 },
      { v: 1, tipo: 'logout', user_id: 'u1', origen: 'a', at: 7 },
    ]);
    expect(bus.mensajes[3]).not.toHaveProperty('motivo');

    for (const motivo of ['borrar-todo', 42, null, { x: 1 }]) {
      expect(
        leerEventoSesion({ v: 1, tipo: 'bloqueo', user_id: 'u', origen: 'o', at: 0, motivo }),
      ).toEqual({ v: 1, tipo: 'bloqueo', user_id: 'u', origen: 'o', at: 0 });
    }
  });

  it('A2: una actividad mal formada o un tipo desconocido se ignoran', () => {
    const bus = busDifusion();
    const b = crearCanalSesion({ crearCanal: bus.crearCanal, origen: 'b' });
    const recibidos: EventoSesion[] = [];
    b.escuchar((e) => recibidos.push(e));
    const intruso = bus.crearCanal(NOMBRE_CANAL_SESION);
    for (const basura of [
      { v: 1, tipo: 'actividad', user_id: null, origen: 'x', at: 1 },
      { v: 1, tipo: 'actividad', user_id: '', origen: 'x', at: 1 },
      { v: 1, tipo: 'actividad', user_id: 'u1', origen: 'x', at: '1' },
      { v: 1, tipo: 'actividad', user_id: 'u1', origen: 'x', at: Number.POSITIVE_INFINITY },
      { v: 1, tipo: 'actividad', user_id: 'u1', origen: 'x' },
      // Un tipo que esta versión no conoce (como `actividad` para una pestaña v1.1): se ignora.
      { v: 1, tipo: 'actividad-v2', user_id: 'u1', origen: 'x', at: 1 },
    ]) {
      intruso.postMessage(basura);
    }
    expect(recibidos).toEqual([]);
    // Los campos de más no pasan (ni siquiera un motivo en una actividad).
    intruso.postMessage({
      v: 1,
      tipo: 'actividad',
      user_id: 'u1',
      origen: 'x',
      at: 3,
      motivo: 'revocacion',
      token: 'secreto',
    });
    expect(recibidos).toEqual([{ v: 1, tipo: 'actividad', user_id: 'u1', origen: 'x', at: 3 }]);
  });

  it('A2: la marca compartida solo se acepta con la forma exacta', () => {
    expect(leerMarcaActividad(JSON.stringify({ user_id: 'u1', at: 5, extra: 1 }))).toEqual({
      user_id: 'u1',
      at: 5,
    });
    for (const texto of [
      null,
      '',
      '{no es json',
      'null',
      '[]',
      '5',
      JSON.stringify({ user_id: '', at: 5 }),
      JSON.stringify({ user_id: 7, at: 5 }),
      JSON.stringify({ user_id: 'u1', at: '5' }),
      JSON.stringify({ user_id: 'u1' }),
    ]) {
      expect(leerMarcaActividad(texto)).toBeNull();
    }
  });

  it('A2 sin BroadcastChannel: la actividad viaja por storage y la marca va en su propia clave', () => {
    const compartido = almacenCompartido();
    const pa = compartido.pestana();
    const pb = compartido.pestana();
    const a = crearCanalSesion({ crearCanal: null, ...pa, origen: 'a' });
    const b = crearCanalSesion({ crearCanal: null, ...pb, origen: 'b' });
    const recibidos: EventoSesion[] = [];
    b.escuchar((e) => recibidos.push(e));
    a.emitir('actividad', 'u1', { at: 9 });
    expect(recibidos).toEqual([{ v: 1, tipo: 'actividad', user_id: 'u1', origen: 'a', at: 9 }]);
    expect(b.leerMarcaActividad()).toEqual({ user_id: 'u1', at: 9 });
    // La escritura de la marca (otra clave) no se entrega como evento.
    pa.almacen.setItem(CLAVE_ACTIVIDAD_SESION, JSON.stringify({ user_id: 'u1', at: 10 }));
    expect(recibidos).toHaveLength(1);
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
