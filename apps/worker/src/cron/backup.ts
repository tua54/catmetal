// Backup diario paginado de D1 a R2 (spec §2 y §4 "Backups"; ADR 0014, enmendada por las ADR 0016,
// 0020 y 0021; revisión del esquema H9 y revisión de la Fase 3 A3).
//
// Formato en R2 (bucket privado `BACKUPS`, propio de los backups y separado de las evidencias por la
// F6-08 de docs/auditoria/seguridad-fase-6.md; prefijo `backups/`, retención de 90 días por regla de
// ciclo de vida sobre ese prefijo):
//
//   backups/AAAA-MM-DD/<tabla>.ndjson.gz   una línea JSON por fila, todas las columnas, gzip
//   backups/AAAA-MM-DD/manifest.json       solo existe si el backup del día TERMINÓ (completo o parcial)
//   backups/AAAA-MM-DD/progreso.json       estado de reanudación; se borra al escribir el manifest
//   backups/AAAA-MM-DD/_parciales/*.bin    bytes comprimidos aún no subidos de la tabla en curso
//
// Decisiones (detalle en las ADR y en docs/despliegue.md):
//
// - Fecha: día UTC del MOMENTO DE EJECUCIÓN (no `scheduledTime`). Los crons corren de 08:00 a 13:00
//   UTC, lejos de la medianoche, así que ambos coinciden; un reintento manual del mismo día continúa
//   el mismo backup.
// - Marca de corte (ADR 0021): al iniciar se toman `corte_at` (hora) y `C = MAX(audit_log.seq)`. El
//   backup permite reconstruir el estado exacto en `C` (scripts/restauracion-nucleo.mjs). Para eso
//   `audit_log` se exporta AL FINAL, acotada a `seq <= seq_final` (MAX(seq) al empezarla).
// - Paginación por PK (`seq > ?`, `id > ?`, `(a, b) > (?, ?)`, `clave > ?`), acotada por FILAS
//   (`TAMANO_PAGINA`) y por BYTES (`MAX_BYTES_PAGINA`, ADR 0020): D1 mide cada fila con
//   `octet_length` en una ventana de `filas_medicion` filas (adaptativa, para que SQLite tampoco lea
//   de más) y devuelve solo las que caben. No se usa la exportación nativa de D1 (bloquea las demás
//   consultas).
// - Compresión con `CompressionStream('gzip')` en streaming, escribiendo cada página en trozos de
//   `TAMANO_TROZO_BYTES`. Los bytes comprimidos se suben con multipart upload de R2 en partes de
//   5 MiB exactos (R2 exige que todas las partes salvo la última midan lo mismo y al menos 5 MiB); si
//   la tabla cabe en menos de una parte se sube con un `put` simple. Así la memoria queda acotada a
//   ~1 página + 1 parte.
// - Reanudación: si el presupuesto (consultas a D1, operaciones de R2 o tiempo) se agota a mitad de
//   una tabla, se cierra el miembro gzip actual, los bytes que no completan una parte van a
//   `_parciales/` y el cursor, las partes subidas y el `uploadId` a `progreso.json`. La siguiente
//   invocación DEL MISMO DÍA abre un miembro gzip nuevo y continúa. El archivo final es entonces un
//   gzip de varios miembros (RFC 1952 §2.2): `gzip -d`, `zcat` y `zlib` de Node lo leen completo; el
//   `DecompressionStream` de workerd NO (rechaza bytes tras el primer miembro), por eso el manifest
//   lista en `segmentos_gzip` el desplazamiento de inicio de cada miembro.
// - Aislamiento (ADR 0020): cada intento de exportar una tabla se cuenta ANTES de empezar (así cuenta
//   también una invocación que muere sin pasar por el `catch`, por memoria o CPU). Una tabla con
//   `MAX_INTENTOS_TABLA` intentos sin avance queda `incompleta` y el backup sigue con las demás. El
//   manifest se escribe cuando todas están `completa` o `incompleta`; con alguna incompleta el
//   backup es `parcial`.
// - sha256 y bytes: se calculan RELEYENDO de R2 el objeto ya escrito (`crypto.DigestStream`), es
//   decir, describen exactamente lo almacenado, aunque se haya escrito en varias invocaciones.
// - Idempotencia: si existe el manifest del día, no se hace nada.
// - Continuaciones (ADR 0016): el cron `0 8 * * *` inicia el backup del día y `0 9-13 * * *` lo
//   continúa cada hora (modo `continuacion`: nunca inicia uno nuevo; sin `progreso.json` no hace
//   nada). Un día sin manifest está SIN TERMINAR y no se usa para restaurar; si la continuación de
//   las 13:00 UTC termina sin manifest, `ejecutarCron` registra el error `backup_incompleto_del_dia`.
// - Concurrencia: `progreso.json` lleva un arriendo (`en_curso_hasta`) para que dos invocaciones
//   solapadas no escriban a la vez. Es de mejor esfuerzo (R2 no se usa aquí con escritura condicional).

