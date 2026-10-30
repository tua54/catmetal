#!/usr/bin/env node
// `pnpm test:lighthouse`: Lighthouse con perfil de TABLET sobre la PWA servida localmente
// (docs/spec.md §10, Fase 6: Performance, Accessibility y Best Practices >= 90).
//
// - Usa el Chromium de Playwright (sin descargar nada más) con un perfil persistente por rol y el
//   puerto de depuración remota; Lighthouse se conecta por ese puerto.
// - Levanta el servidor E2E (scripts/e2e-servidor.mjs: build + D1 local aislada + wrangler dev en el
//   puerto 8788) si no hay uno en marcha; si ya lo hay, lo reutiliza y no lo detiene.
// - Las pantallas con sesión se auditan tras iniciar sesión por la interfaz con usuarios CREADOS por
//   API para esta ejecución (admin del seed -> supervisor, jefe y admin nuevos). La sesión sobrevive
//   a la navegación de Lighthouse por la cookie de refresco y `disableStorageReset`.
// - Perfil de tablet: viewport 1180x820 horizontal, `formFactor: 'mobile'` con emulación de pantalla
//   táctil, agente de usuario de tablet Android y la limitación simulada por defecto de Lighthouse
//   móvil (4G lento, CPU x4): es más exigente que una tablet de planta con buena señal.
// - Resultados: JSON completo y HTML en test-results/lighthouse/ (ignorado por git) y el resumen
//   (puntuaciones y auditorías por debajo de 1) en docs/evidencia/lighthouse/resumen.json.
// - Sale con código 1 si alguna categoría de alguna URL queda por debajo de 90.
//
// Solo local. Node puro; funciona en Windows y Linux.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { chromium } from '@playwright/test';
import lighthouse from 'lighthouse';
import { CONTRASENA_E2E, ORIGEN_E2E, RAIZ, URL_SALUD_E2E } from './e2e-config.mjs';

const UMBRAL = 90;
const CATEGORIAS = ['performance', 'accessibility', 'best-practices'];
const PUERTO_DEPURACION = 9333;
// Lighthouse recomienda varias corridas y quedarse con la mediana: el Total Blocking Time varía mucho
// entre ejecuciones (p. ej. 40 a 400 ms en la misma pantalla). Cambiar con LIGHTHOUSE_CORRIDAS.
const CORRIDAS = Math.max(1, Number(process.env.LIGHTHOUSE_CORRIDAS ?? 3));
const ESTADO_WINDOWS = process.platform === 'win32';
const DIR_RESULTADOS = join(RAIZ, 'test-results', 'lighthouse');
const DIR_EVIDENCIA = join(RAIZ, 'docs', 'evidencia', 'lighthouse');
const ORDEN_0587 = '019a3000-0003-7000-8000-000000000001';
const MATERIAL_ARENA = '019a3000-0002-7000-8000-000000000001';

const VIEWPORT = { width: 1180, height: 820 };
// Tablet Android (sin "Mobile" en el agente de usuario, como las tablets reales).
const USER_AGENT_TABLET =
  'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const CONFIG_TABLET = {
  formFactor: 'mobile',
  screenEmulation: {
    mobile: true,
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 2,
    disabled: false,
  },
  emulatedUserAgent: USER_AGENT_TABLET,
  throttlingMethod: 'simulate',
  // Valores por defecto de Lighthouse móvil, explícitos para que el informe los deje documentados.
  throttling: {
    rttMs: 150,
    throughputKbps: 1638.4,
    requestLatencyMs: 562.5,
    downloadThroughputKbps: 1474.56,
    uploadThroughputKbps: 675,
    cpuSlowdownMultiplier: 4,
  },
  onlyCategories: CATEGORIAS,
};

function paso(texto) {
  console.log(`[lighthouse] ${texto}`);
}

// ---------------------------------------------------------------------------------------------
// Servidor E2E
// ---------------------------------------------------------------------------------------------
async function servidorListo() {
  try {
    const respuesta = await fetch(URL_SALUD_E2E);
    return respuesta.ok;
  } catch {
    return false;
  }
}

let servidor = null;

