// Orquestación de los Cron Triggers (ADR 0014, enmendada por la ADR 0016):
//
// - `0 8 * * *` (inicio, 03:00 en Bogotá): backup de D1 a R2 y luego mantenimiento.
// - `0 9-13 * * *` (continuaciones horarias): solo continúan un backup del día que quedó en pausa.
//   No inician uno nuevo ni repiten el mantenimiento. Si la de las 13:00 UTC (la última del día)
//   termina sin backup completo, registra el error `backup_incompleto_del_dia`.
// - Cualquier otra expresión (por ejemplo, un disparo manual en `wrangler dev`) se trata como inicio.
//
// Nunca lanza: un error del backup no impide el mantenimiento (ni al revés) y todo queda en logs
// estructurados sin datos personales (solo estados, conteos, nombres de tabla y el mensaje técnico
// del error, truncado).

import { registrar } from '../log';
import {
  ejecutarBackup,
  fechaBackup,
  type ModoBackup,
  type OpcionesBackup,
  type ResultadoBackup,
} from './backup';
import { describirError } from './errores';
import { ejecutarMantenimiento } from './mantenimiento';
import { Presupuesto } from './presupuesto';
import { INCOMPLETAS_ADMITIDAS_RESTAURACION } from './tablas';

export { describirError };

export const CRON_INICIO = '0 8 * * *';
export const CRON_CONTINUACION = '0 9-13 * * *';
/** Hora UTC de la última continuación del día (la de `CRON_CONTINUACION`). */
export const HORA_ULTIMA_CONTINUACION_UTC = 13;

export interface DisparoCron {
  cron: string;
  scheduledTime: number;
}

export interface OpcionesCron {
  /** Momento de ejecución (por defecto, ahora). Define la fecha del backup. */
  ahora?: Date;
  presupuesto?: Presupuesto;
  /** Opciones del backup inyectables solo en las pruebas (medidor, fallos y tamaños). */
  opcionesBackup?: Pick<
    OpcionesBackup,
    'tamanoPagina' | 'maxBytesPagina' | 'observarPagina' | 'fallarEn'
  >;
}

export interface ResultadoCron {
  backup: ResultadoBackup['estado'] | 'error';
  mantenimiento: 'hecho' | 'omitido' | 'error';
}

export function modoDeCron(cron: string): ModoBackup {
  return cron === CRON_CONTINUACION ? 'continuacion' : 'inicio';
}

export async function ejecutarCron(
  env: Env,
  disparo: DisparoCron,
  opciones: OpcionesCron = {},
): Promise<ResultadoCron> {
  const ahora = opciones.ahora ?? new Date();
  const presupuesto = opciones.presupuesto ?? new Presupuesto();
  const modo = modoDeCron(disparo.cron);
  registrar('info', 'cron_ejecutado', {
    cron: disparo.cron,
    modo,
    programado_para: new Date(disparo.scheduledTime).toISOString(),
  });

  let backup: ResultadoBackup | null = null;
  try {
    backup = await ejecutarBackup(env, ahora, { ...opciones.opcionesBackup, presupuesto, modo });
    if (backup.estado === 'parcial') {
      // ADR 0020: el día terminó sin alguna tabla (cada una ya registró `backup_tabla_incompleta`
      // con su motivo). Los logs no admiten listas: las tablas van separadas por coma.
      const { tablas_incompletas: incompletas, ...resto } = backup;
      const tablasIncompletas = incompletas.join(',');
      registrar('aviso', 'backup_resumen', { ...resto, tablas_incompletas: tablasIncompletas });
      registrar('error', 'backup_parcial', {
        fecha: backup.fecha,
        tablas_incompletas: tablasIncompletas,
      });
      // R-03: con una tabla incompleta que la restauración no admite, el día no sirve para restaurar
      // desde R2 (solo queda Time Travel): es un error distinto, para alertar aunque haya manifest.
      const noAdmitidas = incompletas.filter(
        (t) => !INCOMPLETAS_ADMITIDAS_RESTAURACION.includes(t),
      );
      if (noAdmitidas.length > 0) {
        registrar('error', 'backup_no_restaurable', {
          fecha: backup.fecha,
          tablas: noAdmitidas.join(','),
        });
      }
    } else {
      const nivel =
        backup.estado === 'pausado' || backup.estado === 'sin_iniciar' ? 'aviso' : 'info';
      registrar(nivel, 'backup_resumen', { ...backup });
    }
  } catch (error) {
    registrar('error', 'backup_fallido', { error: describirError(error) });
  }

  const ultimaDelDia =
    modo === 'continuacion' &&
    new Date(disparo.scheduledTime).getUTCHours() === HORA_ULTIMA_CONTINUACION_UTC;
  // Un backup `parcial` también terminó (tiene manifest): no es un día sin backup.
  const completo =
    backup?.estado === 'completo' ||
    backup?.estado === 'parcial' ||
    backup?.estado === 'ya_existia';
  if (ultimaDelDia && !completo) {
    // Ya no habrá más continuaciones hoy: el día queda sin backup completo (sin manifest).
    registrar('error', 'backup_incompleto_del_dia', {
      fecha: backup?.fecha ?? fechaBackup(ahora),
      estado: backup?.estado ?? 'error',
    });
  }

  // El mantenimiento solo corre en el inicio. Si el backup del día ya estaba hecho (o lo lleva otra
  // invocación), el mantenimiento ya corrió en esa invocación: no se repite.
  const omitir =
    modo === 'continuacion' ||
    backup?.estado === 'ya_existia' ||
    backup?.estado === 'en_curso_en_otra_invocacion';
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
      consultas_d1: presupuesto.usadasD1,
      operaciones_r2: presupuesto.usadasR2,
      duracion_ms: presupuesto.transcurridoMs,
    },
  );
  return resultado;
}
