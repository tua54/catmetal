// Orquestación del Cron Trigger diario (`0 8 * * *`): backup de D1 a R2 y luego mantenimiento.
//
// Nunca lanza: un error del backup no impide el mantenimiento (ni al revés) y todo queda en logs
// estructurados sin datos personales (solo estados, conteos, nombres de tabla y el mensaje técnico
// del error, truncado).

import { registrar } from '../log';
import { ejecutarBackup, type ResultadoBackup } from './backup';
import { ejecutarMantenimiento } from './mantenimiento';
import { Presupuesto } from './presupuesto';

export interface DisparoCron {
  cron: string;
  scheduledTime: number;
}

export interface OpcionesCron {
  /** Momento de ejecución (por defecto, ahora). Define la fecha del backup. */
  ahora?: Date;
  presupuesto?: Presupuesto;
}

export interface ResultadoCron {
  backup: ResultadoBackup['estado'] | 'error';
  mantenimiento: 'hecho' | 'omitido' | 'error';
}

const MAX_MENSAJE_ERROR = 300;

export function describirError(error: unknown): string {
  const texto = error instanceof Error ? `${error.name}: ${error.message}` : 'Error desconocido';
  return texto.slice(0, MAX_MENSAJE_ERROR);
}

export async function ejecutarCron(
  env: Env,
  disparo: DisparoCron,
  opciones: OpcionesCron = {},
): Promise<ResultadoCron> {
  const ahora = opciones.ahora ?? new Date();
  const presupuesto = opciones.presupuesto ?? new Presupuesto();
  registrar('info', 'cron_ejecutado', {
    cron: disparo.cron,
    programado_para: new Date(disparo.scheduledTime).toISOString(),
  });

  let backup: ResultadoBackup | null = null;
  try {
    backup = await ejecutarBackup(env, ahora, { presupuesto });
    registrar(backup.estado === 'pausado' ? 'aviso' : 'info', 'backup_resumen', { ...backup });
  } catch (error) {
    registrar('error', 'backup_fallido', { error: describirError(error) });
  }

  // Si el backup del día ya estaba hecho (o lo lleva otra invocación), el mantenimiento ya corrió
  // en esa invocación: no se repite en las invocaciones de respaldo.
  const omitir =
    backup?.estado === 'ya_existia' || backup?.estado === 'en_curso_en_otra_invocacion';
  let mantenimiento: ResultadoCron['mantenimiento'] = 'omitido';
  if (!omitir) {
    try {
      await ejecutarMantenimiento(env, ahora, presupuesto);
      mantenimiento = 'hecho';
    } catch (error) {
      mantenimiento = 'error';
      registrar('error', 'mantenimiento_fallido', { error: describirError(error) });
    }
  }

  const resultado: ResultadoCron = { backup: backup?.estado ?? 'error', mantenimiento };
  registrar(
    resultado.backup === 'error' || mantenimiento === 'error' ? 'error' : 'info',
    'cron_fin',
    {
      ...resultado,
      operaciones: presupuesto.usadas,
      duracion_ms: presupuesto.transcurridoMs,
    },
  );
  return resultado;
}
