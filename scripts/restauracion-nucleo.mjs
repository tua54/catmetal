// Núcleo de la restauración del backup de R2 (ADR 0021). Puro: sin módulos de Node, para que lo
// importen tanto el CLI (scripts/restaurar-backup.mjs) como la prueba del Worker
// (apps/worker/test/fase6-restauracion.test.ts), que ejecuta el SQL contra una D1 local real.
//
// Qué hace: a partir del manifest (`formato: 2`) y de las filas de cada NDJSON, reconstruye el
// estado EXACTO de la base en la marca de corte `C = manifest.corte.seq`:
// - lo creado después del corte (su primera auditoría es posterior a C) se excluye;
// - lo modificado después del corte, en las tablas cuya auditoría guarda la fila completa, se
//   revierte con el `datos_antes` de su primera auditoría posterior a C;
// - `users` y `devices` (auditoría parcial) conservan su valor exportado, el más reciente;
// - `sync_mutations` aplicadas solo se conservan si su efecto existe; las no aplicadas, solo si se
//   procesaron más de 15 min antes del corte (las demás van al informe);
// - `login_cupos` se importa tal cual; `refresh_tokens` NO se restaura (todos inician sesión otra vez);
// - `audit_log` se importa hasta C.
//
// Devuelve el SQL de restauración (con guardia, borrado y recreación de los triggers), el SQL de
// verificación (cada consulta debe devolver 0 filas), el SQL posterior (cambio de época) y el
// informe. Nunca usa DELETE: las semillas de la migración 0002 se sobrescriben con un upsert.

/** Máximo de bytes por sentencia (el límite documentado de D1 es de 100 KB por sentencia). */
export const MAX_BYTES_SENTENCIA = 90_000;
/** Máximo de filas por INSERT. */
export const MAX_FILAS_SENTENCIA = 100;
/** Margen entre la hora del corte y la de proceso de una mutación no aplicada (ADR 0021, 4.3). */
export const MARGEN_NO_APLICADAS_MS = 15 * 60_000;
/** Tablas que pueden faltar en un backup `parcial` sin impedir la restauración. */
export const INCOMPLETAS_ADMITIDAS = ['sync_mutations', 'login_cupos', 'refresh_tokens'];

const M = ['created_at', 'updated_at'];

/**
 * Descripción de cada tabla. Debe coincidir con `TABLAS_BACKUP` (columnas y PK) y con
 * `COLUMNAS_AUDITABLES` / `COLUMNAS_BOOLEANAS` de apps/worker/src/auditoria/auditar.ts: la prueba
 * de restauración lo verifica.
 *
 * Clases (ADR 0021, 4):
 * - `revertible`: la auditoría guarda la fila completa (salvo `inmutables`); se revierte al corte.
 * - `ultimo_valor`: auditoría parcial; se excluye si se creó tras el corte, si no se conserva.
 * - `operativa`: sin auditoría por fila (reglas propias).
 * - `no_restaurada`: `refresh_tokens`.
 */
