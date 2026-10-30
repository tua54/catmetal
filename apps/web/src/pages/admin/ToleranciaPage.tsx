import { formatearCantidad } from '@catmetal/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Aviso, Boton, Campo, DialogoConfirmacion, Tarjeta, useAvisos } from '../../components/ui';
import { apiAdmin, CLAVES_ADMIN } from '../../features/admin/api';
import {
  erroresDeCampo,
  esCodigo,
  esSinConexion,
  MENSAJE_CONFLICTO_TOLERANCIA,
  mensajeDeError,
} from '../../features/admin/errores';
import { Cargando, ErrorConsulta, SinConexionAdmin } from '../../features/admin/EstadosConsulta';
import { leerTolerancia } from '../../features/admin/formato';
import { useEnLinea } from '../../features/admin/formularios';

function porcentaje(valor: number): string {
  return `${formatearCantidad(valor)} %`;
}

/** `/admin/tolerancia`: margen global sobre lo planeado (S7). */
export function ToleranciaPage() {
  const enLinea = useEnLinea();
  const queryClient = useQueryClient();
  const avisos = useAvisos();
  const [texto, setTexto] = useState('');
  const [errorCampo, setErrorCampo] = useState<string | null>(null);
  const [nueva, setNueva] = useState<number | null>(null);
  const [aviso, setAviso] = useState<{
    tono: 'error' | 'advertencia';
    titulo: string;
    mensaje: string;
  } | null>(null);

  const configuracion = useQuery({
    queryKey: CLAVES_ADMIN.configuracion,
    queryFn: () => apiAdmin.leerConfiguracion(),
    enabled: enLinea,
  });
  const cambiar = useMutation({ mutationFn: (valor: number) => apiAdmin.cambiarTolerancia(valor) });

  const actual = configuracion.data?.tolerancia_pct;

  function enviar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    setAviso(null);
    const leido = leerTolerancia(texto);
    if ('error' in leido) {
      setErrorCampo(leido.error);
      return;
    }
    if (leido.valor === actual) {
      setErrorCampo(`La tolerancia ya es ${porcentaje(leido.valor)}.`);
      return;
    }
    setErrorCampo(null);
    setNueva(leido.valor);
  }

  function confirmar(valor: number) {
    cambiar.mutate(valor, {
      onSuccess: (respuesta) => {
        setNueva(null);
        setTexto('');
        queryClient.setQueryData(CLAVES_ADMIN.configuracion, respuesta);
        avisos.mostrar({
          tono: 'exito',
          titulo: 'Tolerancia actualizada',
          mensaje: `La tolerancia vigente es ${porcentaje(respuesta.tolerancia_pct)}.`,
        });
      },
      onError: (error) => {
        setNueva(null);
        if (esCodigo(error, 'CONFLICTO')) {
          setAviso({
            tono: 'advertencia',
            titulo: 'La tolerancia cambió',
            mensaje: MENSAJE_CONFLICTO_TOLERANCIA,
          });
        } else {
          const campo = erroresDeCampo(error).tolerancia_pct;
          if (campo !== undefined) {
            setErrorCampo(campo);
          } else {
            setAviso({
              tono: 'error',
              titulo: 'No se guardó',
              mensaje: mensajeDeError(error, true),
            });
          }
        }
        if (!esSinConexion(error)) {
          void configuracion.refetch();
        }
      },
    });
  }

  let contenido;
  if (actual === undefined) {
    contenido = !enLinea ? (
      <SinConexionAdmin />
    ) : configuracion.isError ? (
      <ErrorConsulta
        error={configuracion.error}
        titulo="No se pudo cargar la tolerancia"
        alReintentar={() => void configuracion.refetch()}
      />
    ) : (
      <Cargando texto="Cargando la tolerancia…" />
    );
  } else {
    const ejemplo = formatearCantidad(Math.round((100 + actual) * 1000) / 1000);
    contenido = (
      <div className="flex flex-col gap-6">
        <p className="text-lg text-ink-950">
          Tolerancia vigente: <strong className="cifras text-2xl">{porcentaje(actual)}</strong>
        </p>
        <div className="max-w-prose text-base text-ink-700">
          <p>
            Es el margen permitido sobre lo planeado. Si el consumo acumulado de un material en una
            orden supera lo planeado más este porcentaje, el supervisor debe registrar una novedad
            que lo justifique, y el jefe no puede validar ese consumo hasta que la tenga.
          </p>
          <p className="mt-2">
            {`Ejemplo: con ${porcentaje(actual)} y 100 kg planeados, la novedad es obligatoria cuando el consumo pasa de ${ejemplo} kg.`}
          </p>
        </div>
        <form noValidate onSubmit={enviar} className="flex flex-col gap-4 sm:max-w-sm">
          <Campo
            etiqueta="Nueva tolerancia"
            requerido
            numerico
            sufijo="%"
            ayuda="Entre 0 y 100, con hasta 2 decimales."
            value={texto}
            error={errorCampo ?? undefined}
            onChange={(evento) => {
              setTexto(evento.target.value);
              setErrorCampo(null);
            }}
          />
          <div>
            <Boton type="submit" tamano="grande">
              Cambiar tolerancia
            </Boton>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {aviso && (
        <Aviso tono={aviso.tono} anunciar titulo={aviso.titulo} alCerrar={() => setAviso(null)}>
          {aviso.mensaje}
        </Aviso>
      )}
      <Tarjeta titulo="Tolerancia sobre lo planeado" acento>
        {contenido}
      </Tarjeta>
      <DialogoConfirmacion
        abierto={nueva !== null && actual !== undefined}
        titulo={
          nueva !== null && actual !== undefined
            ? `¿Cambiar la tolerancia de ${porcentaje(actual)} a ${porcentaje(nueva)}?`
            : ''
        }
        descripcion="Aplica a todas las órdenes desde ahora: el servidor la usa para decidir qué consumos que reciba requieren novedad, y para marcar los materiales que superan lo planeado."
        textoConfirmar="Cambiar tolerancia"
        cargando={cambiar.isPending}
        alCancelar={() => {
          if (!cambiar.isPending) {
            setNueva(null);
          }
        }}
        alConfirmar={() => {
          if (nueva !== null) {
            confirmar(nueva);
          }
        }}
      />
    </div>
  );
}
