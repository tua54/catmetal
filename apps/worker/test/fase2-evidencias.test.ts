// Evidencias en R2: PUT y GET /evidences/:id (magic bytes, sha256, tamaño, idempotencia, permisos y
// cabeceras). D1 y R2 locales reales.
import { type Evidencia, MAX_EVIDENCIA_BYTES, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buscarEvidencia,
  detectarMime,
  leerCuerpoLimitado,
  planMarcarSubida,
  tipoDeContenido,
} from '../src/dominio/evidencias';
import { ejecutarPlan } from '../src/dominio/plan';
import {
  type Archivo,
  archivo,
  cuerpoConsumo,
  cuerpoNovedad,
  descargar,
  escenarioOrden,
  jpeg,
  novedadOk,
  png,
  registrarOk,
  subir,
  webp,
} from './fase2-consumos-helpers';
import {
  asignar,
  auditoriaDesde,
  contextoDe,
  esperarError,
  json,
  sesion,
  type SesionDeRol,
  ultimoSeq,
} from './fase2-helpers';

let admin: SesionDeRol;
let jefe: SesionDeRol;
let supervisor: SesionDeRol;
let otroSupervisor: SesionDeRol;

beforeAll(async () => {
  [admin, jefe, supervisor, otroSupervisor] = await Promise.all([
    sesion('admin'),
    sesion('jefe'),
    sesion('supervisor'),
    sesion('supervisor'),
  ]);
});

/** Novedad del supervisor con las fotos declaradas (todavía sin subir). */
async function declarar(...fotos: Archivo[]) {
  const esc = await escenarioOrden(jefe, supervisor);
  const consumo = await registrarOk(supervisor.token, cuerpoConsumo(esc.orden, esc.material));
  await novedadOk(supervisor.token, consumo.id, cuerpoNovedad(consumo.id, fotos));
  return { ...esc, consumo };
}

async function subidoEnD1(id: string): Promise<number | undefined> {
  const fila = await env.DB.prepare('SELECT subido FROM evidences WHERE id = ?')
    .bind(id)
    .first<{ subido: number }>();
  return fila?.subido;
}

