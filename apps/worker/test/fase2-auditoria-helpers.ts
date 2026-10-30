// Fixtures de la tarea 2.4 (auditoría y reportes): consumos, novedades, evidencias y validaciones
// escritos con SQL directo sobre la D1 local real, cada uno con su fila de auditoría escrita por el
// `sentenciaAuditoria` REAL en el mismo batch (como lo hacen los comandos de dominio). Respetan los
// triggers: el consumo nace pendiente y con version 1, el dispositivo es del autor, decidir es
// insertar en `validations` (el trigger aplica estado y version + 1) y valida un jefe activo.
// No dependen de los endpoints de la tarea 2.2.
import { type Decision, type TipoNovedad, type Unidad, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { sentenciaAuditoria } from '../src/auditoria/auditar';
import { sentenciaInsert } from './fixtures-db';

const t = (): string => new Date().toISOString();

export interface Autor {
  id: string;
  deviceId: string;
}

export interface DatosConsumo {
  orderId: string;
  materialId: string;
  autor: Autor;
  cantidad: number;
  unidad?: Unidad;
  /** Por defecto, igual a `cantidad`. */
  cantidadPlan?: number;
  /** Costo unitario congelado (S12). Por defecto 1500. */
  snapshot?: number;
  lote?: string;
  requiereNovedad?: boolean;
  registroTardio?: boolean;
  corrigeA?: string | null;
  clientAt?: string;
  /** Alerta de reloj de la petición (ADR 0019); ya no se deduce de `clientAt`. */
  alertaReloj?: boolean;
}

export type FilaConsumo = Record<string, string | number | null>;

/** Registra un consumo (pendiente, version 1) con su auditoría `consumo.crear`. */
export async function registrarConsumo(datos: DatosConsumo): Promise<FilaConsumo> {
  const ahora = t();
  const fila: FilaConsumo = {
    id: uuidv7(),
    order_id: datos.orderId,
    material_id: datos.materialId,
    cantidad: datos.cantidad,
    unidad: datos.unidad ?? 'kg',
    cantidad_en_unidad_plan: datos.cantidadPlan ?? datos.cantidad,
    lote: datos.lote ?? 'L-2026-001',
    costo_unitario_cop_snapshot: datos.snapshot ?? 1500,
    registrado_por: datos.autor.id,
    device_id: datos.autor.deviceId,
    client_created_at: datos.clientAt ?? ahora,
    server_received_at: ahora,
    corrige_a: datos.corrigeA ?? null,
    registro_tardio: datos.registroTardio === true ? 1 : 0,
    requiere_novedad: datos.requiereNovedad === true ? 1 : 0,
    created_at: ahora,
    updated_at: ahora,
  };
  const completa = { ...fila, estado: 'pendiente', version: 1 };
  await env.DB.batch([
    sentenciaInsert('consumptions', fila),
    sentenciaAuditoria(env.DB, {
      entidad: 'consumptions',
      entidad_id: String(fila.id),
      accion: 'consumo.crear',
      order_id: datos.orderId,
      actor_id: datos.autor.id,
      device_id: datos.autor.deviceId,
      despues: completa,
      client_at: String(fila.client_created_at),
      server_at: ahora,
      alerta_reloj: datos.alertaReloj === true,
    }),
  ]);
  return completa;
}

/** Registra una novedad del consumo con su auditoría `novedad.crear`. */
export async function registrarNovedad(
  consumo: FilaConsumo,
  autor: Autor,
  tipo: TipoNovedad = 'merma',
  descripcion = 'Se derramó material al cargar el horno',
): Promise<string> {
  const ahora = t();
  const fila = {
    id: uuidv7(),
    consumption_id: String(consumo.id),
    tipo,
    descripcion,
    registrado_por: autor.id,
    client_created_at: ahora,
    server_received_at: ahora,
    created_at: ahora,
    updated_at: ahora,
  };
  await env.DB.batch([
    sentenciaInsert('incidents', fila),
    sentenciaAuditoria(env.DB, {
      entidad: 'incidents',
      entidad_id: fila.id,
      accion: 'novedad.crear',
      order_id: String(consumo.order_id),
      actor_id: autor.id,
      device_id: autor.deviceId,
      despues: fila,
      server_at: ahora,
    }),
  ]);
  return fila.id;
}

/** Metadatos de una evidencia (sin subir) y, si `subir`, la marca de subida, con su auditoría. */
export async function registrarEvidencia(
  novedadId: string,
  orderId: string,
  autor: Autor,
  subir = true,
): Promise<string> {
  const ahora = t();
  const id = uuidv7();
  const fila = {
    id,
    incident_id: novedadId,
    storage_key: `evidencias/${orderId}/${id}`,
    mime: 'image/jpeg',
    tamano_bytes: 2048,
    sha256: 'b'.repeat(64),
    created_at: ahora,
    updated_at: ahora,
  };
  const auditoria = {
    entidad: 'evidences' as const,
    entidad_id: id,
    order_id: orderId,
    actor_id: autor.id,
    device_id: autor.deviceId,
    server_at: ahora,
  };
  const sentencias = [
    sentenciaInsert('evidences', fila),
    sentenciaAuditoria(env.DB, {
      ...auditoria,
      accion: 'novedad.crear',
      despues: { ...fila, subido: 0, subido_at: null },
    }),
  ];
  if (subir) {
    sentencias.push(
      env.DB.prepare(
        'UPDATE evidences SET subido = 1, subido_at = ?, updated_at = ? WHERE id = ?',
      ).bind(ahora, ahora, id),
      sentenciaAuditoria(env.DB, {
        ...auditoria,
        accion: 'evidencia.subida',
        antes: { ...fila, subido: 0, subido_at: null },
        despues: { ...fila, subido: 1, subido_at: ahora },
      }),
    );
  }
  await env.DB.batch(sentencias);
  return id;
}

/**
 * Decide un consumo como lo hará la tarea 2.3: INSERT en `validations` (el trigger aplica estado y
 * version + 1), auditoría de la validación y del consumo (antes/después), en un batch.
 */
export async function decidirConsumo(
  consumo: FilaConsumo,
  jefe: Autor,
  decision: Decision,
  motivo: string | null = decision === 'rechazado' ? 'Cantidad mal digitada' : null,
): Promise<string> {
  const ahora = t();
  const fila = {
    id: uuidv7(),
    consumption_id: String(consumo.id),
    decision,
    motivo,
    validado_por: jefe.id,
    client_created_at: ahora,
    server_received_at: ahora,
    created_at: ahora,
    updated_at: ahora,
  };
  const comun = {
    order_id: String(consumo.order_id),
    actor_id: jefe.id,
    device_id: jefe.deviceId,
    server_at: ahora,
  };
  await env.DB.batch([
    sentenciaInsert('validations', fila),
    sentenciaAuditoria(env.DB, {
      ...comun,
      entidad: 'validations',
      entidad_id: fila.id,
      accion: decision === 'aprobado' ? 'consumo.aprobar' : 'consumo.rechazar',
      despues: fila,
    }),
    sentenciaAuditoria(env.DB, {
      ...comun,
      entidad: 'consumptions',
      entidad_id: String(consumo.id),
      accion: decision === 'aprobado' ? 'consumo.aprobar' : 'consumo.rechazar',
      antes: consumo,
      despues: {
        ...consumo,
        estado: decision,
        version: Number(consumo.version) + 1,
        updated_at: ahora,
      },
    }),
  ]);
  return fila.id;
}

/** Cambia el nombre de un usuario (para las descripciones de la línea de tiempo y el CSV). */
export async function renombrar(userId: string, nombre: string): Promise<void> {
  await env.DB.prepare('UPDATE users SET nombre = ? WHERE id = ?').bind(nombre, userId).run();
}

/** Material con código y nombre propios. */
export async function materialConNombre(
  nombre: string,
  unidad: Unidad,
  costo: number,
): Promise<{ id: string; codigo: string }> {
  const id = uuidv7();
  const ahora = t();
  const codigo = `MP-${id.slice(-8)}`;
  await sentenciaInsert('materials', {
    id,
    codigo,
    nombre,
    unidad,
    costo_unitario_cop: costo,
    activo: 1,
    created_at: ahora,
    updated_at: ahora,
  }).run();
  return { id, codigo };
}