import { registrar } from '../log';
import { describirError } from './errores';
import { Presupuesto, type Reserva } from './presupuesto';
import { TABLAS_BACKUP, type TablaBackup } from './tablas';

export const PREFIJO_BACKUPS = 'backups/';
/** Filas máximas por página (ADR 0016). */
export const TAMANO_PAGINA = 2000;
/**
 * Bytes máximos por página, medidos en SQL con `octet_length` (ADR 0020). Una página pesa como mucho
 * esto más una fila (una fila de D1 mide como mucho ~2 MB).
 */
export const MAX_BYTES_PAGINA = 4 * 1024 * 1024;
/** Filas que mide la ventana inicial de cada tabla (crece hasta `TAMANO_PAGINA`; ADR 0020). */
export const MIN_FILAS_MEDICION = 64;
/** Tamaño de los trozos de NDJSON que se escriben al compresor. */
export const TAMANO_TROZO_BYTES = 1024 * 1024;
/** Intentos sin avance de una tabla antes de marcarla `incompleta` (ADR 0020). */
export const MAX_INTENTOS_TABLA = 3;
/** Mínimo de R2 para las partes de un multipart upload (salvo la última). */
export const TAMANO_PARTE_BYTES = 5 * 1024 * 1024;
/** Motivo de una tabla incompleta cuyos intentos murieron sin un error capturado. */
export const MOTIVO_SIN_ERROR = 'invocación interrumpida sin error capturado';

/** Prefijo de las columnas auxiliares de la consulta de página (nunca es de una columna real). */
const PREFIJO_AUXILIAR = '__bk_';

/**
 * Operaciones reservadas para cerrar ordenadamente: guardar el parcial y el progreso, o completar
 * la subida, releer el objeto y guardar el progreso; más margen para el mantenimiento del cron.
 */
const RESERVA: Reserva = {
  // R2: guardar el parcial y el progreso, o completar la subida, releer el objeto y guardar el
  // progreso, más el manifest y el borrado del progreso.
  r2: 6,
  // D1: `MAX(seq)` al empezar `audit_log` y el mantenimiento del cron (conteos y purga).
  d1: 20,
};
/** Margen del arriendo sobre el tiempo máximo de la invocación. */
const MARGEN_ARRIENDO_MS = 60_000;

type ValorPk = string | number;
type Fila = Record<string, unknown>;

/** Entrada del manifest de una tabla exportada entera. */
export interface ArchivoBackup {
  tabla: string;
  estado: 'completa';
  /** Nombre del objeto dentro de `backups/AAAA-MM-DD/`. */
  archivo: string;
  filas: number;
  /** Tamaño del objeto comprimido en R2. */
  bytes: number;
  /** sha256 (hex) del objeto comprimido tal como quedó en R2. */
  sha256: string;
  /** Desplazamiento de inicio de cada miembro gzip (uno por invocación que escribió la tabla). */
  segmentos_gzip: number[];
}

/** Entrada del manifest de una tabla que falló de forma persistente (ADR 0020). Sin archivo. */
export interface TablaIncompleta {
  tabla: string;
  estado: 'incompleta';
  /** Mensaje técnico del último error (sin datos personales) o `MOTIVO_SIN_ERROR`. */
  motivo: string;
  intentos: number;
}

export type EntradaManifest = ArchivoBackup | TablaIncompleta;

export interface ManifestBackup {
  formato: 2;
  /** `parcial` si alguna tabla quedó `incompleta` (ADR 0020). */
  estado: 'completo' | 'parcial';
  fecha: string;
  generado_at: string;
  /** `settings.sync_epoca` al empezar (ADR 0009). Al restaurar se cambia por una nueva. */
  epoca: string | null;
  /** Marca de corte (ADR 0021): `MAX(audit_log.seq)` al empezar y la hora justo antes de leerlo. */
  corte: { seq: number; at: string };
  /** = `corte.seq` (compatibilidad con la ADR 0016). */
  seq_inicial: number;
  /** `MAX(audit_log.seq)` al empezar a exportar `audit_log`: su archivo tiene los seq 1..seq_final. */
  seq_final: number;
  /** Última migración aplicada (`d1_migrations.name`): versión del esquema. */
  ultima_migracion: string | null;
  /** En orden de exportación (`TABLAS_BACKUP`). */
  tablas: EntradaManifest[];
}

interface TablaEnCurso {
  tabla: string;
  /** Valores de la PK de la última fila exportada; null si aún no se exportó ninguna. */
  cursor: ValorPk[] | null;
  filas: number;
  /** Ventana de medición de la próxima página (ADR 0020). */
  filas_medicion: number;
  upload_id: string | null;
  partes: R2UploadedPart[];
  /** Objeto con los bytes comprimidos que todavía no completan una parte. */
  parcial: string | null;
  segmentos_gzip: number[];
}

