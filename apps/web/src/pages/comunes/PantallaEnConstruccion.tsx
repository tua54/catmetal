import { EstadoVacio, Tarjeta } from '../../components/ui';

export interface PropsPantallaEnConstruccion {
  /** `<h1>` de la pantalla. */
  titulo: string;
  /** Qué hará la pantalla cuando esté lista. */
  descripcion: string;
}

/**
 * Marcador accesible de una pantalla de negocio que todavía no existe (supervisor: tarea 4.3; jefe
 * y admin: Fase 5). La ruta, la guarda y la barra superior ya funcionan.
 */
export function PantallaEnConstruccion({ titulo, descripcion }: PropsPantallaEnConstruccion) {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-ink-950">{titulo}</h1>
      <Tarjeta>
        <EstadoVacio
          nivelTitulo={2}
          titulo="Pantalla en construcción"
          texto={`${descripcion} Mientras tanto puede revisar el estado de sincronización desde el menú de su cuenta.`}
        />
      </Tarjeta>
    </div>
  );
}
