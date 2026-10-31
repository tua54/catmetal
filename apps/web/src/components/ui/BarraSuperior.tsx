import type { ReactNode } from 'react';
import { Link } from 'react-router';
import logoCatmetal from '../../assets/brand/logo-catmetal.png';

export interface PropsBarraSuperior {
  /** Título de la pantalla: "Registro de Consumo", "Validación de Consumos". */
  titulo: string;
  /** "Orden OP-2026-0587 · Línea Moldeo 1" o "Panel del jefe · Rol: Aprobador". */
  subtitulo?: string;
  /** Hueco para la `<PildoraConexion>`. */
  conexion?: ReactNode;
  /** Hueco para el `<Avatar>` del usuario. */
  usuario?: ReactNode;
  /** Destino del logo (por defecto "/"). */
  enlaceInicio?: string;
}

/**
 * Barra superior (ADR 0011): ink-950 con línea inferior de 3 px en brand-600, logo blanco de
 * Catmetal, título (blanco, 18,88:1) y subtítulo (ink-300, 11,93:1). Título y subtítulo se truncan
 * con `title` en pantallas estrechas; en vertical estrecho, conexión y usuario bajan a otra fila.
 *
 * El título no es un encabezado: el `<h1>` lo pone cada página dentro de `<main>`.
 */
export function BarraSuperior({
  titulo,
  subtitulo,
  conexion,
  usuario,
  enlaceInicio = '/',
}: PropsBarraSuperior) {
  return (
    <header className="border-b-[3px] border-brand-600 bg-ink-950 pt-[env(safe-area-inset-top)] text-white">
      <div className="mx-auto flex min-h-[74px] w-full max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 sm:px-6">
        <Link
          to={enlaceInicio}
          className="flex min-h-11 shrink-0 items-center rounded-sm"
          aria-label="Catmetal · Inicio"
        >
          <img
            src={logoCatmetal}
            alt="Catmetal"
            width={180}
            height={36}
            className="h-7 w-auto sm:h-9"
          />
        </Link>
        <span aria-hidden="true" className="hidden h-10 w-px shrink-0 bg-white/25 sm:block" />
        <div className="min-w-40 flex-1">
          <p title={titulo} className="truncate text-base leading-snug font-semibold sm:text-lg">
            {titulo}
          </p>
          {subtitulo && (
            <p title={subtitulo} className="cifras truncate text-sm leading-snug text-ink-300">
              {subtitulo}
            </p>
          )}
        </div>
        {(conexion || usuario) && (
          <div className="flex max-w-full min-w-0 items-center gap-3">
            {conexion}
            {usuario}
          </div>
        )}
      </div>
    </header>
  );
}