export const TABLAS = {
  users: {
    clase: 'ultimo_valor',
    pk: ['id'],
    columnas: [
      'id',
      'nombre',
      'email',
      'password_hash',
      'rol',
      'activo',
      'intentos_fallidos',
      'bloqueado_hasta',
      ...M,
    ],
    booleanas: ['activo'],
  },
  materials: {
    clase: 'revertible',
    pk: ['id'],
    columnas: ['id', 'codigo', 'nombre', 'unidad', 'costo_unitario_cop', 'activo', ...M],
    booleanas: ['activo'],
  },
  production_orders: {
    clase: 'revertible',
    pk: ['id'],
    columnas: ['id', 'codigo', 'linea', 'estado', 'fecha_inicio', 'fecha_fin', 'creada_por', ...M],
    booleanas: [],
  },
  settings: {
    clase: 'revertible',
    pk: ['clave'],
    columnas: ['clave', 'valor', 'actualizado_por', ...M],
    booleanas: [],
    /** La auditoría guarda el JSON ya parseado (`json(valor)`): se vuelve a texto JSON. */
    json: ['valor'],
  },
  devices: {
    clase: 'ultimo_valor',
    pk: ['id'],
    columnas: ['id', 'user_id', 'instalacion_id', 'nombre', 'user_agent', 'ultimo_sync_at', ...M],
    booleanas: [],
  },
  login_cupos: {
    clase: 'operativa',
    pk: ['user_id', 'origen'],
    columnas: [
      'user_id',
      'origen',
      'fallos',
      'ventana_inicio',
      'bloqueado_hasta',
      'reserva_id',
      ...M,
    ],
    booleanas: [],
  },
  refresh_tokens: {
    clase: 'no_restaurada',
    pk: ['id'],
    columnas: [
      'id',
      'user_id',
      'device_id',
      'token_hash',
      'familia_id',
      'expira_at',
      'revocado_at',
      'reemplazado_por',
      ...M,
    ],
    booleanas: [],
  },
  order_supervisors: {
    clase: 'revertible',
    pk: ['order_id', 'user_id'],
    columnas: ['order_id', 'user_id', 'asignado_por', 'activo', ...M],
    booleanas: ['activo'],
  },
  order_planned_materials: {
    clase: 'revertible',
    pk: ['order_id', 'material_id'],
    columnas: ['order_id', 'material_id', 'cantidad_planeada', 'unidad', ...M],
    booleanas: [],
  },
  consumptions: {
    clase: 'revertible',
    pk: ['id'],
    columnas: [
      'id',
      'order_id',
      'material_id',
      'cantidad',
      'unidad',
      'cantidad_en_unidad_plan',
      'lote',
      'costo_unitario_cop_snapshot',
      'registrado_por',
      'device_id',
      'client_created_at',
      'server_received_at',
      'estado',
      'corrige_a',
      'registro_tardio',
      'requiere_novedad',
      'version',
      ...M,
    ],
    booleanas: ['registro_tardio', 'requiere_novedad'],
  },
  incidents: {
    clase: 'revertible',
    pk: ['id'],
    columnas: [
      'id',
      'consumption_id',
      'tipo',
      'descripcion',
      'registrado_por',
      'client_created_at',
      'server_received_at',
      ...M,
    ],
    booleanas: [],
  },
  evidences: {
    clase: 'revertible',
    pk: ['id'],
    columnas: [
      'id',
      'incident_id',
      'storage_key',
      'mime',
      'tamano_bytes',
      'sha256',
      'subido',
      'subido_at',
      ...M,
    ],
    booleanas: ['subido'],
    /** Fuera de la auditoría e inmutable (`evidences_inmutable`): nunca se revierte ni se compara. */
    inmutables: ['storage_key'],
  },
  validations: {
    clase: 'revertible',
    pk: ['id'],
    columnas: [
      'id',
      'consumption_id',
      'decision',
      'motivo',
      'validado_por',
      'client_created_at',
      'server_received_at',
      ...M,
    ],
    booleanas: [],
  },
  sync_mutations: {
    clase: 'operativa',
    pk: ['mutation_id'],
    columnas: [
      'mutation_id',
      'user_id',
      'device_id',
      'tipo',
      'resultado',
      'respuesta_json',
      'payload_json',
      'procesada_at',
      ...M,
    ],
    booleanas: [],
  },
  audit_log: {
    clase: 'operativa',
    pk: ['seq'],
    columnas: [
      'seq',
      'id',
      'entidad',
      'entidad_id',
      'accion',
      'actor_id',
      'device_id',
      'datos_antes',
      'datos_despues',
      'client_at',
      'server_at',
      'alerta_reloj',
      ...M,
      'order_id',
    ],
    booleanas: [],
  },
};

/** Orden de importación: padres primero (ADR 0021, 5). `refresh_tokens` no se importa. */
export const ORDEN_IMPORTACION = [
  'users',
  'materials',
  'production_orders',
  'settings',
  'devices',
  'login_cupos',
  'order_supervisors',
  'order_planned_materials',
  'consumptions',
  'incidents',
  'evidences',
  'validations',
  'sync_mutations',
  'audit_log',
];

/** Tablas que se excluyen o revierten según su auditoría (V3, V10 y código de salida 3). */
export const TABLAS_AUDITADAS = Object.keys(TABLAS).filter((t) =>
  ['revertible', 'ultimo_valor'].includes(TABLAS[t].clase),
);

export class ErrorRestauracion extends Error {
  /**
   * @param {'INTEGRIDAD' | 'SIN_AUDITORIA'} codigo
   * @param {string} mensaje
   * @param {unknown} [detalle]
   */
  constructor(codigo, mensaje, detalle) {
    super(mensaje);
    this.name = 'ErrorRestauracion';
    this.codigo = codigo;
    this.detalle = detalle ?? null;
  }
}

// ---------------------------------------------------------------------------------------------
// Triggers esperados (desde las migraciones)
// ---------------------------------------------------------------------------------------------

