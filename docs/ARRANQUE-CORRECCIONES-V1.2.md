# Arranque — sesión de correcciones v1.2

## 0. Preparar (PowerShell, desde `C:\catmetal`)

El repo debe estar en `fix/auditoria-v1`, sin cambios aparte de los archivos nuevos del equipo: este documento, `docs/correcciones-v1.2.md` y el `CLAUDE.md` actualizado.

```powershell
git status --short
Remove-Item .git\auditoria-v11.bundle -ErrorAction SilentlyContinue
```

Cambia el archivo de cierre de la sesión. Claude Code no puede editar `.claude/`, así que este paso lo haces tú:

```powershell
$f = Join-Path (Get-Location) '.claude\sesion.json'
[IO.File]::WriteAllText($f, "{`n  `"sesion`": `"correcciones-v1.2`",`n  `"archivoFinal`": `"docs/INFORME-CORRECCIONES-V1.2.md`"`n}`n")
Get-Content .claude\sesion.json
'{"session_id":"prueba-v12"}' | node .claude\hooks\no-parar.mjs 2>$null; "no-parar exit=$LASTEXITCODE (debe ser 2)"
Remove-Item "$env:TEMP\catmetal-no-parar-prueba-v12.json" -ErrorAction SilentlyContinue
```

## 1. Lanzar

```powershell
claude --permission-mode auto
```

## 2. Prompt (copiar y pegar)

```
Eres el arquitecto de software y orquestador de esta sesión de correcciones v1.2. Lee completos CLAUDE.md y docs/correcciones-v1.2.md. Revisa también docs/INFORME-CORRECCIONES.md y las ADR relacionadas con cada ítem (0018, 0021, 0023, 0024 y 0026). Después:

1. Verifica el estado del repo: rama fix/auditoria-v1, los archivos del equipo sin confirmar y .claude/sesion.json apuntando a docs/INFORME-CORRECCIONES-V1.2.md. Haz el commit C0 solo con los archivos del equipo, como indica CLAUDE.md. Sigue en esta misma rama: no crees otra.
2. Confirma los subagentes del mapeo y registra el mapeo en docs/progreso.md, en la sección de esta sesión.
3. Escribe docs/plan-correcciones-v1.2.md y haz su commit.
4. Corrige en orden A1 → A2 → P2. Por cada ítem: primero una prueba de regresión DETERMINISTA que falle, luego la corrección, gates en verde, commit con "Corrige: <id>" y el estado actualizado en docs/correcciones-v1.2.md. A1 lleva ADR nuevo con segunda opinión de software-architect antes de implementar.
5. Haz las revisiones de esquema y de seguridad que indica CLAUDE.md.
6. Corre los gates finales completos (incluidos e2e y lighthouse), más 20 repeticiones de las pruebas de concurrencia. Cierra todos los procesos en segundo plano, escribe docs/INFORME-CORRECCIONES-V1.2.md, haz el commit final y crea el tag correcciones-v1.2. Nunca hagas push.

Empieza ahora.
```

## 3. Después

- Auditoría del equipo: `git log --oneline correcciones-v1.1..fix/auditoria-v1` y `docs/INFORME-CORRECCIONES-V1.2.md`.
- Push cuando lo aprueben. Actualiza el PR #1 y vuelve a correr su CI:

  ```
  git push origin fix/auditoria-v1 --follow-tags
  ```