describe('PUT /evidences/:id', () => {
  it.each([
    ['image/jpeg', jpeg],
    ['image/png', png],
    ['image/webp', webp],
  ] as const)('sube un %s: R2, subido = 1 y auditoría evidencia.subida', async (mime, crear) => {
    const foto = await archivo(mime, crear(1024));
    const { orden } = await declarar(foto);
    const antes = await ultimoSeq();
    const respuesta = await subir(supervisor.token, foto.id, foto.bytes, mime);
    expect(respuesta.status).toBe(200);
    const evidencia = await respuesta.json<Evidencia>();
    expect(evidencia).toMatchObject({ id: foto.id, mime, subido: true, sha256: foto.sha256 });
    expect(evidencia.subido_at).not.toBeNull();
    expect(evidencia).not.toHaveProperty('storage_key');

    const objeto = await env.EVIDENCE.get(`evidencias/${orden}/${foto.id}`);
    expect(objeto).not.toBeNull();
    expect(new Uint8Array((await objeto?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(foto.bytes);
    expect(objeto?.httpMetadata?.contentType).toBe(mime);
    expect(objeto?.customMetadata).toEqual({ sha256: foto.sha256 });

    const filas = await auditoriaDesde(antes);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      entidad: 'evidences',
      entidad_id: foto.id,
      accion: 'evidencia.subida',
      order_id: orden,
      actor_id: supervisor.usuario.id,
    });
    expect(json(filas[0]?.datos_antes ?? null)).toMatchObject({ subido: false });
    expect(json(filas[0]?.datos_despues ?? null)).toMatchObject({ subido: true });
  });

  it('es idempotente con la misma foto (sin nueva auditoría) y 409 con otra distinta', async () => {
    const foto = await archivo('image/jpeg', jpeg());
    await declarar(foto);
    expect((await subir(supervisor.token, foto.id, foto.bytes, 'image/jpeg')).status).toBe(200);
    const antes = await ultimoSeq();
    const otraVez = await subir(supervisor.token, foto.id, foto.bytes, 'image/jpeg');
    expect(otraVez.status).toBe(200);
    expect(await otraVez.json<Evidencia>()).toMatchObject({ id: foto.id, subido: true });
    await esperarError(
      await subir(supervisor.token, foto.id, jpeg(), 'image/jpeg'),
      409,
      'EVIDENCIA_YA_SUBIDA',
    );
    expect(await auditoriaDesde(antes)).toHaveLength(0);
  });

  it('rechaza un mime falso con 415 (magic bytes, no la cabecera) y no escribe en R2', async () => {
    const declaradaJpeg = await archivo('image/jpeg', jpeg());
    const { orden } = await declarar(declaradaJpeg);
    const cuerpoPng = png();
    const texto = new TextEncoder().encode('<script>alert(1)</script>');
    const casos: [Uint8Array, string | null][] = [
      [cuerpoPng, 'image/jpeg'], // PNG declarado y enviado como JPEG
      [texto, 'image/jpeg'], // texto con Content-Type de imagen
      [declaradaJpeg.bytes, 'image/png'], // cabecera distinta del mime declarado
      [declaradaJpeg.bytes, null], // sin Content-Type
      [new Uint8Array(0), 'image/jpeg'], // vacío
    ];
    for (const [bytes, tipo] of casos) {
      await esperarError(
        await subir(supervisor.token, declaradaJpeg.id, bytes, tipo),
        415,
        'EVIDENCIA_TIPO_INVALIDO',
      );
    }
    expect(await env.EVIDENCE.get(`evidencias/${orden}/${declaradaJpeg.id}`)).toBeNull();
    expect(await subidoEnD1(declaradaJpeg.id)).toBe(0);
  });

  it('un sha256 distinto del declarado responde 400 VALIDACION', async () => {
    const declarada = await archivo('image/jpeg', jpeg());
    await declarar(declarada);
    const cuerpo = await esperarError(
      await subir(supervisor.token, declarada.id, jpeg(), 'image/jpeg'),
      400,
      'VALIDACION',
    );
    expect(cuerpo.details).toEqual([{ campo: 'sha256', mensaje: expect.any(String) as string }]);
    expect(await subidoEnD1(declarada.id)).toBe(0);
  });

  it('más de 5 MB → 413, anunciado por Content-Length o leído por streaming', async () => {
    const declarada = await archivo('image/jpeg', jpeg());
    await declarar(declarada);
    const grande = jpeg(MAX_EVIDENCIA_BYTES + 1);
    await esperarError(
      await subir(supervisor.token, declarada.id, grande, 'image/jpeg'),
      413,
      'EVIDENCIA_DEMASIADO_GRANDE',
    );
    // Sin Content-Length (cuerpo en streaming): se corta al pasar el límite.
    const flujo = new ReadableStream<Uint8Array>({
      start(controlador) {
        for (let i = 0; i < 6; i += 1) {
          controlador.enqueue(new Uint8Array(1024 * 1024));
        }
        controlador.close();
      },
    });
    await esperarError(
      await subir(supervisor.token, declarada.id, flujo, 'image/jpeg'),
      413,
      'EVIDENCIA_DEMASIADO_GRANDE',
    );
    expect(await subidoEnD1(declarada.id)).toBe(0);
  });

  it('exactamente 5 MB se acepta', async () => {
    const foto = await archivo('image/jpeg', jpeg(MAX_EVIDENCIA_BYTES));
    await declarar(foto);
    expect((await subir(supervisor.token, foto.id, foto.bytes, 'image/jpeg')).status).toBe(200);
  });

  it('evidencia desconocida → 404 EVIDENCIA_DESCONOCIDA; id inválido → 400', async () => {
    await esperarError(
      await subir(supervisor.token, uuidv7(), jpeg(), 'image/jpeg'),
      404,
      'EVIDENCIA_DESCONOCIDA',
    );
    await esperarError(await subir(supervisor.token, 'x', jpeg(), 'image/jpeg'), 400, 'VALIDACION');
  });

  it('solo quien registró la novedad: otros 403, admin 403, sin sesión 401', async () => {
    const foto = await archivo('image/jpeg', jpeg());
    const { orden } = await declarar(foto);
    await asignar(orden, otroSupervisor.usuario.id, admin.usuario.id);
    for (const token of [otroSupervisor.token, jefe.token, admin.token]) {
      await esperarError(
        await subir(token, foto.id, foto.bytes, 'image/jpeg'),
        403,
        'PERMISO_DENEGADO',
      );
    }
    await esperarError(
      await subir(undefined, foto.id, foto.bytes, 'image/jpeg'),
      401,
      'NO_AUTENTICADO',
    );
    expect(await subidoEnD1(foto.id)).toBe(0);
  });

  it('dos marcas de subida concurrentes: solo una aplica y audita', async () => {
    const foto = await archivo('image/jpeg', jpeg());
    await declarar(foto);
    const fila = await buscarEvidencia(env.DB, foto.id);
    expect(fila).not.toBeNull();
    if (fila === null) {
      return;
    }
    const ctx = await contextoDe('supervisor');
    const primera = planMarcarSubida(ctx, fila);
    const segunda = planMarcarSubida(
      { ...ctx, ahora: new Date(Date.now() + 5).toISOString() },
      fila,
    );
    const antes = await ultimoSeq();
    await ejecutarPlan(env.DB, primera);
    await expect(ejecutarPlan(env.DB, segunda)).rejects.toMatchObject({
      code: 'EVIDENCIA_YA_SUBIDA',
    });
    expect(await auditoriaDesde(antes)).toHaveLength(1);
  });
});

describe('GET /evidences/:id', () => {
  async function subida() {
    const foto = await archivo('image/png', png(2048));
    const esc = await declarar(foto);
    expect((await subir(supervisor.token, foto.id, foto.bytes, 'image/png')).status).toBe(200);
    return { ...esc, foto };
  }

  it('devuelve el archivo con las cabeceras exactas a quien puede ver el consumo', async () => {
    const { orden, foto } = await subida();
    await asignar(orden, otroSupervisor.usuario.id, admin.usuario.id);
    for (const token of [supervisor.token, otroSupervisor.token, jefe.token, admin.token]) {
      const respuesta = await descargar(token, foto.id);
      expect(respuesta.status).toBe(200);
      expect(respuesta.headers.get('Content-Type')).toBe('image/png');
      expect(respuesta.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(respuesta.headers.get('Content-Disposition')).toBe('inline');
      expect(respuesta.headers.get('Cache-Control')).toBe('private, no-store');
      expect(respuesta.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
      expect(new Uint8Array(await respuesta.arrayBuffer())).toEqual(foto.bytes);
    }
  });

  it('404 si no la puede ver, si no está subida o si no existe; 401 sin sesión', async () => {
    const { foto } = await subida();
    await esperarError(await descargar(otroSupervisor.token, foto.id), 404, 'NO_ENCONTRADO');
    const pendiente = await archivo('image/jpeg', jpeg());
    await declarar(pendiente);
    await esperarError(await descargar(supervisor.token, pendiente.id), 404, 'NO_ENCONTRADO');
    await esperarError(await descargar(jefe.token, uuidv7()), 404, 'NO_ENCONTRADO');
    await esperarError(await descargar(undefined, foto.id), 401, 'NO_AUTENTICADO');
  });
});

describe('utilidades', () => {
  it('detectarMime reconoce solo JPEG, PNG y WebP por sus magic bytes', () => {
    expect(detectarMime(jpeg(8))).toBe('image/jpeg');
    expect(detectarMime(png(16))).toBe('image/png');
    expect(detectarMime(webp(16))).toBe('image/webp');
    // RIFF que no es WEBP (por ejemplo WAV) y GIF.
    expect(detectarMime(new TextEncoder().encode('RIFF\0\0\0\0WAVEfmt '))).toBeNull();
    expect(detectarMime(new TextEncoder().encode('GIF89a'))).toBeNull();
    expect(detectarMime(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });

  it('tipoDeContenido normaliza la cabecera; leerCuerpoLimitado acepta un cuerpo vacío', async () => {
    expect(tipoDeContenido('Image/JPEG; charset=binary')).toBe('image/jpeg');
    expect(tipoDeContenido(undefined)).toBeNull();
    expect(tipoDeContenido(' ')).toBeNull();
    expect(await leerCuerpoLimitado(null)).toEqual(new Uint8Array(0));
    const flujo = () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1, 2]));
          c.enqueue(new Uint8Array([3]));
          c.close();
        },
      });
    expect(await leerCuerpoLimitado(flujo(), 3)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await leerCuerpoLimitado(flujo(), 2)).toBeNull();
  });
});