interface ProgresoBackup {
  formato: 2;
  fecha: string;
  iniciado_at: string;
  corte_at: string;
  epoca: string | null;
  seq_inicial: number;
  /** null hasta que empieza la exportación de `audit_log` (ADR 0021). */
  seq_final: number | null;
  ultima_migracion: string | null;
  invocaciones: number;
  terminadas: EntradaManifest[];
  en_curso: TablaEnCurso | null;
  /** Intentos sin avance de cada tabla aún no terminada (ADR 0020). */
  intentos: Record<string, number>;
  /** Último error capturado de cada tabla aún no terminada (motivo si queda incompleta). */
  motivos: Record<string, string>;
  /** Arriendo de la invocación activa; null cuando ninguna está trabajando. */
  en_curso_hasta: string | null;
}

/**
 * `inicio`: el cron de las 08:00 UTC empieza (o continúa) el backup del día. `continuacion`: los
 * crons horarios de 09:00 a 13:00 UTC solo continúan uno empezado; si no hay `progreso.json` no
 * hacen nada (`sin_iniciar`) y, si ya hay manifest, tampoco (`ya_existia`).
 */
export type ModoBackup = 'inicio' | 'continuacion';

/** Lo que ve el medidor de cada página (ADR 0020, punto 5). */
export interface InfoPagina {
  tabla: string;
  filas: number;
  /** Bytes UTF-8 del NDJSON de la página: lo que la página ocupó en memoria del Worker. */
  bytesNdjson: number;
  /** Filas que midió la ventana de la consulta. */
  filasMedicion: number;
}

export interface OpcionesBackup {
  presupuesto?: Presupuesto;
  /** Por defecto, `inicio`. */
  modo?: ModoBackup;
  /** Filas por consulta (`TAMANO_PAGINA`; inyectable solo para pruebas). */
  tamanoPagina?: number;
  /** Bytes por página (`MAX_BYTES_PAGINA`; inyectable solo para pruebas). */
  maxBytesPagina?: number;
  /** Bytes de cada parte del multipart upload (≥ 5 MiB en R2). */
  tamanoParteBytes?: number;
  /** Medidor de páginas (solo pruebas). */
  observarPagina?: (info: InfoPagina) => void;
  /** Inyección de fallos (solo pruebas): se llama antes de cada página y, si lanza, falla la tabla. */
  fallarEn?: (tabla: string) => void;
}

interface ResumenTerminado {
  fecha: string;
  tablas: number;
  filas: number;
  bytes: number;
  operaciones: number;
}

export type ResultadoBackup =
  | { estado: 'ya_existia'; fecha: string }
  | { estado: 'sin_iniciar'; fecha: string }
  | { estado: 'en_curso_en_otra_invocacion'; fecha: string }
  | {
      estado: 'pausado';
      fecha: string;
      tablas_terminadas: number;
      tabla_en_curso: string;
      operaciones: number;
    }
  | ({ estado: 'completo' } & ResumenTerminado)
  | ({ estado: 'parcial'; tablas_incompletas: string[] } & ResumenTerminado);

/** `AAAA-MM-DD` en UTC. */
export function fechaBackup(ahora: Date): string {
  return ahora.toISOString().slice(0, 10);
}

export function prefijoDelDia(fecha: string): string {
  return `${PREFIJO_BACKUPS}${fecha}/`;
}

export function archivoDeTabla(tabla: string): string {
  return `${tabla}.ndjson.gz`;
}

