// Aprobar o rechazar un consumo de la cola (docs/spec.md §3, S5, S9; ADR 0010).
//
// - Con servidor: REST `POST /consumptions/:id/approve|reject` con la `version` que vio el jefe.
// - Sin servidor (sin red, sesión offline o que pide contraseña): se encola `consumo.aprobar` o
//   `consumo.rechazar` en el outbox (`aprobarLocal`/`rechazarLocal`) con el MISMO id y versión, y
//   el motor de sync lo envía al volver la señal. Si la respuesta REST se perdió después de
//   aplicarse, el envío por el outbox reutiliza el id: el servidor no puede duplicar la decisión.

import { ahoraIso, uuidv7, type ElementoCola } from '@catmetal/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSincronizacion } from '../../app/contexto-sincronizacion';
import { ErrorApi, useSesion } from '../../auth';
import { useAvisos } from '../../components/ui';
import { aprobarLocal, ErrorDatosLocales, rechazarLocal } from '../../datos';
import { useEstadoSync } from '../../sync';
import { aprobarEnServidor, CLAVES_JEFE, rechazarEnServidor } from './api';
import { esFaltaDeServidor, mensajeDeError } from './mensajes';

export interface PeticionDecision {
  elemento: ElementoCola;
  decision: 'aprobado' | 'rechazado';
  /** Obligatorio (3–500) para rechazar; lo valida el diálogo y el esquema del contrato. */
  motivo?: string;
}

export interface ResultadoDecision {
  /** `servidor`: aplicada por REST. `tablet`: guardada en el outbox, pendiente de sync. */
  via: 'servidor' | 'tablet';
}

/** Aviso para 409/422/403 de la validación: qué pasó y qué hacer. */
function avisoDeError(error: unknown): { titulo: string; mensaje: string; recargar: boolean } {
  if (error instanceof ErrorApi) {
    switch (error.code) {
      case 'CONFLICTO':
        return {
          titulo: 'El consumo cambió mientras lo revisaba',
          mensaje:
            'El supervisor lo editó o le agregó una novedad. La cola se actualizó: revíselo de nuevo antes de decidir.',
          recargar: true,
        };
      case 'CONSUMO_NO_PENDIENTE':
        return {
          titulo: 'El consumo ya fue decidido',
          mensaje: 'Otro jefe ya lo validó o lo rechazó. La cola se actualizó.',
          recargar: true,
        };
      case 'REQUIERE_NOVEDAD':
        return { titulo: 'Falta la novedad', mensaje: error.message, recargar: true };
      case 'AUTOAPROBACION':
        return { titulo: 'Requiere otro jefe', mensaje: error.message, recargar: false };
      case 'NO_ENCONTRADO':
        return {
          titulo: 'El consumo ya no está disponible',
          mensaje: 'No se encontró el consumo. La cola se actualizó.',
          recargar: true,
        };
      default:
        break;
    }
  }
  if (error instanceof ErrorDatosLocales) {
    switch (error.code) {
      case 'NO_ENCONTRADO':
        // El consumo no llegó a esta tablet en la última sincronización.
        return {
          titulo: 'No se pudo guardar sin conexión',
          mensaje:
            'Este consumo aún no está guardado en esta tablet. Cuando vuelva la conexión podrá decidirlo; para trabajar sin señal, sincronice antes.',
          recargar: false,
        };
      case 'CONSUMO_NO_PENDIENTE':
        return {
          titulo: 'El consumo ya tiene una decisión',
          mensaje:
            'Ya hay una decisión guardada para este consumo o el servidor ya lo decidió. Revise el estado de sincronización.',
          recargar: false,
        };
      default:
        break;
    }
  }
  return {
    titulo: 'No se pudo guardar la decisión',
    mensaje: mensajeDeError(error),
    recargar: false,
  };
}

export function useDecisionConsumo() {
  const clienteQuery = useQueryClient();
  const { cambioLocal } = useSincronizacion();
  const avisos = useAvisos();
  const userId = useSesion((estado) => estado.usuario?.id ?? null);
  const modo = useSesion((estado) => estado.modo);
  const conexion = useEstadoSync((estado) => estado.conexion);

  return useMutation<ResultadoDecision, unknown, PeticionDecision>({
    // La red la decide esta función (cae al outbox); TanStack no debe pausar la mutación offline.
    networkMode: 'always',
    mutationFn: async ({ elemento, decision, motivo }) => {
      if (userId === null) {
        throw new ErrorApi('NO_AUTENTICADO', 401);
      }
      const base = { id: uuidv7(), version: elemento.version, client_created_at: ahoraIso() };

      const guardarEnTablet = async (): Promise<ResultadoDecision> => {
        const entrada = { ...base, consumption_id: elemento.id };
        if (decision === 'aprobado') {
          await aprobarLocal(userId, entrada);
        } else {
          await rechazarLocal(userId, { ...entrada, motivo: motivo ?? '' });
        }
        cambioLocal();
        return { via: 'tablet' };
      };

      if (modo !== 'online' || conexion === 'sin_conexion') {
        return guardarEnTablet();
      }
      try {
        if (decision === 'aprobado') {
          await aprobarEnServidor(elemento.id, base);
        } else {
          await rechazarEnServidor(elemento.id, { ...base, motivo: motivo ?? '' });
        }
        return { via: 'servidor' };
      } catch (error) {
        if (esFaltaDeServidor(error)) {
          return guardarEnTablet();
        }
        throw error;
      }
    },
    onSuccess: ({ via }, { decision, elemento }) => {
      const accion = decision === 'aprobado' ? 'validado' : 'rechazado';
      avisos.mostrar(
        via === 'servidor'
          ? {
              tono: 'exito',
              titulo: `Consumo ${accion}`,
              mensaje: `${elemento.material.nombre} · orden ${elemento.orden.codigo}.`,
            }
          : {
              tono: 'info',
              titulo: `Consumo ${accion} en esta tablet`,
              mensaje: 'Pendiente de sync: se enviará al servidor cuando vuelva la conexión.',
            },
      );
      if (via === 'servidor') {
        void clienteQuery.invalidateQueries({ queryKey: CLAVES_JEFE.cola });
        void clienteQuery.invalidateQueries({ queryKey: CLAVES_JEFE.resumen(elemento.order_id) });
        void clienteQuery.invalidateQueries({
          queryKey: CLAVES_JEFE.lineaTiempo(elemento.order_id),
        });
      }
    },
    onError: (error) => {
      const { titulo, mensaje, recargar } = avisoDeError(error);
      avisos.mostrar({ tono: recargar ? 'advertencia' : 'error', titulo, mensaje });
      if (recargar) {
        void clienteQuery.invalidateQueries({ queryKey: CLAVES_JEFE.cola });
      }
    },
  });
}
