// Backup diario paginado de D1 a R2 (spec §2 y §4 "Backups", ADR 0014, revisión del esquema H9).
//
// Formato en R2 (bucket privado `EVIDENCE`, prefijo `backups/`, retención por regla de ciclo de vida):
//
//   backups/AAAA-MM-DD/<tabla>.ndjson.gz   una línea JSON por fila, todas las columnas, gzip
//   backups/AAAA-MM-DD/manifest.json       solo existe si el backup del día está COMPLETO
//   backups/AAAA-MM-DD/progreso.json       estado de reanudación; se borra al escribir el manifest
//   backups/AAAA-MM-DD/_parciales/*.bin    bytes comprimidos aún no subidos de la tabla en curso
//
// Decisiones (detalle en la entrega de la tarea 6.1 y en docs/despliegue.md):
//
// - Fecha: día UTC del MOMENTO DE EJECUCIÓN (no `scheduledTime`). El cron corre a las 08:00 UTC,
//   lejos de la medianoche, así que ambos coinciden; un reintento manual del mismo día continúa el
//   mismo backup.
// - Paginación por PK en lotes de 500 (`seq > ?`, `id > ?`, `(a, b) > (?, ?)`, `clave > ?`). No se
//   usa la exportación nativa de D1 (bloquea las demás consultas).
// - Compresión con `CompressionStream('gzip')` en streaming. Los bytes comprimidos se suben con
//   multipart upload de R2 en partes de 5 MiB exactos (R2 exige que todas las partes salvo la última
//   midan lo mismo y al menos 5 MiB); si la tabla cabe en menos de una parte se sube con un `put`
//   simple. Así la memoria queda acotada a ~1 parte y no hace falta conocer la longitud de antemano
//   (`R2.put` con un `ReadableStream` exige longitud conocida).
// - Reanudación: si el presupuesto (consultas + operaciones R2, tiempo) se agota a mitad de una tabla,
//   se cierra el miembro gzip actual, los bytes que no completan una parte van a `_parciales/` y el
//   cursor, las partes subidas y el `uploadId` a `progreso.json`. La siguiente invocación DEL MISMO
//   DÍA abre un miembro gzip nuevo y continúa. El archivo final es entonces un gzip de varios miembros
//   (RFC 1952 §2.2): `gzip -d`, `zcat` y `zlib` de Node lo leen completo; el `DecompressionStream`
//   de workerd NO (rechaza bytes tras el primer miembro), por eso el manifest lista en
//   `segmentos_gzip` el desplazamiento de inicio de cada miembro.
// - sha256 y bytes: se calculan RELEYENDO de R2 el objeto ya escrito (`crypto.DigestStream`), es
//   decir, describen exactamente lo almacenado, aunque se haya escrito en varias invocaciones.
// - Idempotencia: si existe el manifest del día, no se hace nada.
// - Reintento: el cron de wrangler.jsonc es diario. Si el backup no termina en una invocación, solo
//   lo continúa otra invocación del mismo día (reintento manual o un segundo cron de respaldo, por
//   ejemplo `30 8 * * *`, que docs/despliegue.md puede añadir); las invocaciones sobrantes solo hacen
//   un `head` del manifest. Un backup sin manifest está INCOMPLETO y no se usa para restaurar.
// - Concurrencia: `progreso.json` lleva un arriendo (`en_curso_hasta`) para que dos invocaciones
//   solapadas no escriban a la vez. Es de mejor esfuerzo (R2 no se usa aquí con escritura condicional).
// - El backup NO es una foto de un único instante (ADR 0014): `seq_inicial` es `MAX(seq)` al empezar.

import { Presupuesto } from './presupuesto';
import { TABLAS_BACKUP, type TablaBackup } from './tablas';

export const PREFIJO_BACKUPS = 'backups/';
export const TAMANO_PAGINA = 500;
/** Mínimo de R2 para las partes de un multipart upload (salvo la última). */
export const TAMANO_PARTE_BYTES = 5 * 1024 * 1024;