export async function ejecutarBackup(
  env: Env,
  ahora: Date,
  opciones: OpcionesBackup = {},
): Promise<ResultadoBackup> {
  const presupuesto = opciones.presupuesto ?? new Presupuesto();
  const config: Config = {
    tamanoPagina: opciones.tamanoPagina ?? TAMANO_PAGINA,
    maxBytesPagina: opciones.maxBytesPagina ?? MAX_BYTES_PAGINA,
    tamanoParte: opciones.tamanoParteBytes ?? TAMANO_PARTE_BYTES,
    observarPagina: opciones.observarPagina,
    fallarEn: opciones.fallarEn,
  };
  // Todo lo del backup (tablas, manifest, progreso y parciales) va al bucket BACKUPS; EVIDENCE queda
  // solo para las fotos (F6-08).
  const bucket = env.BACKUPS;
  const fecha = fechaBackup(ahora);
  const base = prefijoDelDia(fecha);
  const claveManifest = `${base}manifest.json`;
  const claveProgreso = `${base}progreso.json`;

  presupuesto.consumirR2();
  if ((await bucket.head(claveManifest)) !== null) {
    return { estado: 'ya_existia', fecha };
  }

  presupuesto.consumirR2();
  const guardado = await bucket.get(claveProgreso);
  if (guardado === null && opciones.modo === 'continuacion') {
    return { estado: 'sin_iniciar', fecha };
  }
  let progreso: ProgresoBackup;
  if (guardado === null) {
    progreso = await iniciarProgreso(env.DB, fecha, ahora, presupuesto);
  } else {
    const leido = await guardado.json<ProgresoBackup | { formato?: unknown }>();
    if (leido.formato !== 2) {
      // Un progreso de otro formato (despliegue a mitad de un backup): se empieza de nuevo.
      registrar('aviso', 'backup_progreso_descartado', { fecha, formato: String(leido.formato) });
      progreso = await iniciarProgreso(env.DB, fecha, ahora, presupuesto);
    } else {
      progreso = leido as ProgresoBackup;
      if (
        progreso.en_curso_hasta !== null &&
        Date.parse(progreso.en_curso_hasta) > ahora.getTime()
      ) {
        return { estado: 'en_curso_en_otra_invocacion', fecha };
      }
    }
  }

  const guardarProgreso = async (): Promise<void> => {
    presupuesto.consumirR2();
    await bucket.put(claveProgreso, JSON.stringify(progreso), {
      httpMetadata: { contentType: 'application/json' },
    });
  };
  const borrarParcial = async (clave: string | null): Promise<void> => {
    if (clave !== null) {
      presupuesto.consumirR2();
      await bucket.delete(clave);
    }
  };
  /** La tabla agotó sus intentos: queda `incompleta` y el backup sigue con las demás. */
  const marcarIncompleta = async (tabla: string, intentos: number): Promise<void> => {
    const motivo = progreso.motivos[tabla] ?? MOTIVO_SIN_ERROR;
    const parcial = progreso.en_curso?.tabla === tabla ? progreso.en_curso.parcial : null;
    progreso.terminadas.push({ tabla, estado: 'incompleta', motivo, intentos });
    progreso.en_curso = null;
    delete progreso.intentos[tabla];
    delete progreso.motivos[tabla];
    await guardarProgreso();
    await borrarParcial(parcial);
    registrar('error', 'backup_tabla_incompleta', { fecha, tabla, intentos, motivo });
  };
  const pausa = (tabla: string): ResultadoBackup => ({
    estado: 'pausado',
    fecha,
    tablas_terminadas: progreso.terminadas.length,
    tabla_en_curso: tabla,
    operaciones: presupuesto.usadas,
  });

  progreso.invocaciones += 1;
  progreso.en_curso_hasta = new Date(
    ahora.getTime() + presupuesto.maxMs + MARGEN_ARRIENDO_MS,
  ).toISOString();
  await guardarProgreso();

  const terminadas = new Set(progreso.terminadas.map((entrada) => entrada.tabla));
  for (const tabla of TABLAS_BACKUP) {
    if (terminadas.has(tabla.nombre)) {
      continue;
    }
    const previos = progreso.intentos[tabla.nombre] ?? 0;
    if (previos >= MAX_INTENTOS_TABLA) {
      await marcarIncompleta(tabla.nombre, previos);
      continue;
    }
    if (!presupuesto.disponible(RESERVA)) {
      progreso.en_curso_hasta = null;
      await guardarProgreso();
      return pausa(tabla.nombre);
    }
    if (tabla.acotadaPorSeqFinal === true && progreso.seq_final === null) {
      presupuesto.consumirD1();
      progreso.seq_final = await maxSeq(env.DB);
    }
    const estado =
      progreso.en_curso?.tabla === tabla.nombre ? progreso.en_curso : estadoNuevo(tabla.nombre);
    progreso.en_curso = estado;
    // El intento se cuenta y se persiste ANTES de exportar (ADR 0020): si la invocación muere ahí
    // dentro sin pasar por el catch, el intento ya quedó contado.
    progreso.intentos[tabla.nombre] = previos + 1;
    await guardarProgreso();
    // El parcial que referencia el progreso guardado: se borra solo DESPUÉS de guardar el nuevo
    // progreso, para que un corte a mitad de camino nunca deje el progreso apuntando a la nada.
    const parcialAnterior = estado.parcial;
    const filasAntes = estado.filas;

    let resultado: ArchivoBackup | 'pausada';
    try {
      resultado = await exportarTabla(
        bucket,
        env.DB,
        base,
        tabla,
        estado,
        presupuesto,
        config,
        progreso.seq_final,
      );
    } catch (error) {
      // La tabla se reinicia desde cero en el siguiente intento (su subida queda abandonada: R2
      // aborta los multipart incompletos a los 7 días y la regla de ciclo de vida borra el resto).
      progreso.en_curso = null;
      progreso.motivos[tabla.nombre] = describirError(error);
      if (previos + 1 >= MAX_INTENTOS_TABLA) {
        await marcarIncompleta(tabla.nombre, previos + 1);
        await borrarParcial(parcialAnterior);
        continue;
      }
      progreso.en_curso_hasta = null;
      await guardarProgreso();
      await borrarParcial(parcialAnterior);
      throw error;
    }

    if (resultado === 'pausada') {
      // Una tabla grande que avanza entre invocaciones no es un fallo; una pausa sin avance (el
      // presupuesto se agotó antes de la primera página) tampoco cuenta.
      progreso.intentos[tabla.nombre] = estado.filas > filasAntes ? 0 : previos;
      progreso.en_curso_hasta = null;
      await guardarProgreso();
      if (parcialAnterior !== estado.parcial) {
        await borrarParcial(parcialAnterior);
      }
      return pausa(tabla.nombre);
    }

    progreso.terminadas.push(resultado);
    progreso.en_curso = null;
    delete progreso.intentos[tabla.nombre];
    delete progreso.motivos[tabla.nombre];
    await guardarProgreso();
    await borrarParcial(parcialAnterior);
  }

  const incompletas = progreso.terminadas
    .filter((entrada) => entrada.estado === 'incompleta')
    .map((entrada) => entrada.tabla);
  const manifest: ManifestBackup = {
    formato: 2,
    estado: incompletas.length > 0 ? 'parcial' : 'completo',
    fecha,
    generado_at: new Date().toISOString(),
    epoca: progreso.epoca,
    corte: { seq: progreso.seq_inicial, at: progreso.corte_at },
    seq_inicial: progreso.seq_inicial,
    seq_final: progreso.seq_final ?? progreso.seq_inicial,
    ultima_migracion: progreso.ultima_migracion,
    tablas: progreso.terminadas,
  };
  presupuesto.consumirR2();
  await bucket.put(claveManifest, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });
  presupuesto.consumirR2();
  await bucket.delete(claveProgreso);

  const completas = manifest.tablas.filter(
    (entrada): entrada is ArchivoBackup => entrada.estado === 'completa',
  );
  const resumen: ResumenTerminado = {
    fecha,
    tablas: manifest.tablas.length,
    filas: completas.reduce((total, archivo) => total + archivo.filas, 0),
    bytes: completas.reduce((total, archivo) => total + archivo.bytes, 0),
    operaciones: presupuesto.usadas,
  };
  return incompletas.length > 0
    ? { estado: 'parcial', ...resumen, tablas_incompletas: incompletas }
    : { estado: 'completo', ...resumen };
}

