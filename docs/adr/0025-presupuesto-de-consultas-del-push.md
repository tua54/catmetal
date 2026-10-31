# ADR 0025 — Presupuesto de consultas por invocación de `/sync/push`

- Estado: aceptado
- Fecha: 2026-10-30
- Fase: correcciones-v1.1 (ítem B12)
- Enmienda: ADR 0016 (procesamiento del lote), en lo que se refiere al límite de consultas

## Contexto

D1 en Workers Paid admite como máximo 1000 consultas por invocación. Cada mutación del push se reintenta hasta `MAX_INTENTOS` cuando pierde una carrera. En el peor caso medido (25 `consumo.crear` con `corrige_a`, que aplican en su tercer intento por contención), el lote usaba 925 consultas, a un 7 % del límite y sin ningún tope. Si se supera el límite, la invocación falla a mitad de lote.

## Opciones consideradas

1. **Bajar `MAX_INTENTOS` o el tamaño del lote.** Reduce el rendimiento normal y no garantiza el límite si cambian los comandos.
2. **Contar las consultas reales y cortar el lote antes del límite.** Las mutaciones que quedan fuera se dejan sin resultado y el cliente las reenvía, como con un error transitorio.

## Decisión

Se adopta la opción 2.

- `apps/worker/src/sync/presupuesto.ts` envuelve la D1 del lote (`PresupuestoConsultas.envolver`) y cuenta cada `first`, `run`, `all` y `raw`, y cada sentencia de un `batch`. A `batch` le pasa las sentencias reales. `exec`, `withSession` y `dump` fallan, porque escaparían del conteo.
- Constantes:
  - `LIMITE_CONSULTAS_D1 = 1000`;
  - `PRESUPUESTO_CONSULTAS_PUSH = 800`, que deja 200 para lo que va fuera del lote (sesión, época y registro del dispositivo);
  - `COSTO_MAXIMO_PASO = 40`, una cota por paso: el más caro medido ronda las 20 sentencias.
- El presupuesto se exige en tres puntos donde no hay nada escrito a medias: al empezar cada mutación, antes de cada intento en `aplicar` y antes de clasificar un error. Si se agota, el lote se corta como con un error transitorio y se registra el aviso `sync_push_presupuesto_agotado`.
- El contrato no cambia. Las mutaciones cortadas no tienen resultado, y el motor del cliente las deja pendientes con backoff.

## Consecuencias

- Un push nunca supera las 1000 consultas. En el peor caso medido se procesan 20 mutaciones y se cortan 5, que aplican al reenviarse, sin fila en `sync_mutations`, sin consumo y sin auditoría parciales.
- Sin contención, los lotes pesados (por ejemplo 25 novedades con 5 evidencias) no se cortan.
- Si un comando nuevo cuesta más de 40 sentencias por paso, hay que subir `COSTO_MAXIMO_PASO`. La prueba `correcciones-b12-presupuesto-push.test.ts` mide el peor caso.

## Cómo revertir

Quitar el envoltorio de `procesarLote` y los tres puntos de control. El lote vuelve a depender de que el peor caso quede por debajo de 1000.
