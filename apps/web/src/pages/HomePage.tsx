/** Página provisional de inicio. Las pantallas de negocio se construyen en las Fases 4 y 5. */
export function HomePage() {
  return (
    <section aria-labelledby="titulo-inicio" className="rounded-xl bg-white p-6 shadow-sm">
      <h1 id="titulo-inicio" className="text-2xl font-bold text-ink-950">
        Control de Materia Prima
      </h1>
      <span aria-hidden="true" className="mt-3 block h-[3px] w-16 bg-brand-600" />
      <p className="mt-4 text-ink-500">
        Catmetal S.A.S. · Registro y validación de consumos en planta.
      </p>
    </section>
  );
}