interface Config {
  tamanoPagina: number;
  maxBytesPagina: number;
  tamanoParte: number;
  observarPagina: ((info: InfoPagina) => void) | undefined;
  fallarEn: ((tabla: string) => void) | undefined;
}

function estadoNuevo(tabla: string): TablaEnCurso {
  return {
    tabla,
    cursor: null,
    filas: 0,
    filas_medicion: MIN_FILAS_MEDICION,
    upload_id: null,
    partes: [],
    parcial: null,
    segmentos_gzip: [],
  };
}

async function maxSeq(db: D1Database): Promise<number> {
  const fila = await db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS valor FROM audit_log')
    .first<{ valor: number }>();
  return Number(fila?.valor ?? 0);
}

/** Corte, época y última migración en un solo batch (cuenta como una consulta). */
async function iniciarProgreso(
  db: D1Database,
  fecha: string,
  ahora: Date,
  presupuesto: Presupuesto,
): Promise<ProgresoBackup> {
  // La hora del corte se toma JUSTO ANTES de leer `MAX(seq)` (ADR 0021): toda escritura posterior
  // al corte se procesó (su `ahora`) después de esta hora, salvo el margen que aplica la restauración.
  const corteAt = new Date().toISOString();
  presupuesto.consumirD1();
  const [seq, epoca, migracion] = await db.batch([
    db.prepare('SELECT COALESCE(MAX(seq), 0) AS valor FROM audit_log'),
    db.prepare("SELECT valor FROM settings WHERE clave = 'sync_epoca'"),
    db.prepare('SELECT name AS valor FROM d1_migrations ORDER BY id DESC LIMIT 1'),
  ]);
  return {
    formato: 2,
    fecha,
    iniciado_at: ahora.toISOString(),
    corte_at: corteAt,
    epoca: epocaDe(primerValor(epoca)),
    seq_inicial: Number(primerValor(seq) ?? 0),
    seq_final: null,
    ultima_migracion: textoONulo(primerValor(migracion)),
    invocaciones: 0,
    terminadas: [],
    en_curso: null,
    intentos: {},
    motivos: {},
    en_curso_hasta: null,
  };
}

function primerValor(resultado: D1Result | undefined): unknown {
  const fila = resultado?.results[0] as { valor?: unknown } | undefined;
  return fila?.valor ?? null;
}

function textoONulo(valor: unknown): string | null {
  return typeof valor === 'string' ? valor : null;
}