const PATRON_CREAR_TRIGGER = /^CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([A-Za-z0-9_]+)/i;
const PATRON_BORRAR_TRIGGER = /^DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?[`"[]?([A-Za-z0-9_]+)/i;

function nombreBase(ruta) {
  return ruta.replaceAll('\\', '/').split('/').at(-1) ?? ruta;
}

/** Sentencia sin líneas iniciales en blanco o de comentario, sin espacios en los extremos ni `;`. */
function limpiarSentencia(trozo) {
  const lineas = trozo.split(/\r?\n/);
  while (lineas.length > 0 && (lineas[0].trim() === '' || lineas[0].trim().startsWith('--'))) {
    lineas.shift();
  }
  let texto = lineas.join('\n').trim();
  while (texto.endsWith(';')) {
    texto = texto.slice(0, -1).trimEnd();
  }
  return texto;
}

/**
 * Triggers vigentes después de aplicar, en orden, las migraciones `.sql` cuyo nombre es ≤ `hasta`
 * (`d1_migrations.name`, por ejemplo `0007_login_cupos.sql`). Cada archivo se parte por el marcador
 * `--> statement-breakpoint` de drizzle-kit. Devuelve los triggers en orden de creación.
 *
 * @param {{ nombre: string; contenido: string }[]} archivos
 * @param {string} hasta
 * @returns {{ nombre: string; sql: string }[]}
 */
export function triggersDeMigraciones(archivos, hasta) {
  const vigentes = new Map();
  const migraciones = archivos
    .map((a) => ({ nombre: nombreBase(a.nombre), contenido: a.contenido }))
    .filter((a) => a.nombre.endsWith('.sql') && a.nombre <= hasta)
    .sort((x, y) => (x.nombre < y.nombre ? -1 : x.nombre > y.nombre ? 1 : 0));
  for (const migracion of migraciones) {
    for (const trozo of migracion.contenido.split('--> statement-breakpoint')) {
      const sentencia = limpiarSentencia(trozo);
      const creado = PATRON_CREAR_TRIGGER.exec(sentencia);
      if (creado !== null) {
        vigentes.delete(creado[1]);
        vigentes.set(creado[1], sentencia);
        continue;
      }
      const borrado = PATRON_BORRAR_TRIGGER.exec(sentencia);
      if (borrado !== null) {
        vigentes.delete(borrado[1]);
      }
    }
  }
  return [...vigentes].map(([nombre, sql]) => ({ nombre, sql }));
}

/** Filas de un NDJSON (una fila JSON por línea; líneas vacías ignoradas). */
export function filasDeNdjson(texto) {
  return texto
    .split('\n')
    .filter((linea) => linea.trim() !== '')
    .map((linea) => JSON.parse(linea));
}

// ---------------------------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------------------------

const codificador = new TextEncoder();

function bytesUtf8(texto) {
  return codificador.encode(texto).length;
}

/** Literal SQL de un valor de una fila (texto, número o NULL). */
export function literal(valor) {
  if (valor === null || valor === undefined) {
    return 'NULL';
  }
  if (typeof valor === 'number') {
    if (!Number.isFinite(valor)) {
      throw new ErrorRestauracion('INTEGRIDAD', `Número no finito en el backup: ${String(valor)}`);
    }
    return String(valor);
  }
  if (typeof valor === 'boolean') {
    return valor ? '1' : '0';
  }
  if (typeof valor === 'string') {
    // Un NUL dentro de un literal cortaría la sentencia: ese texto va como blob hexadecimal.
    if (valor.includes('\u0000')) {
      const hex = Array.from(codificador.encode(valor), (b) => b.toString(16).padStart(2, '0'));
      return `CAST(X'${hex.join('')}' AS TEXT)`;
    }
    return `'${valor.replaceAll("'", "''")}'`;
  }
  throw new ErrorRestauracion(
    'INTEGRIDAD',
    `Tipo de valor no admitido en el backup: ${typeof valor}`,
  );
}

function claveDe(tabla, fila) {
  return TABLAS[tabla].pk.map((columna) => String(fila[columna])).join(':');
}

/** Expresión SQL de la clave de auditoría (`entidad_id`) de una fila de la tabla con alias `r`. */
function expresionClave(tabla) {
  return TABLAS[tabla].pk.map((columna) => `r.${columna}`).join(" || ':' || ");
}

function indiceAuditoria(entidad, entidadId) {
  return `${entidad}\u0000${entidadId}`;
}

function comparar(x, y) {
  return x < y ? -1 : x > y ? 1 : 0;
}

/** INSERT de varias filas, partido para no pasar de `MAX_FILAS_SENTENCIA` ni `MAX_BYTES_SENTENCIA`. */
function sentenciasInsert(tabla, filas, conflicto) {
  const columnas = TABLAS[tabla].columnas;
  const cabecera = `INSERT INTO ${tabla} (${columnas.join(', ')}) VALUES\n`;
  const cola =
    conflicto === undefined
      ? ''
      : `\nON CONFLICT (${TABLAS[tabla].pk.join(', ')}) DO UPDATE SET ${columnas
          .filter((c) => !TABLAS[tabla].pk.includes(c))
          .map((c) => `${c} = excluded.${c}`)
          .join(', ')}`;
  const fijo = bytesUtf8(cabecera) + bytesUtf8(cola);
  const sentencias = [];
  let grupo = [];
  let bytesGrupo = fijo;
  const cerrar = () => {
    if (grupo.length > 0) {
      sentencias.push(`${cabecera}${grupo.join(',\n')}${cola}`);
      grupo = [];
      bytesGrupo = fijo;
    }
  };
  for (const fila of filas) {
    const tupla = `(${columnas.map((c) => literal(fila[c])).join(', ')})`;
    const tamano = bytesUtf8(tupla) + 2;
    if (fijo + tamano > MAX_BYTES_SENTENCIA) {
      throw new ErrorRestauracion(
        'INTEGRIDAD',
        `Una fila de ${tabla} no cabe en una sentencia de ${String(MAX_BYTES_SENTENCIA)} bytes`,
        { tabla, clave: claveDe(tabla, fila) },
      );
    }
    if (grupo.length >= MAX_FILAS_SENTENCIA || bytesGrupo + tamano > MAX_BYTES_SENTENCIA) {
      cerrar();
    }
    grupo.push(tupla);
    bytesGrupo += tamano;
  }
  cerrar();
  return sentencias;
}

function bytesDeFila(tabla, fila) {
  return bytesUtf8(`(${TABLAS[tabla].columnas.map((c) => literal(fila[c])).join(', ')})`);
}

