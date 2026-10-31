// Presupuesto de consultas de `/sync/push` (B12; docs/spec.md §6 Worker; docs/notas-plataforma.md).
//
// D1 (Workers Paid) admite como máximo 1000 consultas por invocación. En contención, cada mutación
// del lote puede gastar hasta `MAX_INTENTOS` intentos completos (lecturas del comando + su batch),
// así que un lote de 25 puede acercarse al límite (medido en las pruebas: más de 900 en el peor
// caso real antes de B12). El push cuenta cada sentencia que manda a D1 y, ANTES de cada paso que
// puede gastar consultas (empezar una mutación, cada intento, clasificar un error), exige que quede
// al menos `COSTO_MAXIMO_PASO`. Si no queda, corta el lote limpiamente: lo ya procesado tiene su
// resultado y lo demás queda sin resultado (el cliente lo reenvía, igual que tras un error
// transitorio). Un corte entre pasos nunca deja nada a medias: cada escritura es un batch atómico.
//
// Se cuenta cada sentencia, también las de un `batch` (D1 cuenta cada una como una consulta).

/** Límite de D1 por invocación del Worker (plan Workers Paid). */
export const LIMITE_CONSULTAS_D1 = 1000;

/**
 * Consultas que puede gastar el procesamiento del lote. El resto hasta `LIMITE_CONSULTAS_D1` queda
 * para lo demás de la invocación (autenticación, época, `marcarSincronizado`) y como margen.
 */
export const PRESUPUESTO_CONSULTAS_PUSH = 800;

/**
 * Cota del costo de un paso entre dos comprobaciones. El paso más caro medido es un intento de
 * `novedad.crear` con 5 evidencias o de `consumo.crear` con `corrige_a` (unas 20 sentencias); la
 * cota deja más del doble de margen.
 */
export const COSTO_MAXIMO_PASO = 40;

/** Se agotó el presupuesto: el lote se corta antes de este paso. */
export class ErrorPresupuestoAgotado extends Error {
  constructor(readonly usadas: number) {
    super('Se agotó el presupuesto de consultas del push');
    this.name = 'ErrorPresupuestoAgotado';
  }
}

/** Contador de consultas con su límite. */
export class PresupuestoConsultas {
  #usadas = 0;

  constructor(readonly limite: number = PRESUPUESTO_CONSULTAS_PUSH) {}

  get usadas(): number {
    return this.#usadas;
  }

  sumar(consultas: number): void {
    this.#usadas += consultas;
  }

  /** Lanza `ErrorPresupuestoAgotado` si no alcanza para un paso más (`costo` consultas). */
  exigir(costo: number = COSTO_MAXIMO_PASO): void {
    if (this.#usadas + costo > this.limite) {
      throw new ErrorPresupuestoAgotado(this.#usadas);
    }
  }

  /** `db` que cuenta cada sentencia en este presupuesto y delega en la D1 real. */
  envolver(db: D1Database): D1Database {
    return new D1Contada(db, this);
  }
}

/** Sentencia que cuenta su ejecución y delega en la real (que es la que va en el `batch`). */
class SentenciaContada implements D1PreparedStatement {
  constructor(
    readonly real: D1PreparedStatement,
    private readonly presupuesto: PresupuestoConsultas,
  ) {}

  bind(...valores: unknown[]): D1PreparedStatement {
    return new SentenciaContada(this.real.bind(...valores), this.presupuesto);
  }

  first<T = unknown>(colName: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  first<T>(colName?: string): Promise<T | null> {
    this.presupuesto.sumar(1);
    return colName === undefined ? this.real.first<T>() : this.real.first<T>(colName);
  }

  run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.presupuesto.sumar(1);
    return this.real.run<T>();
  }

  all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.presupuesto.sumar(1);
    return this.real.all<T>();
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<[string[], ...T[]] | T[]> {
    this.presupuesto.sumar(1);
    return options?.columnNames === true
      ? this.real.raw<T>({ columnNames: true })
      : this.real.raw<T>({ columnNames: false });
  }
}

const realDe = (sentencia: D1PreparedStatement): D1PreparedStatement =>
  sentencia instanceof SentenciaContada ? sentencia.real : sentencia;

class D1Contada implements D1Database {
  constructor(
    private readonly real: D1Database,
    private readonly presupuesto: PresupuestoConsultas,
  ) {}

  prepare(query: string): D1PreparedStatement {
    return new SentenciaContada(this.real.prepare(query), this.presupuesto);
  }

  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.presupuesto.sumar(statements.length);
    return this.real.batch<T>(statements.map(realDe));
  }

  // El push no usa `exec`, sesiones ni `dump`: escaparían del conteo, así que no se ofrecen.
  exec(): Promise<D1ExecResult> {
    return Promise.reject(new Error('exec no está disponible en la D1 con presupuesto del push'));
  }

  withSession(): D1DatabaseSession {
    throw new Error('withSession no está disponible en la D1 con presupuesto del push');
  }

  dump(): Promise<ArrayBuffer> {
    return Promise.reject(new Error('dump no está disponible en la D1 con presupuesto del push'));
  }
}