/** `settings.valor` es JSON; la época es una cadena JSON. Sin fila o inválida → null. */
function epocaDe(valor: unknown): string | null {
  if (typeof valor !== 'string') {
    return null;
  }
  try {
    return textoONulo(JSON.parse(valor));
  } catch {
    return null;
  }
}

/**
 * Página de la tabla: filas con PK mayor que `cursor`, en orden de PK, como mucho `filas` y como
 * mucho `maxBytes` (más una fila: la primera siempre entra, así una fila mayor que la cota no
 * bloquea la tabla). El tamaño se mide en SQL con `octet_length` sobre todas las columnas, más el
 * envoltorio JSON de cada nombre (ADR 0020). Las tablas temporales del CTE solo llevan PK y enteros.
 *
 * Cada fila trae dos columnas auxiliares: `__bk_total` (filas que midió la ventana) y `__bk_n`
 * (filas que entraron). Se quitan con `sinColumnasAuxiliares` antes de serializar.
 */
export function sentenciaPagina(
  db: D1Database,
  tabla: TablaBackup,
  cursor: readonly ValorPk[] | null,
  filas: number,
  maxBytes: number = MAX_BYTES_PAGINA,
  seqFinal: number | null = null,
): D1PreparedStatement {
  const orden = tabla.pk.join(', ');
  const descendente = tabla.pk.map((columna) => `${columna} DESC`).join(', ');
  const condiciones: string[] = [];
  const parametros: ValorPk[] = [];
  if (cursor !== null) {
    condiciones.push(
      tabla.pk.length === 1
        ? `${orden} > ?`
        : `(${orden}) > (${tabla.pk.map(() => '?').join(', ')})`,
    );
    parametros.push(...cursor);
  }
  if (tabla.acotadaPorSeqFinal === true && seqFinal !== null) {
    condiciones.push('seq <= ?');
    parametros.push(seqFinal);
  }
  const donde = condiciones.length > 0 ? `WHERE ${condiciones.join(' AND ')}` : '';
  const tamano = tabla.columnas
    .map((columna) => `COALESCE(octet_length(${columna}), 0)`)
    .join(' + ');
  // `{}` y salto de línea, más `"nombre":` y la coma de cada columna (las comillas de un texto
  // quedan dentro del margen de 6 bytes por columna).
  const envoltorio = tabla.columnas.reduce((total, columna) => total + columna.length + 6, 3);
  const corte =
    tabla.pk.length === 1
      ? `${orden} <= (SELECT ${orden} FROM __bk_corte)`
      : `(${orden}) <= (SELECT ${orden} FROM __bk_corte)`;
  const sql = `WITH __bk_tam AS (
    SELECT ${orden}, (${tamano}) + ${String(envoltorio)} AS __bk_b
    FROM ${tabla.nombre} ${donde} ORDER BY ${orden} LIMIT ?
  ), __bk_acum AS (
    SELECT ${orden}, SUM(__bk_b) OVER (ORDER BY ${orden} ROWS UNBOUNDED PRECEDING) - __bk_b AS __bk_antes,
      COUNT(*) OVER () AS __bk_tot
    FROM __bk_tam
  ), __bk_corte AS (
    SELECT ${orden} FROM __bk_acum WHERE __bk_antes < ? ORDER BY ${descendente} LIMIT 1
  )
  SELECT t.*, (SELECT __bk_tot FROM __bk_acum LIMIT 1) AS __bk_total,
    (SELECT COUNT(*) FROM __bk_acum WHERE __bk_antes < ?) AS __bk_n
  FROM ${tabla.nombre} AS t
  WHERE ${[...condiciones, corte].join(' AND ')}
  ORDER BY ${orden}`;
  return db.prepare(sql).bind(...parametros, filas, maxBytes, maxBytes, ...parametros);
}

/** La fila sin las columnas auxiliares de `sentenciaPagina`. */
export function sinColumnasAuxiliares(fila: Fila): Fila {
  return Object.fromEntries(
    Object.entries(fila).filter(([columna]) => !columna.startsWith(PREFIJO_AUXILIAR)),
  );
}

function cursorDe(tabla: TablaBackup, fila: Fila): ValorPk[] {
  return tabla.pk.map((columna) => {
    const valor = fila[columna];
    if (typeof valor !== 'string' && typeof valor !== 'number') {
      throw new Error(`PK inesperada en ${tabla.nombre}.${columna}`);
    }
    return valor;
  });
}

const codificador = new TextEncoder();

function unir(trozos: readonly Uint8Array[], total: number): Uint8Array {
  const salida = new Uint8Array(total);
  let escritos = 0;
  for (const trozo of trozos) {
    salida.set(trozo, escritos);
    escritos += trozo.length;
  }
  return salida;
}

