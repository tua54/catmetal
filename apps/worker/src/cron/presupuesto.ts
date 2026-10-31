// Presupuesto de una invocación del cron (ADR 0014, enmendada por la ADR 0016).
//
// Dos contadores separados (revisión de la Fase 3, A3):
// - D1: Workers Paid admite 1000 consultas a D1 por invocación (un `batch()` cuenta como una). El
//   tope es 950 para dejar margen. Lo comparten el backup y el mantenimiento de la misma invocación.
// - R2: cada operación de R2 es una subrequest; el límite de la plataforma (10.000 por invocación en
//   Paid) queda muy por encima del tope de 1000. El backup hace pocas (las partes son de 5 MiB).
// Un Cron Trigger con intervalo ≥ 1 h puede usar hasta 15 min de CPU; el tope de tiempo de reloj
// (10 min) cierra la invocación con margen.
//
// `maxOperaciones` es un tope CONJUNTO opcional (D1 + R2), sin límite por defecto: lo usan las
// pruebas para forzar pausas con pocas operaciones.
//
// El tiempo se mide con `Date.now()`, que en workerd solo avanza con la E/S: aproxima el tiempo de
// reloj, no el de CPU (el límite de CPU se configura con `limits.cpu_ms`, ver docs/despliegue.md).

export const MAX_CONSULTAS_D1_POR_INVOCACION = 950;
export const MAX_OPERACIONES_R2_POR_INVOCACION = 1000;
export const MAX_MS_POR_INVOCACION = 10 * 60_000;

export interface OpcionesPresupuesto {
  maxConsultasD1?: number;
  maxOperacionesR2?: number;
  /** Tope conjunto D1 + R2 (por defecto, sin límite). */
  maxOperaciones?: number;
  maxMs?: number;
  /** Reloj inyectable (pruebas). */
  reloj?: () => number;
}

/** Operaciones que hay que dejar libres para cerrar ordenadamente. */
export interface Reserva {
  d1?: number;
  r2?: number;
}

export class Presupuesto {
  readonly maxConsultasD1: number;
  readonly maxOperacionesR2: number;
  readonly maxOperaciones: number;
  readonly maxMs: number;
  private readonly reloj: () => number;
  private readonly inicio: number;
  private d1 = 0;
  private r2 = 0;

  constructor(opciones: OpcionesPresupuesto = {}) {
    this.maxConsultasD1 = opciones.maxConsultasD1 ?? MAX_CONSULTAS_D1_POR_INVOCACION;
    this.maxOperacionesR2 = opciones.maxOperacionesR2 ?? MAX_OPERACIONES_R2_POR_INVOCACION;
    this.maxOperaciones = opciones.maxOperaciones ?? Number.POSITIVE_INFINITY;
    this.maxMs = opciones.maxMs ?? MAX_MS_POR_INVOCACION;
    this.reloj = opciones.reloj ?? Date.now;
    this.inicio = this.reloj();
  }

  get usadasD1(): number {
    return this.d1;
  }

  get usadasR2(): number {
    return this.r2;
  }

  /** Operaciones gastadas en la invocación (consultas D1 + llamadas a R2). */
  get usadas(): number {
    return this.d1 + this.r2;
  }

  get transcurridoMs(): number {
    return this.reloj() - this.inicio;
  }

  consumirD1(n = 1): void {
    this.d1 += n;
  }

  consumirR2(n = 1): void {
    this.r2 += n;
  }

  /**
   * ¿Queda presupuesto para una consulta más a D1 (y las operaciones de R2 que pueda causar),
   * dejando libre la `reserva` de cada contador?
   */
  disponible(reserva: Reserva = {}): boolean {
    const d1 = reserva.d1 ?? 0;
    const r2 = reserva.r2 ?? 0;
    return (
      this.d1 + d1 + 1 <= this.maxConsultasD1 &&
      this.r2 + r2 <= this.maxOperacionesR2 &&
      this.usadas + d1 + r2 + 1 <= this.maxOperaciones &&
      this.transcurridoMs < this.maxMs
    );
  }
}
