// Fixtures mínimos y válidos para las pruebas de integridad de D1 (SQL directo sobre la D1 local real).
// Cada función inserta una fila con ids nuevos y devuelve su id, así las pruebas de un mismo archivo
// (que comparten base) no chocan entre sí.
import { uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';

export const ahora = (): string => new Date().toISOString();

type Valores = Record<string, string | number | null>;

/** Sentencia INSERT con parámetros enlazados (sin ejecutar), para usarla en `db.batch()`. */
export function sentenciaInsert(tabla: string, valores: Valores): D1PreparedStatement {
  const columnas = Object.keys(valores);
  const marcadores = columnas.map(() => '?').join(', ');
  return env.DB.prepare(
    `INSERT INTO ${tabla} (${columnas.join(', ')}) VALUES (${marcadores})`,
  ).bind(...Object.values(valores));
}

export async function insertar(tabla: string, valores: Valores): Promise<void> {
  await sentenciaInsert(tabla, valores).run();
}

function marcas(): Valores {
  const t = ahora();
  return { created_at: t, updated_at: t };
}

export async function crearUsuario(rol: 'supervisor' | 'jefe' | 'admin' = 'supervisor') {
  const id = uuidv7();
  await insertar('users', {
    id,
    nombre: `Usuario ${rol}`,
    email: `${id}@catmetal.test`,
    password_hash: 'pbkdf2-sha256$100000$c2Fs$aGFzaA',
    rol,
    ...marcas(),
  });
  return id;
}

export async function crearDispositivo(userId: string) {
  const id = uuidv7();
  await insertar('devices', { id, user_id: userId, nombre: 'Tablet de prueba', ...marcas() });
  return id;
}

export async function crearMaterial() {
  const id = uuidv7();
  await insertar('materials', {
    id,
    codigo: `MAT-${id}`,
    nombre: 'Arena sílice',
    unidad: 'kg',
    costo_unitario_cop: 1200,
    ...marcas(),
  });
  return id;
}

export async function crearOrden(creadaPor: string, estado = 'en_proceso') {
  const id = uuidv7();
  await insertar('production_orders', {
    id,
    codigo: `OP-${id}`,
    linea: 'Moldeo',
    estado,
    creada_por: creadaPor,
    ...marcas(),
  });
  return id;
}

export interface Escenario {
  supervisor: string;
  dispositivo: string;
  jefe: string;
  dispositivoJefe: string;
  material: string;
  orden: string;
}

/** Usuarios, dispositivos, material y orden en proceso listos para registrar consumos. */
export async function crearEscenario(): Promise<Escenario> {
  const supervisor = await crearUsuario('supervisor');
  const jefe = await crearUsuario('jefe');
  const dispositivo = await crearDispositivo(supervisor);
  const dispositivoJefe = await crearDispositivo(jefe);
  const material = await crearMaterial();
  const orden = await crearOrden(jefe);
  return { supervisor, dispositivo, jefe, dispositivoJefe, material, orden };
}

export function valoresConsumo(e: Escenario, extra: Valores = {}): Valores {
  const t = ahora();
  return {
    id: uuidv7(),
    order_id: e.orden,
    material_id: e.material,
    cantidad: 10.5,
    unidad: 'kg',
    cantidad_en_unidad_plan: 10.5,
    lote: 'L-001',
    costo_unitario_cop_snapshot: 1200,
    registrado_por: e.supervisor,
    device_id: e.dispositivo,
    client_created_at: t,
    server_received_at: t,
    ...marcas(),
    ...extra,
  };
}

export async function crearConsumo(e: Escenario, extra: Valores = {}) {
  const valores = valoresConsumo(e, extra);
  await insertar('consumptions', valores);
  return String(valores.id);
}

export function valoresValidacion(
  consumoId: string,
  validadoPor: string,
  decision: 'aprobado' | 'rechazado',
  motivo: string | null = null,
): Valores {
  const t = ahora();
  return {
    id: uuidv7(),
    consumption_id: consumoId,
    decision,
    motivo,
    validado_por: validadoPor,
    client_created_at: t,
    server_received_at: t,
    ...marcas(),
  };
}

/** Sentencia que cambia el estado de un consumo incrementando `version` (como lo hará el Worker). */
export function sentenciaDecidir(consumoId: string, estado: 'aprobado' | 'rechazado') {
  return env.DB.prepare(
    'UPDATE consumptions SET estado = ?, version = version + 1, updated_at = ? WHERE id = ?',
  ).bind(estado, ahora(), consumoId);
}

/** Inserta la validación y cambia el estado en el mismo batch (orden exigido por los triggers). */
export async function decidir(
  consumoId: string,
  validadoPor: string,
  decision: 'aprobado' | 'rechazado',
): Promise<void> {
  const motivo = decision === 'rechazado' ? 'Cantidad mal digitada' : null;
  await env.DB.batch([
    sentenciaInsert('validations', valoresValidacion(consumoId, validadoPor, decision, motivo)),
    sentenciaDecidir(consumoId, decision),
  ]);
}

export async function crearNovedad(consumoId: string, registradoPor: string) {
  const id = uuidv7();
  const t = ahora();
  await insertar('incidents', {
    id,
    consumption_id: consumoId,
    tipo: 'merma',
    descripcion: 'Se derramó material al cargar el horno',
    registrado_por: registradoPor,
    client_created_at: t,
    server_received_at: t,
    ...marcas(),
  });
  return id;
}

export const SHA256_EJEMPLO = 'a'.repeat(64);

export async function crearEvidencia(novedadId: string) {
  const id = uuidv7();
  await insertar('evidences', {
    id,
    incident_id: novedadId,
    storage_key: `evidencias/${id}.jpg`,
    mime: 'image/jpeg',
    tamano_bytes: 2048,
    sha256: SHA256_EJEMPLO,
    ...marcas(),
  });
  return id;
}

export async function crearMutacionSync(userId: string, deviceId: string) {
  const id = uuidv7();
  await insertar('sync_mutations', {
    mutation_id: id,
    user_id: userId,
    device_id: deviceId,
    tipo: 'consumo.crear',
    resultado: 'aplicada',
    respuesta_json: '{"resultado":"aplicada"}',
    procesada_at: ahora(),
    ...marcas(),
  });
  return id;
}

export async function crearAuditoria(extra: Valores = {}) {
  const id = uuidv7();
  await insertar('audit_log', {
    id,
    entidad: 'consumptions',
    entidad_id: uuidv7(),
    accion: 'crear',
    server_at: ahora(),
    ...marcas(),
    ...extra,
  });
  return id;
}