/**
 * Escribe la página al compresor fila por fila, en trozos de hasta `TAMANO_TROZO_BYTES` (ADR 0020):
 * nunca se arma la página entera como un solo texto. Devuelve los bytes de NDJSON escritos.
 */
async function escribirPagina(
  escritor: WritableStreamDefaultWriter<Uint8Array>,
  filas: readonly Fila[],
): Promise<number> {
  let trozos: Uint8Array[] = [];
  let enTrozo = 0;
  let total = 0;
  for (const fila of filas) {
    const linea = codificador.encode(`${JSON.stringify(sinColumnasAuxiliares(fila))}\n`);
    trozos.push(linea);
    enTrozo += linea.length;
    total += linea.length;
    if (enTrozo >= TAMANO_TROZO_BYTES) {
      await escritor.write(unir(trozos, enTrozo));
      trozos = [];
      enTrozo = 0;
    }
  }
  if (enTrozo > 0) {
    await escritor.write(unir(trozos, enTrozo));
  }
  return total;
}

/**
 * Exporta (o continúa) una tabla. Devuelve su entrada del manifest si la terminó, o `'pausada'` si
 * el presupuesto se agotó (el estado queda en `estado`, listo para guardarse en el progreso).
 */
async function exportarTabla(
  bucket: R2Bucket,
  db: D1Database,
  base: string,
  tabla: TablaBackup,
  estado: TablaEnCurso,
  presupuesto: Presupuesto,
  config: Config,
  seqFinal: number | null,
): Promise<ArchivoBackup | 'pausada'> {
  const reserva = RESERVA;
  if (!presupuesto.disponible(reserva)) {
    return 'pausada';
  }

  const clave = `${base}${archivoDeTabla(tabla.nombre)}`;
  const subida = await SubidaPorPartes.abrir(bucket, clave, base, estado, config, presupuesto);
  estado.segmentos_gzip.push(subida.bytesTotales);

  const minimo = Math.min(MIN_FILAS_MEDICION, config.tamanoPagina);
  const gzip = new CompressionStream('gzip');
  const escritor = gzip.writable.getWriter();
  const lectura = subida.consumir(gzip.readable);
  let terminada = false;
  try {
    while (presupuesto.disponible(reserva)) {
      config.fallarEn?.(tabla.nombre);
      const ventana = Math.min(Math.max(estado.filas_medicion, minimo), config.tamanoPagina);
      presupuesto.consumirD1();
      const { results } = await sentenciaPagina(
        db,
        tabla,
        estado.cursor,
        ventana,
        config.maxBytesPagina,
        seqFinal,
      ).all<Fila>();
      const ultima = results.at(-1);
      if (ultima === undefined) {
        terminada = true;
        break;
      }
      const medidas = Number(ultima.__bk_total);
      const bytesNdjson = await escribirPagina(escritor, results);
      config.observarPagina?.({
        tabla: tabla.nombre,
        filas: results.length,
        bytesNdjson,
        filasMedicion: ventana,
      });
      estado.filas += results.length;
      estado.cursor = cursorDe(tabla, ultima);
      const cortadaPorBytes = results.length < medidas;
      if (!cortadaPorBytes && medidas < ventana) {
        terminada = true;
        break;
      }
      estado.filas_medicion = cortadaPorBytes
        ? Math.min(Math.max(2 * results.length, minimo), config.tamanoPagina)
        : Math.min(2 * ventana, config.tamanoPagina);
    }
    await escritor.close();
  } catch (error) {
    await escritor.abort(error).catch(() => undefined);
    // Si falló la subida, el error útil es el de la lectura (la escritura solo ve el stream roto).
    const errorLectura = await lectura.then(
      () => null,
      (motivo: unknown) => motivo,
    );
    throw errorLectura ?? error;
  }
  await lectura;

  if (!terminada) {
    await subida.pausar();
    return 'pausada';
  }

  await subida.terminar();
  const { bytes, sha256 } = await resumirObjeto(bucket, clave, presupuesto);
  return {
    tabla: tabla.nombre,
    estado: 'completa',
    archivo: archivoDeTabla(tabla.nombre),
    filas: estado.filas,
    bytes,
    sha256,
    segmentos_gzip: estado.segmentos_gzip,
  };
}

/**
 * Sumidero de bytes comprimidos hacia R2: acumula hasta completar partes de tamaño fijo y las sube
 * con multipart upload; el resto se sube con `put` (si nunca hubo partes) o como última parte.
 */
class SubidaPorPartes {
  private trozos: Uint8Array[] = [];
  private enMemoria = 0;
  private subida: R2MultipartUpload | null = null;

  private constructor(
    private readonly bucket: R2Bucket,
    private readonly clave: string,
    private readonly base: string,
    private readonly estado: TablaEnCurso,
    private readonly config: Config,
    private readonly presupuesto: Presupuesto,
  ) {}