/**
 * Operaciones reservadas para cerrar ordenadamente: guardar el parcial y el progreso, o completar
 * la subida, releer el objeto y guardar el progreso; más margen para el mantenimiento del cron.
 */
const RESERVA_CIERRE = 6;
const RESERVA_MANTENIMIENTO = 20;
/** Margen del arriendo sobre el tiempo máximo de la invocación. */
const MARGEN_ARRIENDO_MS = 60_000;

type ValorPk = string | number;
type Fila = Record<string, unknown>;

export interface ArchivoBackup {
  tabla: string;
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

export interface ManifestBackup {
  formato: 1;
  fecha: string;
  generado_at: string;
  /** `settings.sync_epoca` al empezar (ADR 0009). Al restaurar se cambia por una nueva. */
  epoca: string | null;
  /** `MAX(audit_log.seq)` al empezar el backup. */
  seq_inicial: number;
  /** Última migración aplicada (`d1_migrations.name`): versión del esquema. */
  ultima_migracion: string | null;
  /** En orden de exportación (hijos antes que padres). Se restaura en orden inverso. */
  tablas: ArchivoBackup[];
}

interface TablaEnCurso {
  tabla: string;
  /** Valores de la PK de la última fila exportada; null si aún no se exportó ninguna. */
  cursor: ValorPk[] | null;
  filas: number;
  upload_id: string | null;
  partes: R2UploadedPart[];
  /** Objeto con los bytes comprimidos que todavía no completan una parte. */
  parcial: string | null;
  segmentos_gzip: number[];
}

interface ProgresoBackup {
  formato: 1;
  fecha: string;
  iniciado_at: string;
  epoca: string | null;
  seq_inicial: number;
  ultima_migracion: string | null;
  invocaciones: number;
  terminadas: ArchivoBackup[];
  en_curso: TablaEnCurso | null;
  /** Arriendo de la invocación activa; null cuando ninguna está trabajando. */
  en_curso_hasta: string | null;
}

export interface OpcionesBackup {
  presupuesto?: Presupuesto;
  /** Filas por consulta (500 por la ADR 0014; inyectable solo para pruebas). */
  tamanoPagina?: number;
  /** Bytes de cada parte del multipart upload (≥ 5 MiB en R2). */
  tamanoParteBytes?: number;
}

export type ResultadoBackup =
  | { estado: 'ya_existia'; fecha: string }
  | { estado: 'en_curso_en_otra_invocacion'; fecha: string }
  | {
      estado: 'pausado';
      fecha: string;
      tablas_terminadas: number;
      tabla_en_curso: string;
      operaciones: number;
    }
  | {
      estado: 'completo';
      fecha: string;
      tablas: number;
      filas: number;
      bytes: number;
      operaciones: number;
    };

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
    tamanoParte: opciones.tamanoParteBytes ?? TAMANO_PARTE_BYTES,
  };
  const bucket = env.EVIDENCE;
  const fecha = fechaBackup(ahora);
  const base = prefijoDelDia(fecha);
  const claveManifest = `${base}manifest.json`;
  const claveProgreso = `${base}progreso.json`;

  presupuesto.consumir();
  if ((await bucket.head(claveManifest)) !== null) {
    return { estado: 'ya_existia', fecha };
  }

  presupuesto.consumir();
  const guardado = await bucket.get(claveProgreso);
  let progreso: ProgresoBackup;
  if (guardado === null) {
    progreso = await iniciarProgreso(env.DB, fecha, ahora, presupuesto);
  } else {
    progreso = await guardado.json<ProgresoBackup>();
    if (progreso.en_curso_hasta !== null && Date.parse(progreso.en_curso_hasta) > ahora.getTime()) {
      return { estado: 'en_curso_en_otra_invocacion', fecha };
    }
  }

  const guardarProgreso = async (): Promise<void> => {
    presupuesto.consumir();
    await bucket.put(claveProgreso, JSON.stringify(progreso), {
      httpMetadata: { contentType: 'application/json' },
    });
  };
  const borrarParcial = async (clave: string | null): Promise<void> => {
    if (clave !== null) {
      presupuesto.consumir();
      await bucket.delete(clave);
    }
  };

  progreso.invocaciones += 1;
  progreso.en_curso_hasta = new Date(
    ahora.getTime() + presupuesto.maxMs + MARGEN_ARRIENDO_MS,
  ).toISOString();
  await guardarProgreso();

  const terminadas = new Set(progreso.terminadas.map((archivo) => archivo.tabla));
  for (const tabla of TABLAS_BACKUP) {
    if (terminadas.has(tabla.nombre)) {
      continue;
    }
    const estado =
      progreso.en_curso?.tabla === tabla.nombre ? progreso.en_curso : estadoNuevo(tabla.nombre);
    progreso.en_curso = estado;
    // El parcial que referencia el progreso guardado: se borra solo DESPUÉS de guardar el nuevo
    // progreso, para que un corte a mitad de camino nunca deje el progreso apuntando a la nada.
    const parcialAnterior = estado.parcial;

    let resultado: ArchivoBackup | 'pausada';
    try {
      resultado = await exportarTabla(bucket, env.DB, base, tabla, estado, presupuesto, config);
    } catch (error) {
      // La tabla se reinicia desde cero en la siguiente invocación (su subida queda abandonada:
      // R2 aborta los multipart incompletos a los 7 días y la regla de ciclo de vida borra el resto).
      progreso.en_curso = null;
      progreso.en_curso_hasta = null;
      await guardarProgreso();
      throw error;
    }

    if (resultado === 'pausada') {
      progreso.en_curso_hasta = null;
      await guardarProgreso();
      if (parcialAnterior !== estado.parcial) {
        await borrarParcial(parcialAnterior);
      }
      return {
        estado: 'pausado',
        fecha,
        tablas_terminadas: progreso.terminadas.length,
        tabla_en_curso: tabla.nombre,
        operaciones: presupuesto.usadas,
      };
    }

    progreso.terminadas.push(resultado);
    progreso.en_curso = null;
    await guardarProgreso();
    await borrarParcial(parcialAnterior);
  }

  const manifest: ManifestBackup = {
    formato: 1,
    fecha,
    generado_at: new Date().toISOString(),
    epoca: progreso.epoca,
    seq_inicial: progreso.seq_inicial,
    ultima_migracion: progreso.ultima_migracion,
    tablas: progreso.terminadas,
  };
  presupuesto.consumir();
  await bucket.put(claveManifest, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });
  presupuesto.consumir();
  await bucket.delete(claveProgreso);

  return {
    estado: 'completo',
    fecha,
    tablas: manifest.tablas.length,
    filas: manifest.tablas.reduce((total, archivo) => total + archivo.filas, 0),
    bytes: manifest.tablas.reduce((total, archivo) => total + archivo.bytes, 0),
    operaciones: presupuesto.usadas,
  };
}

