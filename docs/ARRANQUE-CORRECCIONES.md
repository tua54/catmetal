# Arranque — sesión de correcciones v1.1

## 0. Preparar (una sola vez, en PowerShell, desde `C:\catmetal`)

Verifica que el repo esté en `build/v1`. Los únicos cambios sin confirmar deben ser los del equipo: `CLAUDE.md`, `docs/spec.md` y `_mover-a-claude/`, más los archivos nuevos `docs/correcciones-v1.1.md` y este documento.

```powershell
git status --short
```

Instala la configuración de Claude Code. Esta vez **es obligatorio**: incluye `sesion.json`, que define el cierre de esta sesión.

```powershell
New-Item -ItemType Directory -Force .claude\hooks | Out-Null
Move-Item _mover-a-claude\settings.json, _mover-a-claude\sesion.json .claude\ -Force
Move-Item _mover-a-claude\hooks\*.mjs .claude\hooks\ -Force
Remove-Item _mover-a-claude -Recurse -Force
Remove-Item .git\auditoria-catmetal.bundle -ErrorAction SilentlyContinue
```

Comprueba que los hooks responden:

```powershell
'{"tool_name":"Bash","tool_input":{"command":"git push"}}' | node .claude\hooks\guardia.mjs; "guardia exit=$LASTEXITCODE (debe ser 2)"
'{"session_id":"prueba"}' | node .claude\hooks\no-parar.mjs; "no-parar exit=$LASTEXITCODE (debe ser 2)"
Remove-Item "$env:TEMP\catmetal-no-parar-prueba.json" -ErrorAction SilentlyContinue
```

## 1. Lanzar

```powershell
cd C:\catmetal
claude --permission-mode auto
```

## 2. Prompt (copiar y pegar)

```
Eres el arquitecto de software y orquestador de esta sesión de correcciones. Lee completos CLAUDE.md y docs/correcciones-v1.1.md, y las secciones §5, §6 y §14 de docs/spec.md. Revisa también docs/INFORME-FINAL.md y las ADR relacionadas con cada ítem. Después:

1. Verifica el estado del repo: rama build/v1, los cambios del equipo sin confirmar, .claude/ instalado y el hook guardia activo. Crea la rama fix/auditoria-v1 y haz el primer commit de la sesión (C1), como indica CLAUDE.md.
2. Confirma los subagentes del mapeo y registra el mapeo en docs/progreso.md, en la sección de esta sesión.
3. Escribe docs/plan-correcciones.md y haz su commit.
4. Corrige los ítems en orden P0 → P1 → P2. Por cada ítem: primero una prueba de regresión que falle, luego la corrección, gates en verde, commit con "Corrige: <id>" y el estado actualizado en docs/correcciones-v1.1.md. Las decisiones de diseño van en ADR nuevas (0018 en adelante).
5. Al terminar P1, haz las revisiones de seguridad y de esquema que indica CLAUDE.md.
6. Corre los gates finales completos (incluidos e2e y lighthouse), escribe docs/INFORME-CORRECCIONES.md, haz el commit final y crea el tag correcciones-v1.1. Nunca hagas push.

Empieza ahora.
```

## 3. Durante y después

- **Pausar**: escribe "pausa". Se crea `docs/PAUSA.md`.
- **Detener ya**: `Esc`.
- **Retomar**: `claude --continue` y escribe "Continúa según docs/progreso.md y CLAUDE.md".
- **Revisión del equipo**: `git log --oneline build/v1..fix/auditoria-v1`, `docs/INFORME-CORRECCIONES.md` y `docs/correcciones-v1.1.md`.
- **Push cuando lo aprueben**:

  ```
  git push -u origin main build/v1 fix/auditoria-v1 --follow-tags
  ```

- **Sesiones futuras**: cambia `archivoFinal` en `.claude/sesion.json` al informe que deba cerrar esa sesión.