/** `payload_json` reducido de una mutación no aplicada (mismo formato que la ADR 0020). */
function payloadRecortado(fila) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  let payload = {};
  try {
    const original = JSON.parse(String(fila.payload_json));
    const p = original !== null && typeof original === 'object' ? original.payload : null;
    if (p !== null && typeof p === 'object') {
      for (const clave of ['id', 'consumption_id']) {
        if (typeof p[clave] === 'string' && uuid.test(p[clave])) {
          payload[clave] = p[clave];
        }
      }
    }
  } catch {
    payload = {};
  }
  return JSON.stringify({
    recortado: true,
    motivo: 'no cabe en una sentencia de la restauración',
    tamano_bytes: bytesUtf8(String(fila.payload_json)),
    tipo: String(fila.tipo).slice(0, 64),
    payload,
  });
}

// ---------------------------------------------------------------------------------------------
// Validación del manifest
// ---------------------------------------------------------------------------------------------

function validarManifest(manifest, filas) {
  if (manifest === null || typeof manifest !== 'object' || manifest.formato !== 2) {
    throw new ErrorRestauracion(
      'INTEGRIDAD',
      'El backup no es de formato 2 (ADR 0021): no tiene marca de corte y no se restaura con este script',
    );
  }
  const corte = manifest.corte;
  if (
    corte === null ||
    typeof corte !== 'object' ||
    !Number.isInteger(corte.seq) ||
    typeof corte.at !== 'string' ||
    Number.isNaN(Date.parse(corte.at)) ||
    !Number.isInteger(manifest.seq_final) ||
    corte.seq > manifest.seq_final
  ) {
    throw new ErrorRestauracion(
      'INTEGRIDAD',
      'Marca de corte o seq_final inválidos en el manifest',
    );
  }
  if (typeof manifest.ultima_migracion !== 'string' || manifest.ultima_migracion === '') {
    throw new ErrorRestauracion('INTEGRIDAD', 'El manifest no indica la última migración');
  }
  const entradas = new Map((manifest.tablas ?? []).map((t) => [t.tabla, t]));
  for (const tabla of Object.keys(TABLAS)) {
    const entrada = entradas.get(tabla);
    if (entrada === undefined) {
      throw new ErrorRestauracion('INTEGRIDAD', `El manifest no lista la tabla ${tabla}`);
    }
    if (entrada.estado === 'incompleta') {
      if (!INCOMPLETAS_ADMITIDAS.includes(tabla)) {
        throw new ErrorRestauracion(
          'INTEGRIDAD',
          `La tabla ${tabla} quedó incompleta en este backup: use otro día`,
          { tabla, motivo: entrada.motivo },
        );
      }
      continue;
    }
    if (entrada.estado !== 'completa') {
      throw new ErrorRestauracion('INTEGRIDAD', `Estado desconocido de la tabla ${tabla}`);
    }
    if (tabla === 'refresh_tokens') {
      continue;
    }
    const lista = filas[tabla];
    if (!Array.isArray(lista) || lista.length !== entrada.filas) {
      throw new ErrorRestauracion(
        'INTEGRIDAD',
        `Las filas de ${tabla} no coinciden con el manifest (${String(entrada.filas)})`,
      );
    }
  }
  return entradas;
}

// ---------------------------------------------------------------------------------------------
// Reconciliación
// ---------------------------------------------------------------------------------------------

/** Valor de la auditoría convertido al de la columna (booleanos y JSON). */
function valorDeAuditoria(tabla, columna, valor) {
  const definicion = TABLAS[tabla];
  if (definicion.booleanas.includes(columna) && typeof valor === 'boolean') {
    return valor ? 1 : 0;
  }
  if ((definicion.json ?? []).includes(columna)) {
    return JSON.stringify(valor);
  }
  return valor;
}

function objetoJson(texto) {
  if (typeof texto !== 'string') {
    return null;
  }
  try {
    const valor = JSON.parse(texto);
    return valor !== null && typeof valor === 'object' && !Array.isArray(valor) ? valor : null;
  } catch {
    return null;
  }
}

/** Ordena los consumos de modo que un original vaya antes que su corrección (`corrige_a`). */
function ordenTopologicoConsumos(consumos) {
  const porId = new Map(consumos.map((c) => [c.id, c]));
  const ordenados = [];
  const vistos = new Set();
  const visitar = (consumo) => {
    if (vistos.has(consumo.id)) {
      return;
    }
    vistos.add(consumo.id);
    const original = consumo.corrige_a === null ? undefined : porId.get(consumo.corrige_a);
    if (original !== undefined) {
      visitar(original);
    }
    ordenados.push(consumo);
  };
  for (const consumo of [...consumos].sort((x, y) => comparar(x.id, y.id))) {
    visitar(consumo);
  }
  return ordenados;
}

/**
 * Plan de restauración (ADR 0021). Lanza `ErrorRestauracion` si el backup no es restaurable
 * (`INTEGRIDAD`) o si hay filas sin auditoría en el origen (`SIN_AUDITORIA`, salvo
 * `conservarSinAuditoria`).
 *
 * @param {{
 *   manifest: any;
 *   filas: Record<string, Record<string, unknown>[]>;
 *   triggers: { nombre: string; sql: string }[];
 *   conservarSinAuditoria?: boolean;
 * }} entrada
 */