  static async abrir(
    bucket: R2Bucket,
    clave: string,
    base: string,
    estado: TablaEnCurso,
    config: Config,
    presupuesto: Presupuesto,
  ): Promise<SubidaPorPartes> {
    const subida = new SubidaPorPartes(bucket, clave, base, estado, config, presupuesto);
    if (estado.parcial !== null) {
      presupuesto.consumirR2();
      const objeto = await bucket.get(estado.parcial);
      if (objeto === null) {
        throw new Error(`Falta el parcial del backup de ${estado.tabla}`);
      }
      subida.agregarEnMemoria(new Uint8Array(await objeto.arrayBuffer()));
    }
    return subida;
  }

  /** Bytes comprimidos escritos hasta ahora en el archivo (subidos + en memoria). */
  get bytesTotales(): number {
    return this.estado.partes.length * this.config.tamanoParte + this.enMemoria;
  }

  /** Lee el stream comprimido hasta el final, subiendo cada parte completa. */
  async consumir(stream: ReadableStream<Uint8Array>): Promise<void> {
    const lector = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await lector.read();
        if (done) {
          return;
        }
        this.agregarEnMemoria(value);
        while (this.enMemoria >= this.config.tamanoParte) {
          await this.subirParte(this.extraer(this.config.tamanoParte));
        }
      }
    } catch (error) {
      // Cancelar el lado legible rompe el escribible: la escritura pendiente falla y no se cuelga.
      await lector.cancel(error).catch(() => undefined);
      throw error;
    }
  }

  /** Deja en `_parciales/` los bytes que no completan una parte (nombre nuevo en cada pausa). */
  async pausar(): Promise<void> {
    const clave = `${this.base}_parciales/${this.estado.tabla}-${crypto.randomUUID()}.bin`;
    this.presupuesto.consumirR2();
    await this.bucket.put(clave, this.extraer(this.enMemoria));
    this.estado.parcial = clave;
  }

  /** Escribe el objeto final: `put` simple si nunca se subió una parte; si no, completa la subida. */
  async terminar(): Promise<void> {
    const resto = this.extraer(this.enMemoria);
    if (this.estado.partes.length === 0) {
      this.presupuesto.consumirR2();
      await this.bucket.put(this.clave, resto, {
        httpMetadata: { contentType: 'application/gzip' },
      });
      return;
    }
    if (resto.length > 0) {
      await this.subirParte(resto);
    }
    this.presupuesto.consumirR2();
    await this.multipart().complete(this.estado.partes);
  }

  private agregarEnMemoria(trozo: Uint8Array): void {
    this.trozos.push(trozo);
    this.enMemoria += trozo.length;
  }

  /** Saca los primeros `n` bytes acumulados. */
  private extraer(n: number): Uint8Array {
    const salida = new Uint8Array(n);
    let escritos = 0;
    while (escritos < n) {
      const trozo = this.trozos[0];
      if (trozo === undefined) {
        throw new Error('Se pidieron más bytes de los acumulados');
      }
      const tomados = Math.min(trozo.length, n - escritos);
      salida.set(trozo.subarray(0, tomados), escritos);
      escritos += tomados;
      if (tomados === trozo.length) {
        this.trozos.shift();
      } else {
        this.trozos[0] = trozo.subarray(tomados);
      }
    }
    this.enMemoria -= n;
    return salida;
  }

  private multipart(): R2MultipartUpload {
    if (this.subida === null) {
      if (this.estado.upload_id === null) {
        throw new Error('Subida multipart sin iniciar');
      }
      this.subida = this.bucket.resumeMultipartUpload(this.clave, this.estado.upload_id);
    }
    return this.subida;
  }

  private async subirParte(bytes: Uint8Array): Promise<void> {
    if (this.estado.upload_id === null) {
      this.presupuesto.consumirR2();
      this.subida = await this.bucket.createMultipartUpload(this.clave, {
        httpMetadata: { contentType: 'application/gzip' },
      });
      this.estado.upload_id = this.subida.uploadId;
    }
    this.presupuesto.consumirR2();
    const parte = await this.multipart().uploadPart(this.estado.partes.length + 1, bytes);
    this.estado.partes.push({ partNumber: parte.partNumber, etag: parte.etag });
  }
}

/** Tamaño y sha256 del objeto tal como quedó en R2 (se relee en streaming). */
async function resumirObjeto(
  bucket: R2Bucket,
  clave: string,
  presupuesto: Presupuesto,
): Promise<{ bytes: number; sha256: string }> {
  presupuesto.consumirR2();
  const objeto = await bucket.get(clave);
  if (objeto === null) {
    throw new Error(`No se encontró ${clave} recién escrito`);
  }
  const digest = new crypto.DigestStream('SHA-256');
  await objeto.body.pipeTo(digest);
  const sha256 = [...new Uint8Array(await digest.digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return { bytes: objeto.size, sha256 };
}
