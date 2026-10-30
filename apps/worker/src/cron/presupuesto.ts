// Presupuesto de una invocación del cron (ADR 0014).
//
// Workers Paid admite 1000 consultas a D1 por invocación (un `batch()` cuenta como una) y un Cron
// Trigger puede durar hasta 15 min de reloj. El presupuesto cuenta, de forma conservadora, cada
// consulta a D1 Y cada operación de R2 en el mismo contador, con un tope de 800 para dejar margen.
// Lo comparten el backup y el mantenimiento de la misma invocación.
//
// El tiempo se mide con `Date.now()`, que en workerd solo avanza con la E/S: aproxima el tiempo de
// reloj, no el de CPU (el límite de CPU se configura con `limits.cpu_ms`, ver docs/despliegue.md).

export const MAX_OPERACIONES_POR_INVOCACION = 800;
export const MAX_MS_POR_INVOCACION = 10 * 60_000;

export interface OpcionesPresupuesto {
  maxOperaciones?: number;
  maxMs?: number;
  /** Reloj inyectable (pruebas). */
  reloj?: () => number;
}

export class Presupuesto {
  readonly maxOperaciones: number;
  readonly maxMs: number;
  private readonly reloj: () => number;
  private readonly inicio: number;
  private usadasHastaAhora = 0;

  constructor(opciones: OpcionesPresupuesto = {}) {
    this.maxOperaciones = opciones.maxOperaciones ?? MAX_OPERACIONES_POR_INVOCACION;
    this.maxMs = opciones.maxMs ?? MAX_MS_POR_INVOCACION;
    this.reloj = opciones.reloj ?? Date.now;
    this.inicio = this.reloj();
  }

  /** Operaciones (consultas D1 + llamadas a R2) gastadas en la invocación. */
  get usadas(): number {
    return this.usadasHastaAhora;
  }

  get transcurridoMs(): number {
    return this.reloj() - this.inicio;
  }

  consumir(n = 1): void {
    this.usadasHastaAhora += n;
  }

  /** ¿Queda presupuesto para una operación más, reservando `reserva` operaciones para cerrar? */
  disponible(reserva = 0): boolean {
    return (
      this.usadasHastaAhora + reserva + 1 <= this.maxOperaciones && this.transcurridoMs < this.maxMs
    );
  }
}