interface Config {
  tamanoPagina: number;
  tamanoParte: number;
}

function estadoNuevo(tabla: string): TablaEnCurso {
  return {
    tabla,
    cursor: null,
    filas: 0,
    upload_id: null,
    partes: [],
    parcial: null,
    segmentos_gzip: [],
  };
}

/** `MAX(seq)`, época y última migración en un solo batch (cuenta como una consulta). */
async function iniciarProgreso(
  db: D1Database,
  fecha: string,
  ahora: Date,
  presupuesto: Presupuesto,
): Promise<ProgresoBackup> {
  presupuesto.consumir();
  const [seq, epoca, migracion] = await db.batch([
    db.prepare('SELECT COALESCE(MAX(seq), 0) AS valor FROM audit_log'),
    db.prepare("SELECT valor FROM settings WHERE clave = 'sync_epoca'"),
    db.prepare('SELECT name AS valor FROM d1_migrations ORDER BY id DESC LIMIT 1'),
  ]);
  return {
    formato: 1,
    fecha,
    iniciado_at: ahora.toISOString(),
    epoca: epocaDe(primerValor(epoca)),
    seq_inicial: Number(primerValor(seq) ?? 0),
    ultima_migracion: textoONulo(primerValor(migracion)),
    invocaciones: 0,
    terminadas: [],
    en_curso: null,
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

/** Página de `tamano` filas con PK mayor que `cursor`, en orden de PK. */
export function sentenciaPagina(
  db: D1Database,
  tabla: TablaBackup,
  cursor: readonly ValorPk[] | null,
  tamano: number,
): D1PreparedStatement {
  const orden = tabla.pk.join(', ');
  if (cursor === null) {
    return db.prepare(`SELECT * FROM ${tabla.nombre} ORDER BY ${orden} LIMIT ?`).bind(tamano);
  }
  const condicion =
    tabla.pk.length === 1 ? `${orden} > ?` : `(${orden}) > (${tabla.pk.map(() => '?').join(', ')})`;
  return db
    .prepare(`SELECT * FROM ${tabla.nombre} WHERE ${condicion} ORDER BY ${orden} LIMIT ?`)
    .bind(...cursor, tamano);
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

function ndjson(filas: readonly Fila[]): Uint8Array {
  return codificador.encode(filas.map((fila) => `${JSON.stringify(fila)}\n`).join(''));
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
): Promise<ArchivoBackup | 'pausada'> {
  const reserva = RESERVA_CIERRE + RESERVA_MANTENIMIENTO;
  if (!presupuesto.disponible(reserva)) {
    return 'pausada';
  }

  const clave = `${base}${archivoDeTabla(tabla.nombre)}`;
  const subida = await SubidaPorPartes.abrir(bucket, clave, base, estado, config, presupuesto);
  estado.segmentos_gzip.push(subida.bytesTotales);

  const gzip = new CompressionStream('gzip');
  const escritor = gzip.writable.getWriter();
  const lectura = subida.consumir(gzip.readable);
  let terminada = false;
  try {
    while (presupuesto.disponible(reserva)) {
      presupuesto.consumir();
      const { results } = await sentenciaPagina(
        db,
        tabla,
        estado.cursor,
        config.tamanoPagina,
      ).all<Fila>();
      const ultima = results.at(-1);
      if (ultima !== undefined) {
        await escritor.write(ndjson(results));
        estado.filas += results.length;
        estado.cursor = cursorDe(tabla, ultima);
      }
      if (results.length < config.tamanoPagina) {
        terminada = true;
        break;
      }
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
      presupuesto.consumir();
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
    this.presupuesto.consumir();
    await this.bucket.put(clave, this.extraer(this.enMemoria));
    this.estado.parcial = clave;
  }

  /** Escribe el objeto final: `put` simple si nunca se subió una parte; si no, completa la subida. */
  async terminar(): Promise<void> {
    const resto = this.extraer(this.enMemoria);
    if (this.estado.partes.length === 0) {
      this.presupuesto.consumir();
      await this.bucket.put(this.clave, resto, {
        httpMetadata: { contentType: 'application/gzip' },
      });
      return;
    }
    if (resto.length > 0) {
      await this.subirParte(resto);
    }
    this.presupuesto.consumir();
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
      this.presupuesto.consumir();
      this.subida = await this.bucket.createMultipartUpload(this.clave, {
        httpMetadata: { contentType: 'application/gzip' },
      });
      this.estado.upload_id = this.subida.uploadId;
    }
    this.presupuesto.consumir();
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
  presupuesto.consumir();
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