export function planificarRestauracion(entrada) {
  const { manifest, triggers } = entrada;
  const filas = entrada.filas ?? {};
  const entradas = validarManifest(manifest, filas);
  const C = manifest.corte.seq;
  const S = manifest.seq_final;
  const corteMs = Date.parse(manifest.corte.at);
  if (!Array.isArray(triggers) || triggers.length === 0) {
    throw new ErrorRestauracion('INTEGRIDAD', 'No hay triggers esperados (¿migraciones vacías?)');
  }

  // audit_log: exactamente 1..S, sin saltos.
  const auditoria = [...(filas.audit_log ?? [])].sort((x, y) => x.seq - y.seq);
  if (auditoria.length !== S || auditoria.some((fila, i) => fila.seq !== i + 1)) {
    throw new ErrorRestauracion(
      'INTEGRIDAD',
      `audit_log no tiene exactamente los seq 1..${String(S)} (backup corrupto)`,
    );
  }
  const antesDelCorte = new Set();
  const despuesDelCorte = new Map();
  for (const fila of auditoria) {
    const indice = indiceAuditoria(fila.entidad, fila.entidad_id);
    if (fila.seq <= C) {
      antesDelCorte.add(indice);
    } else {
      const lista = despuesDelCorte.get(indice) ?? [];
      lista.push(fila);
      despuesDelCorte.set(indice, lista);
    }
  }

  const informe = {
    fecha: manifest.fecha,
    corte: manifest.corte,
    seq_final: S,
    tablas: {},
    sync_mutations: {
      aplicadas_conservadas: 0,
      aplicadas_sin_efecto_descartadas: 0,
      no_aplicadas_conservadas: 0,
      no_aplicadas_descartadas: 0,
      tabla_omitida: entradas.get('sync_mutations')?.estado === 'incompleta',
    },
    refresh_tokens_omitidos:
      entradas.get('refresh_tokens')?.estado === 'completa'
        ? Number(entradas.get('refresh_tokens').filas)
        : 0,
    login_cupos_omitida: entradas.get('login_cupos')?.estado === 'incompleta',
    cambios_tras_el_corte: auditoria
      .filter((fila) => fila.seq > C)
      .map((fila) => ({
        seq: fila.seq,
        entidad: fila.entidad,
        entidad_id: fila.entidad_id,
        accion: fila.accion,
        actor_id: fila.actor_id,
        server_at: fila.server_at,
      })),
    rechazos_tras_el_corte: [],
    revisar_seguridad: [],
    sin_auditoria_conservadas: [],
  };
  const contar = (tabla) => {
    informe.tablas[tabla] ??= {
      exportadas: 0,
      importadas: 0,
      excluidas: 0,
      revertidas: 0,
      conservadas_mas_recientes: 0,
      recortadas: 0,
      sin_auditoria_conservadas: 0,
    };
    return informe.tablas[tabla];
  };

  // Tablas auditadas: excluir lo creado tras el corte, revertir lo modificado (si es revertible).
  const restauradas = {};
  const sinAuditoria = [];
  const excluidas = { users: new Set(), devices: new Set() };
  for (const tabla of ORDEN_IMPORTACION.filter((t) => TABLAS_AUDITADAS.includes(t))) {
    const definicion = TABLAS[tabla];
    const cuenta = contar(tabla);
    const salida = [];
    for (const fila of filas[tabla] ?? []) {
      cuenta.exportadas += 1;
      const clave = claveDe(tabla, fila);
      const indice = indiceAuditoria(tabla, clave);
      const pre = antesDelCorte.has(indice);
      const post = despuesDelCorte.get(indice) ?? [];
      if (!pre && post.length > 0) {
        cuenta.excluidas += 1;
        excluidas[tabla]?.add(clave);
        if (tabla === 'users') {
          informe.revisar_seguridad.push({
            entidad: 'users',
            entidad_id: clave,
            tipo: 'creado_tras_el_corte_no_restaurado',
            acciones: post.map((a) => ({
              seq: a.seq,
              accion: a.accion,
              actor_id: a.actor_id,
              server_at: a.server_at,
            })),
          });
        }
        continue;
      }
      if (!pre) {
        sinAuditoria.push({ tabla, clave });
        if (entrada.conservarSinAuditoria === true) {
          cuenta.sin_auditoria_conservadas += 1;
          informe.sin_auditoria_conservadas.push({ tabla, clave });
          salida.push(fila);
        }
        continue;
      }
      if (post.length === 0) {
        salida.push(fila);
        continue;
      }
      if (definicion.clase === 'ultimo_valor') {
        cuenta.conservadas_mas_recientes += 1;
        if (tabla === 'users') {
          informe.revisar_seguridad.push({
            entidad: 'users',
            entidad_id: clave,
            tipo: 'cambios_tras_el_corte_conservados',
            acciones: post.map((a) => ({
              seq: a.seq,
              accion: a.accion,
              actor_id: a.actor_id,
              server_at: a.server_at,
            })),
          });
        }
        salida.push(fila);
        continue;
      }
      // Revertible: cada columna toma el `datos_antes` de la primera auditoría posterior al corte
      // que la incluya. Nunca se tocan la PK ni las inmutables.
      const intocables = new Set([...definicion.pk, ...(definicion.inmutables ?? [])]);
      const revertida = { ...fila };
      const imagenes = post.map((a) => objetoJson(a.datos_antes)).filter((i) => i !== null);
      for (const columna of definicion.columnas) {
        if (intocables.has(columna)) {
          continue;
        }
        const imagen = imagenes.find((i) => Object.hasOwn(i, columna));
        if (imagen !== undefined) {
          revertida[columna] = valorDeAuditoria(tabla, columna, imagen[columna]);
        }
      }
      cuenta.revertidas += 1;
      salida.push(revertida);
    }
    restauradas[tabla] = tabla === 'consumptions' ? ordenTopologicoConsumos(salida) : salida;
  }
  if (sinAuditoria.length > 0 && entrada.conservarSinAuditoria !== true) {
    throw new ErrorRestauracion(
      'SIN_AUDITORIA',
      `${String(sinAuditoria.length)} filas sin ninguna auditoría en el origen (defecto previo al backup)`,
      sinAuditoria,
    );
  }

  const usuarios = new Set((restauradas.users ?? []).map((f) => f.id));
  const dispositivos = new Set((restauradas.devices ?? []).map((f) => f.id));

  // login_cupos: tal cual, salvo las filas de usuarios que no se restauran.
  {
    const cuenta = contar('login_cupos');
    restauradas.login_cupos = [];
    for (const fila of filas.login_cupos ?? []) {
      cuenta.exportadas += 1;
      if (usuarios.has(fila.user_id)) {
        restauradas.login_cupos.push(fila);
      } else {
        cuenta.excluidas += 1;
      }
    }
  }

  // sync_mutations: aplicadas solo con su efecto; no aplicadas solo si son anteriores al corte.
  {
    const cuenta = contar('sync_mutations');
    restauradas.sync_mutations = [];
    const versiones = new Map(
      (restauradas.consumptions ?? []).map((c) => [c.id, Number(c.version)]),
    );
    const novedades = new Set((restauradas.incidents ?? []).map((f) => f.id));
    const validaciones = new Set((restauradas.validations ?? []).map((f) => f.id));
    const efectoExiste = (fila) => {
      const respuesta = objetoJson(fila.respuesta_json);
      const servidor = respuesta === null ? null : respuesta.servidor;
      if (servidor === null || typeof servidor !== 'object') {
        return false;
      }
      switch (fila.tipo) {
        case 'consumo.crear':
          return versiones.has(servidor.id);
        case 'consumo.editar':
          return (
            versiones.has(servidor.id) && versiones.get(servidor.id) >= Number(servidor.version)
          );
        case 'novedad.crear':
          return novedades.has(servidor.id);
        case 'consumo.aprobar':
        case 'consumo.rechazar':
          return (
            servidor.validacion !== null &&
            typeof servidor.validacion === 'object' &&
            validaciones.has(servidor.validacion.id)
          );
        default:
          return false;
      }
    };
    for (const fila of informe.sync_mutations.tabla_omitida ? [] : (filas.sync_mutations ?? [])) {
      cuenta.exportadas += 1;
      if (!usuarios.has(fila.user_id) || !dispositivos.has(fila.device_id)) {
        cuenta.excluidas += 1;
        if (fila.resultado === 'aplicada') {
          informe.sync_mutations.aplicadas_sin_efecto_descartadas += 1;
        } else {
          informe.sync_mutations.no_aplicadas_descartadas += 1;
        }
        continue;
      }
      if (fila.resultado === 'aplicada') {
        if (efectoExiste(fila)) {
          informe.sync_mutations.aplicadas_conservadas += 1;
          restauradas.sync_mutations.push(fila);
        } else {
          informe.sync_mutations.aplicadas_sin_efecto_descartadas += 1;
          cuenta.excluidas += 1;
        }
        continue;
      }
      if (Date.parse(String(fila.procesada_at)) < corteMs - MARGEN_NO_APLICADAS_MS) {
        let conservada = fila;
        if (bytesDeFila('sync_mutations', fila) + 200 > MAX_BYTES_SENTENCIA) {
          conservada = { ...fila, payload_json: payloadRecortado(fila) };
          cuenta.recortadas += 1;
        }
        informe.sync_mutations.no_aplicadas_conservadas += 1;
        restauradas.sync_mutations.push(conservada);
        continue;
      }
      // ADR 0021, 4.3: descartarla NO es "siempre seguro" (el cliente no reenvía un rechazo que ya
      // recibió): va al informe para que alguien la revise.
      informe.sync_mutations.no_aplicadas_descartadas += 1;
      cuenta.excluidas += 1;
      const respuesta = objetoJson(fila.respuesta_json);
      informe.rechazos_tras_el_corte.push({
        mutation_id: fila.mutation_id,
        user_id: fila.user_id,
        tipo: fila.tipo,
        resultado: fila.resultado,
        code: respuesta !== null && typeof respuesta.code === 'string' ? respuesta.code : null,
      });
    }
  }

  // audit_log hasta el corte.
  {
    const cuenta = contar('audit_log');
    cuenta.exportadas = auditoria.length;
    restauradas.audit_log = auditoria.filter((fila) => fila.seq <= C);
    cuenta.excluidas = auditoria.length - restauradas.audit_log.length;
  }

  for (const tabla of ORDEN_IMPORTACION) {
    contar(tabla).importadas = (restauradas[tabla] ?? []).length;
  }

  const restauracion = sqlRestauracion(manifest, triggers, restauradas);
  const verificacion = sqlVerificacion(C, triggers, informe);
  return {
    restauracion,
    verificacion,
    postRestauracion: SQL_POST_RESTAURACION,
    informe,
  };
}

