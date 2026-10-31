// B8 (docs/correcciones-v1.1.md): el despliegue a staging solo corre desde `main`, también dentro
// del workflow. Es una defensa adicional a la política de ramas del environment `staging`.

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

/** Bloque de un job de primer nivel (`jobs.<nombre>`), con indentación de 2 espacios. */
function bloqueDelJob(yaml: string, job: string): string {
  const inicio = yaml.search(new RegExp(String.raw`^  ${job}:\s*$`, 'm'));
  expect(inicio, `job ${job}`).toBeGreaterThanOrEqual(0);
  const resto = yaml.slice(inicio + 1);
  const siguiente = resto.search(/^ {2}[A-Za-z0-9_-]+:\s*$/m);
  return siguiente === -1 ? resto : resto.slice(0, siguiente);
}

describe('B8: deploy-staging solo desde main', () => {
  it('el job que despliega exige github.ref == refs/heads/main', () => {
    const workflow = env.TEST_WORKFLOWS.find((w) => w.ruta.endsWith('deploy-staging.yml'));
    expect(workflow, 'deploy-staging.yml').toBeDefined();
    const desplegar = bloqueDelJob(workflow?.contenido ?? '', 'desplegar');
    expect(desplegar).toMatch(/^ {4}environment: staging\s*$/m);
    expect(desplegar).toMatch(/^ {4}if: github\.ref == 'refs\/heads\/main'\s*$/m);
  });
});