async function levantarServidor() {
  if (await servidorListo()) {
    paso(`Se reutiliza el servidor que ya responde en ${ORIGEN_E2E}.`);
    return;
  }
  paso('Levantando el servidor E2E (build, migraciones, seed y wrangler dev)…');
  servidor = spawn(process.execPath, [join(RAIZ, 'scripts', 'e2e-servidor.mjs')], {
    cwd: RAIZ,
    stdio: ['ignore', 'ignore', 'inherit'],
    detached: !ESTADO_WINDOWS,
    windowsHide: true,
  });
  const limite = Date.now() + 300_000;
  while (!(await servidorListo())) {
    if (servidor.exitCode !== null || Date.now() > limite) {
      throw new Error('El servidor E2E no llegó a estar listo.');
    }
    await new Promise((resolver) => setTimeout(resolver, 1000));
  }
}

function detenerServidor() {
  if (servidor === null || servidor.exitCode !== null || servidor.pid === undefined) {
    return;
  }
  if (ESTADO_WINDOWS) {
    spawnSync('taskkill', ['/PID', String(servidor.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-servidor.pid, 'SIGTERM');
    } catch {
      servidor.kill('SIGTERM');
    }
  }
}

// ---------------------------------------------------------------------------------------------
// API (usuarios de la ejecución)
// ---------------------------------------------------------------------------------------------
function uuidV7() {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function api(ruta, { metodo = 'GET', token, cuerpo } = {}) {
  const respuesta = await fetch(`${ORIGEN_E2E}/api/v1${ruta}`, {
    method: metodo,
    headers: {
      Origin: ORIGEN_E2E,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cuerpo === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
  });
  if (!respuesta.ok) {
    throw new Error(`${metodo} ${ruta}: HTTP ${respuesta.status} ${await respuesta.text()}`);
  }
  return await respuesta.json();
}

async function login(email) {
  const cuerpo = await api('/auth/login', {
    metodo: 'POST',
    cuerpo: { email, password: CONTRASENA_E2E, device_id: uuidV7() },
  });
  return cuerpo.access_token;
}

async function prepararUsuarios() {
  const sufijo = randomBytes(3).toString('hex');
  const tokenAdmin = await login('admin@catmetal.test');
  const crear = async (rol, nombre) => {
    const email = `${rol}.lh.${sufijo}@catmetal.test`;
    const creado = await api('/users', {
      metodo: 'POST',
      token: tokenAdmin,
      cuerpo: { nombre, email, rol, password: CONTRASENA_E2E },
    });
    return { id: creado.id, email, nombre };
  };
  const supervisor = await crear('supervisor', `Supervisor Lighthouse ${sufijo}`);
  const jefe = await crear('jefe', `Jefe Lighthouse ${sufijo}`);
  const admin = await crear('admin', `Admin Lighthouse ${sufijo}`);

  const orden = await api(`/orders/${ORDEN_0587}`, { token: tokenAdmin });
  const ids = new Set(orden.supervisores.map((s) => s.user_id));
  ids.add(supervisor.id);
  await api(`/orders/${ORDEN_0587}/supervisors`, {
    metodo: 'PUT',
    token: tokenAdmin,
    cuerpo: { supervisores: [...ids] },
  });

  // Dos consumos pendientes del supervisor: la cola del jefe se audita con contenido.
  const tokenSupervisor = await login(supervisor.email);
  for (const [lote, cantidad] of [
    [`LH-${sufijo}-A`, 10],
    [`LH-${sufijo}-B`, 25],
  ]) {
    await api('/consumptions', {
      metodo: 'POST',
      token: tokenSupervisor,
      cuerpo: {
        id: uuidV7(),
        order_id: ORDEN_0587,
        material_id: MATERIAL_ARENA,
        cantidad,
        unidad: 'kg',
        lote,
        client_created_at: new Date().toISOString(),
      },
    });
  }
  return { supervisor, jefe, admin };
}

// ---------------------------------------------------------------------------------------------
// Navegador + Lighthouse
// ---------------------------------------------------------------------------------------------
async function abrirNavegador(nombre) {
  const perfil = join(tmpdir(), `catmetal-lh-${nombre}-${randomBytes(4).toString('hex')}`);
  const contexto = await chromium.launchPersistentContext(perfil, {
    headless: true,
    viewport: VIEWPORT,
    hasTouch: true,
    locale: 'es-CO',
    timezoneId: 'America/Bogota',
    args: [`--remote-debugging-port=${PUERTO_DEPURACION}`],
  });
  return {
    contexto,
    async cerrar() {
      await contexto.close();
      rmSync(perfil, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

async function iniciarSesionEnNavegador(contexto, usuario, rutaInicio) {
  const pagina = contexto.pages()[0] ?? (await contexto.newPage());
  await pagina.goto(`${ORIGEN_E2E}/login`);
  await pagina.getByLabel('Correo').fill(usuario.email);
  await pagina.getByLabel('Contraseña').fill(CONTRASENA_E2E);
  await pagina.getByRole('button', { name: 'Iniciar sesión' }).click();
  await pagina.waitForURL(`**${rutaInicio}`);
  // Espera a que la tablet termine la primera sincronización (órdenes y catálogo en Dexie).
  await pagina
    .getByRole('status')
    .filter({ hasText: /En línea.*Todo sincronizado/ })
    .waitFor({ timeout: 60_000 });
  // Lighthouse navega por su cuenta: la pestaña de Playwright queda en blanco.
  await pagina.goto('about:blank');
}

/** Varias corridas; el resultado es la de mediana de Performance (la categoría que más varía). */
async function auditar(etiqueta, ruta, opciones) {
  const corridas = [];
  for (let numero = 1; numero <= CORRIDAS; numero += 1) {
    corridas.push(await auditarUna(etiqueta, ruta, opciones, numero));
  }
  const ordenadas = [...corridas].sort(
    (a, b) => a.puntuaciones.performance - b.puntuaciones.performance,
  );
  const mediana = ordenadas[Math.floor((ordenadas.length - 1) / 2)];
  paso(
    `  → mediana de ${CORRIDAS} corrida(s): Performance ${mediana.puntuaciones.performance} (corridas: ${corridas
      .map((c) => c.puntuaciones.performance)
      .join(', ')})`,
  );
  return {
    ...mediana,
    corridas: corridas.map((c) => ({ puntuaciones: c.puntuaciones, metricas: c.metricas })),
  };
}

async function auditarUna(etiqueta, ruta, { conSesion }, numero) {
  const url = `${ORIGEN_E2E}${ruta}`;
  paso(`Auditando ${etiqueta} (${url})…`);
  const corrida = await lighthouse(
    url,
    {
      port: PUERTO_DEPURACION,
      output: ['json', 'html'],
      logLevel: 'error',
      // Con sesión: no vaciar IndexedDB, cookies ni Service Worker antes de medir.
      disableStorageReset: conSesion,
    },
    { extends: 'lighthouse:default', settings: CONFIG_TABLET },
  );
  if (!corrida?.lhr) {
    throw new Error(`Lighthouse no devolvió resultado para ${url}`);
  }
  const lhr = corrida.lhr;
  const [json, html] = corrida.report;
  const archivo = `${etiqueta.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-corrida${numero}`;
  writeFileSync(join(DIR_RESULTADOS, `${archivo}.json`), json);
  writeFileSync(join(DIR_RESULTADOS, `${archivo}.html`), html);

  const puntuaciones = {};
  const fallidas = [];
  for (const categoria of CATEGORIAS) {
    const datos = lhr.categories[categoria];
    puntuaciones[categoria] = Math.round((datos.score ?? 0) * 100);
    for (const referencia of datos.auditRefs) {
      const auditoria = lhr.audits[referencia.id];
      const aplica =
        auditoria.scoreDisplayMode === 'binary' || auditoria.scoreDisplayMode === 'numeric';
      if (referencia.weight > 0 && aplica && auditoria.score !== null && auditoria.score < 1) {
        fallidas.push({
          categoria,
          id: auditoria.id,
          titulo: auditoria.title,
          puntuacion: auditoria.score,
          peso: referencia.weight,
          valor: auditoria.displayValue ?? null,
          descripcion: auditoria.explanation ?? null,
          elementos: (auditoria.details?.items ?? []).slice(0, 5).map((item) => {
            const nodo = item.node ?? {};
            return nodo.snippet
              ? {
                  selector: nodo.selector ?? null,
                  html: nodo.snippet,
                  motivo: nodo.explanation ?? null,
                }
              : { url: item.url ?? null };
          }),
        });
      }
    }
  }
  paso(
    `  ${etiqueta}: Performance ${puntuaciones.performance} · Accessibility ${puntuaciones.accessibility} · Best Practices ${puntuaciones['best-practices']}`,
  );
  return {
    etiqueta,
    url,
    version_lighthouse: lhr.lighthouseVersion,
    hora: lhr.fetchTime,
    puntuaciones,
    metricas: {
      fcp_ms: Math.round(lhr.audits['first-contentful-paint']?.numericValue ?? 0),
      lcp_ms: Math.round(lhr.audits['largest-contentful-paint']?.numericValue ?? 0),
      tbt_ms: Math.round(lhr.audits['total-blocking-time']?.numericValue ?? 0),
      cls: Number((lhr.audits['cumulative-layout-shift']?.numericValue ?? 0).toFixed(3)),
      speed_index_ms: Math.round(lhr.audits['speed-index']?.numericValue ?? 0),
    },
    auditorias_fallidas: fallidas,
  };
}

// ---------------------------------------------------------------------------------------------
// Principal
// ---------------------------------------------------------------------------------------------
async function main() {
  rmSync(DIR_RESULTADOS, { recursive: true, force: true });
  mkdirSync(DIR_RESULTADOS, { recursive: true });
  mkdirSync(DIR_EVIDENCIA, { recursive: true });

  await levantarServidor();
  const usuarios = await prepararUsuarios();
  const resultados = [];

  const sesiones = [
    {
      rol: 'anonimo',
      usuario: null,
      inicio: null,
      urls: [['Login (sin sesión)', '/login']],
    },
    {
      rol: 'supervisor',
      usuario: usuarios.supervisor,
      inicio: '/supervisor',
      urls: [
        ['Supervisor · Mis órdenes', '/supervisor'],
        ['Supervisor · Registro de consumo', `/supervisor/ordenes/${ORDEN_0587}/registrar`],
        ['Estado de sincronización', '/sincronizacion'],
      ],
    },
    {
      rol: 'jefe',
      usuario: usuarios.jefe,
      inicio: '/jefe',
      urls: [['Jefe · Validación de consumos', '/jefe']],
    },
    {
      rol: 'admin',
      usuario: usuarios.admin,
      inicio: '/admin',
      urls: [['Admin · Usuarios', '/admin']],
    },
  ];

  for (const sesion of sesiones) {
    const navegador = await abrirNavegador(sesion.rol);
    try {
      if (sesion.usuario !== null) {
        await iniciarSesionEnNavegador(navegador.contexto, sesion.usuario, sesion.inicio);
      }
      for (const [etiqueta, ruta] of sesion.urls) {
        resultados.push(await auditar(etiqueta, ruta, { conSesion: sesion.usuario !== null }));
      }
    } finally {
      await navegador.cerrar();
    }
  }

  const reprobadas = [];
  for (const resultado of resultados) {
    for (const categoria of CATEGORIAS) {
      if (resultado.puntuaciones[categoria] < UMBRAL) {
        reprobadas.push(`${resultado.etiqueta}: ${categoria} ${resultado.puntuaciones[categoria]}`);
      }
    }
  }

  const resumen = {
    generado: new Date().toISOString(),
    umbral: UMBRAL,
    perfil: {
      viewport: VIEWPORT,
      formFactor: 'mobile (tablet)',
      userAgent: USER_AGENT_TABLET,
      throttling: CONFIG_TABLET.throttling,
      throttlingMethod: CONFIG_TABLET.throttlingMethod,
      navegador: chromium.executablePath() ? 'Chromium de Playwright' : 'desconocido',
    },
    cumple: reprobadas.length === 0,
    por_debajo_del_umbral: reprobadas,
    resultados,
  };
  writeFileSync(join(DIR_EVIDENCIA, 'resumen.json'), `${JSON.stringify(resumen, null, 2)}\n`);
  paso(
    `Resumen en ${relative(RAIZ, join(DIR_EVIDENCIA, 'resumen.json'))}; informes HTML en ${relative(RAIZ, DIR_RESULTADOS)}.`,
  );

  if (reprobadas.length > 0) {
    console.error(`[lighthouse] Por debajo de ${UMBRAL}:\n  ${reprobadas.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    paso(`Todas las categorías de todas las URLs cumplen el umbral de ${UMBRAL}.`);
  }
}

try {
  await main();
} catch (error) {
  console.error(
    `[lighthouse] ERROR: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  detenerServidor();
}
// Evita que un navegador colgado mantenga vivo el proceso.
setTimeout(() => process.exit(process.exitCode ?? 0), 500);