// ---------------------------------------------------------------------------------------------
// restauracion.sql
// ---------------------------------------------------------------------------------------------

function valoresEsperados(triggers) {
  return triggers.map((t) => `(${literal(t.nombre)}, ${literal(t.sql)})`).join(',\n  ');
}

function sqlRestauracion(manifest, triggers, restauradas) {
  const sentencias = [
    'PRAGMA defer_foreign_keys = on',
    'CREATE TABLE _restauracion_guardia (ok INTEGER NOT NULL CHECK (ok = 1))',
    // Guardia: base recién migrada, con la misma última migración del backup y exactamente los
    // triggers de las migraciones. Si algo no cuadra, el CHECK (o el NOT NULL) aborta antes de
    // tocar nada.
    `WITH esperados(n, s) AS (VALUES
  ${valoresEsperados(triggers)})
INSERT INTO _restauracion_guardia (ok) SELECT COALESCE(
  (SELECT COUNT(*) FROM users) = 0
  AND (SELECT COUNT(*) FROM devices) = 0
  AND (SELECT COUNT(*) FROM consumptions) = 0
  AND (SELECT COUNT(*) FROM refresh_tokens) = 0
  AND (SELECT COUNT(*) FROM login_cupos) = 0
  AND NOT EXISTS (SELECT 1 FROM audit_log WHERE accion <> 'seed')
  AND (SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1) = ${literal(manifest.ultima_migracion)}
  AND (SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger') = (SELECT COUNT(*) FROM esperados)
  AND NOT EXISTS (
    SELECT 1 FROM esperados AS e WHERE NOT EXISTS (
      SELECT 1 FROM sqlite_master AS m WHERE m.type = 'trigger' AND m.name = e.n AND m.sql = e.s)),
  0)`,
    ...triggers.map((t) => `DROP TRIGGER IF EXISTS ${t.nombre}`),
  ];
  for (const tabla of ORDEN_IMPORTACION) {
    const conflicto = tabla === 'settings' || tabla === 'audit_log' ? 'upsert' : undefined;
    sentencias.push(...sentenciasInsert(tabla, restauradas[tabla] ?? [], conflicto));
  }
  sentencias.push(...triggers.map((t) => t.sql));
  sentencias.push('DROP TABLE _restauracion_guardia');
  return sentencias;
}

