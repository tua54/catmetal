import { describe, expect, it } from 'vitest';
import {
  auditoriaQuerySchema,
  BOM_CSV,
  celdaCsv,
  ENTIDADES_AUDITORIA,
  fechaHoraBogotaCsv,
  filaCsv,
  lineaTiempoQuerySchema,
  neutralizarCeldaCsv,
  nombreArchivoCsv,
  numeroCsv,
  TIPOS_EVENTO_LINEA_TIEMPO,
} from './reportes';

describe('auditoriaQuerySchema', () => {
  it('acepta una query vacía y convierte cursor y límite a número', () => {
    expect(auditoriaQuerySchema.parse({})).toEqual({});
    expect(auditoriaQuerySchema.parse({ cursor: '1234', limite: '200' })).toEqual({
      cursor: 1234,
      limite: 200,
    });
  });

  it('normaliza las fechas y filtra por entidad', () => {
    expect(
      auditoriaQuerySchema.parse({
        entidad: 'consumptions',
        entidad_id: '0192d8a0-0000-7000-8000-000000000000',
        desde: '2026-10-29T00:00:00Z',
        hasta: '2026-10-30T00:00:00.000Z',
      }),
    ).toEqual({
      entidad: 'consumptions',
      entidad_id: '0192d8a0-0000-7000-8000-000000000000',
      desde: '2026-10-29T00:00:00.000Z',
      hasta: '2026-10-30T00:00:00.000Z',
    });
    expect(auditoriaQuerySchema.parse({ entidad_id: 'a:b' }).entidad_id).toBe('a:b');
    expect(auditoriaQuerySchema.parse({ entidad_id: 'tolerancia_pct' }).entidad_id).toBe(
      'tolerancia_pct',
    );
  });

  it.each([
    ['cursor', '0'],
    ['cursor', '-1'],
    ['cursor', '1.5'],
    ['cursor', 'abc'],
    ['cursor', '01'],
    ['cursor', '1234567890123456'],
    ['limite', '0'],
    ['limite', '201'],
    ['limite', 'x'],
    ['entidad', 'audit_log'],
    ['entidad', 'sync_mutations'],
    ['entidad_id', "x' OR 1=1"],
    ['entidad_id', ''],
    ['entidad_id', 'a'.repeat(101)],
    ['desde', '2026-10-29'],
    ['hasta', '2026-10-29T10:00:00-05:00'],
  ])('rechaza %s = %j', (campo, valor) => {
    expect(auditoriaQuerySchema.safeParse({ [campo]: valor }).success).toBe(false);
  });

  it('rechaza "desde" posterior a "hasta" y acepta el mismo instante', () => {
    const resultado = auditoriaQuerySchema.safeParse({
      desde: '2026-10-30T00:00:00.000Z',
      hasta: '2026-10-29T00:00:00.000Z',
    });
    expect(resultado.success).toBe(false);
    expect(resultado.error?.issues[0]?.path).toEqual(['hasta']);
    expect(
      auditoriaQuerySchema.safeParse({
        desde: '2026-10-29T00:00:00.000Z',
        hasta: '2026-10-29T00:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('las entidades incluyen las de sync, devices, refresh_tokens y login_cupos', () => {
    expect(ENTIDADES_AUDITORIA).toContain('consumptions');
    expect(ENTIDADES_AUDITORIA).toContain('devices');
    expect(ENTIDADES_AUDITORIA).toContain('refresh_tokens');
    expect(ENTIDADES_AUDITORIA).toContain('login_cupos');
    expect(TIPOS_EVENTO_LINEA_TIEMPO).toEqual([
      'sistema',
      'registro',
      'novedad',
      'validacion',
      'rechazo',
    ]);
  });
});

describe('lineaTiempoQuerySchema', () => {
  it('acepta cursor y límite y rechaza valores inválidos', () => {
    expect(lineaTiempoQuerySchema.parse({ cursor: '5', limite: '10' })).toEqual({
      cursor: 5,
      limite: 10,
    });
    expect(lineaTiempoQuerySchema.safeParse({ cursor: 'x' }).success).toBe(false);
    expect(lineaTiempoQuerySchema.safeParse({ limite: '500' }).success).toBe(false);
  });
});

describe('neutralizarCeldaCsv', () => {
  it.each([
    ['=HYPERLINK("x")', `'=HYPERLINK("x")`],
    ['+1', "'+1"],
    ['-2', "'-2"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tL-1', "'\tL-1"],
    ['\rL-1', "'\rL-1"],
    ['\nL-1', "'\nL-1"],
    ['＝1+1', "'＝1+1"],
    ['＋1', "'＋1"],
    ['－1', "'－1"],
    ['＠A1', "'＠A1"],
  ])('prefija %j', (valor, esperado) => {
    expect(neutralizarCeldaCsv(valor)).toBe(esperado);
  });

  it.each(['L-001', 'Arena sílice', '', ' =1', "'=1", '1+1', 'a@b.co'])('deja igual %j', (v) => {
    expect(neutralizarCeldaCsv(v)).toBe(v);
  });
});

describe('numeroCsv', () => {
  it.each([
    [1234.5, '1234,5'],
    [1_000_000, '1000000'],
    [0, '0'],
    [-0, '0'],
    [0.000125, '0,000125'],
    [125.5, '125,5'],
    [0.1 + 0.2, '0,3'],
    [-1.5, '-1,5'],
    [1e-7, '0'],
    [Number.NaN, ''],
    [Number.POSITIVE_INFINITY, ''],
  ])('%d → %j', (valor, esperado) => {
    expect(numeroCsv(valor)).toBe(esperado);
  });
});

describe('celdaCsv y filaCsv', () => {
  it('vacíos, booleanos, números y texto', () => {
    expect(celdaCsv(null)).toBe('');
    expect(celdaCsv(undefined)).toBe('');
    expect(celdaCsv(true)).toBe('Sí');
    expect(celdaCsv(false)).toBe('No');
    expect(celdaCsv(12.5)).toBe('12,5');
    expect(celdaCsv('Arena')).toBe('Arena');
  });

  it('pone comillas cuando hay ; " CR o LF y duplica las comillas internas', () => {
    expect(celdaCsv('a;b')).toBe('"a;b"');
    expect(celdaCsv('dijo "hola"')).toBe('"dijo ""hola"""');
    expect(celdaCsv('línea 1\nlínea 2')).toBe('"línea 1\nlínea 2"');
    expect(celdaCsv('a\rb')).toBe('"a\rb"');
  });

  it('neutraliza y además pone comillas si hace falta', () => {
    expect(celdaCsv('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(celdaCsv('\rL')).toBe(`"'\rL"`);
    expect(celdaCsv('\tL')).toBe("'\tL");
    expect(celdaCsv('-2;3')).toBe(`"'-2;3"`);
  });

  it('una fila usa ; y termina en CRLF; los números negativos no se neutralizan', () => {
    expect(filaCsv(['OP-2026-0587', 125.5, 'kg', null, true, -3])).toBe(
      'OP-2026-0587;125,5;kg;;Sí;-3\r\n',
    );
    expect(filaCsv([])).toBe('\r\n');
    expect(BOM_CSV).toBe(String.fromCharCode(0xfeff));
  });
});

describe('nombreArchivoCsv', () => {
  it.each([
    ['OP-2026-0587', 'OP-2026-0587-consumos.csv'],
    ['OP 2026/0587"', 'OP_2026_0587-consumos.csv'],
    ['../../etc/passwd', 'etc_passwd-consumos.csv'],
    ['"\r\n', 'orden-consumos.csv'],
    ['', 'orden-consumos.csv'],
    ['Ñandú;=1', 'and_1-consumos.csv'],
  ])('%j → %j', (codigo, esperado) => {
    expect(nombreArchivoCsv(codigo)).toBe(esperado);
  });

  it('limita la longitud', () => {
    expect(nombreArchivoCsv('A'.repeat(300))).toBe(`${'A'.repeat(80)}-consumos.csv`);
  });
});

describe('fechaHoraBogotaCsv', () => {
  it('convierte a la hora de Bogotá (UTC−5) en formato AAAA-MM-DD HH:mm:ss', () => {
    expect(fechaHoraBogotaCsv('2026-10-29T20:55:07.000Z')).toBe('2026-10-29 15:55:07');
    expect(fechaHoraBogotaCsv('2026-10-30T03:00:00.000Z')).toBe('2026-10-29 22:00:00');
    expect(fechaHoraBogotaCsv('2026-10-29T05:00:00.000Z')).toBe('2026-10-29 00:00:00');
  });

  it('devuelve vacío si no hay fecha o no es válida', () => {
    expect(fechaHoraBogotaCsv(null)).toBe('');
    expect(fechaHoraBogotaCsv('no-es-fecha')).toBe('');
  });
});
