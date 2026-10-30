import { Aviso, Boton, EstadoVacio, IconoSinConexion, Tarjeta } from '../../components/ui';
import { esSinConexion, mensajeDeError, TEXTO_SIN_CONEXION, TITULO_SIN_CONEXION } from './errores';

/** La administración no funciona sin conexión: lo explica en lugar de fallar. */
export function SinConexionAdmin({ alReintentar }: { alReintentar?: () => void }) {
  return (
    <Tarjeta>
      <EstadoVacio
        nivelTitulo={2}
        icono={<IconoSinConexion className="size-7" />}
        titulo={TITULO_SIN_CONEXION}
        texto={TEXTO_SIN_CONEXION}
        accion={
          alReintentar ? (
            <Boton variante="secundario" onClick={alReintentar}>
              Reintentar
            </Boton>
          ) : undefined
        }
      />
    </Tarjeta>
  );
}

/** Error al LEER datos del servidor: sin red, la pantalla de "necesita conexión"; si no, el mensaje. */
export function ErrorConsulta({
  error,
  titulo,
  alReintentar,
}: {
  error: unknown;
  titulo: string;
  alReintentar: () => void;
}) {
  if (esSinConexion(error)) {
    return <SinConexionAdmin alReintentar={alReintentar} />;
  }
  return (
    <Aviso
      tono="error"
      anunciar
      titulo={titulo}
      accion={
        <Boton variante="secundario" onClick={alReintentar}>
          Reintentar
        </Boton>
      }
    >
      {mensajeDeError(error)}
    </Aviso>
  );
}

/** Texto de carga accesible. */
export function Cargando({ texto }: { texto: string }) {
  return (
    <p role="status" className="text-ink-500">
      {texto}
    </p>
  );
}