// ---------------------------------------------------------------------------------------------
// verificacion.sql
// ---------------------------------------------------------------------------------------------

function sqlVerificacion(C, triggers, informe) {
  const aceptadas = informe.sin_auditoria_conservadas;
  const consultas = [];
  consultas.push({
    nombre: 'V1_consumo_decidido_sin_validacion',
    sql: `SELECT c.id FROM consumptions AS c WHERE c.estado <> 'pendiente' AND NOT EXISTS (
  SELECT 1 FROM validations AS v WHERE v.consumption_id = c.id AND v.decision = c.estado)`,
  });
  consultas.push({
    nombre: 'V2_validacion_no_aplicada',
    sql: `SELECT v.id FROM validations AS v JOIN consumptions AS c ON c.id = v.consumption_id
WHERE c.estado <> v.decision`,
  });
  // Una consulta por tabla: D1 admite como mucho 5 términos en un SELECT compuesto (UNION ALL).
  for (const tabla of TABLAS_AUDITADAS) {
    const clave = expresionClave(tabla);
    const propias = aceptadas.filter((a) => a.tabla === tabla).map((a) => literal(a.clave));
    const excepcion = propias.length > 0 ? ` AND ${clave} NOT IN (${propias.join(', ')})` : '';
    consultas.push({
      nombre: `V3_fila_sin_auditoria_${tabla}`,
      sql: `SELECT ${clave} AS clave FROM ${tabla} AS r WHERE NOT EXISTS (
  SELECT 1 FROM audit_log AS a WHERE a.entidad = '${tabla}' AND a.entidad_id = ${clave})${excepcion}`,
    });
  }
  for (const tabla of TABLAS_AUDITADAS.filter((t) => TABLAS[t].clase === 'revertible')) {
    const definicion = TABLAS[tabla];
    const clave = expresionClave(tabla);
    const inmutables = new Set(definicion.inmutables ?? []);
    const diferencias = definicion.columnas
      .filter((c) => !inmutables.has(c))
      .map((c) => {
        const columna = (definicion.json ?? []).includes(c)
          ? `json_extract(r.${c}, '$')`
          : `r.${c}`;
        return `(json_type(a.datos_despues, '$.${c}') IS NOT NULL AND json_extract(a.datos_despues, '$.${c}') IS NOT ${columna})`;
      })
      .join('\n   OR ');
    consultas.push({
      nombre: `V4_distinto_de_su_auditoria_${tabla}`,
      sql: `SELECT '${tabla}' AS tabla, ${clave} AS clave FROM ${tabla} AS r
JOIN audit_log AS a ON a.seq = (SELECT MAX(x.seq) FROM audit_log AS x
  WHERE x.entidad = '${tabla}' AND x.entidad_id = ${clave} AND x.datos_despues IS NOT NULL)
WHERE ${diferencias}`,
    });
  }
  consultas.push({
    nombre: 'V5_auditoria_hasta_el_corte',
    sql: `SELECT MAX(seq) AS maximo, COUNT(*) AS filas FROM audit_log
HAVING MAX(seq) IS NOT ${String(C)} OR COUNT(*) IS NOT ${String(C)}`,
  });
  // N2: si `sqlite_sequence` quedara por encima de C, la próxima auditoría tomaría un seq con hueco
  // y `audit_log_seq_sin_saltos` rechazaría toda escritura auditada.
  consultas.push({
    nombre: 'V5_secuencia_de_auditoria',
    sql: `SELECT name, seq FROM sqlite_sequence WHERE name = 'audit_log' AND seq IS NOT ${String(C)}`,
  });
  consultas.push({
    nombre: 'V6_sync_aplicada_sin_efecto',
    sql: `SELECT s.mutation_id FROM sync_mutations AS s WHERE s.resultado = 'aplicada' AND NOT COALESCE(
  CASE s.tipo
    WHEN 'consumo.crear' THEN EXISTS (SELECT 1 FROM consumptions AS c
      WHERE c.id = json_extract(s.respuesta_json, '$.servidor.id'))
    WHEN 'consumo.editar' THEN EXISTS (SELECT 1 FROM consumptions AS c
      WHERE c.id = json_extract(s.respuesta_json, '$.servidor.id')
        AND c.version >= json_extract(s.respuesta_json, '$.servidor.version'))
    WHEN 'novedad.crear' THEN EXISTS (SELECT 1 FROM incidents AS i
      WHERE i.id = json_extract(s.respuesta_json, '$.servidor.id'))
    WHEN 'consumo.aprobar' THEN EXISTS (SELECT 1 FROM validations AS v
      WHERE v.id = json_extract(s.respuesta_json, '$.servidor.validacion.id'))
    WHEN 'consumo.rechazar' THEN EXISTS (SELECT 1 FROM validations AS v
      WHERE v.id = json_extract(s.respuesta_json, '$.servidor.validacion.id'))
    ELSE 0
  END, 0)`,
  });
  consultas.push({ nombre: 'V7_foreign_keys', sql: 'PRAGMA foreign_key_check' });
  consultas.push({
    nombre: 'V8_triggers',
    sql: `WITH esperados(n, s) AS (VALUES
  ${valoresEsperados(triggers)})
SELECT 'falta_o_distinto' AS problema, e.n AS nombre FROM esperados AS e WHERE NOT EXISTS (
  SELECT 1 FROM sqlite_master AS m WHERE m.type = 'trigger' AND m.name = e.n AND m.sql = e.s)
UNION ALL
SELECT 'sobra', m.name FROM sqlite_master AS m
  WHERE m.type = 'trigger' AND m.name NOT IN (SELECT n FROM esperados)
UNION ALL
SELECT 'guardia', name FROM sqlite_master WHERE name = '_restauracion_guardia'`,
  });
  for (const tabla of [...ORDEN_IMPORTACION, 'refresh_tokens']) {
    const esperadas = tabla === 'refresh_tokens' ? 0 : informe.tablas[tabla].importadas;
    consultas.push({
      nombre: `V9_conteo_${tabla}`,
      sql: `SELECT COUNT(*) AS filas, ${String(esperadas)} AS esperadas FROM ${tabla}
HAVING COUNT(*) IS NOT ${String(esperadas)}`,
    });
  }
  for (const tabla of TABLAS_AUDITADAS) {
    consultas.push({
      nombre: `V10_auditoria_huerfana_${tabla}`,
      sql: `SELECT a.seq, a.entidad_id FROM audit_log AS a WHERE a.entidad = '${tabla}' AND NOT EXISTS (
  SELECT 1 FROM ${tabla} AS r WHERE ${expresionClave(tabla)} = a.entidad_id)`,
    });
  }
  return consultas;
}

// ---------------------------------------------------------------------------------------------
// post-restauracion.sql (con los triggers ya activos)
// ---------------------------------------------------------------------------------------------

/** Cambio de época con su auditoría (docs/despliegue.md §9.1): las tablets reenvían lo perdido. */
export const SQL_POST_RESTAURACION = [
  `UPDATE settings SET valor = json_quote(lower(hex(randomblob(16)))),
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE clave = 'sync_epoca'`,
  `INSERT INTO audit_log (id, entidad, entidad_id, accion, actor_id, device_id, datos_antes,
  datos_despues, client_at, server_at, alerta_reloj, created_at, updated_at)
SELECT lower(hex(randomblob(16))), 'settings', 'sync_epoca', 'settings.epoca_restauracion', NULL,
  NULL, NULL, json_object('clave', clave, 'valor', json(valor)), NULL, updated_at, 0, updated_at,
  updated_at
FROM settings WHERE clave = 'sync_epoca'`,
];

/** Texto de un archivo .sql a partir de una lista de sentencias. */
export function archivoSql(sentencias, encabezado = []) {
  return `${[...encabezado.map((l) => `-- ${l}`), ...sentencias.map((s) => `${s};`)].join('\n')}\n`;
}
