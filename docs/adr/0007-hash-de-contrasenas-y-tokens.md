# ADR 0007 — Hash de contraseñas (PBKDF2 100.000) y de refresh tokens (HMAC-SHA256)

- Estado: aceptado
- Fecha: 2026-10-29
- Fase: 1

## Contexto

- El runtime de Workers rechaza PBKDF2 con más de 100.000 iteraciones (`DEFAULT_MAX_PBKDF2_ITERATIONS` en workerd; `DOMNotSupportedError`). La spec fija exactamente 100.000 (§2).
- No hay bcrypt/argon2 nativos en Workers; una implementación en JS consumiría demasiada CPU por invocación.
- Los refresh tokens se guardan solo como hash (§4, §5). La spec define dos secretos: `JWT_SECRET` y `REFRESH_SECRET`.

## Opciones consideradas

Contraseñas: (a) PBKDF2-SHA256 100.000 con WebCrypto; (b) argon2/bcrypt en WASM. Refresh tokens: (a) SHA-256 simple del token; (b) HMAC-SHA256 con `REFRESH_SECRET`.

## Decisión

- **Contraseñas**: PBKDF2-SHA256, 100.000 iteraciones, sal aleatoria de 16 bytes por usuario, 32 bytes de salida. Formato autodescriptivo `pbkdf2-sha256$100000$<sal_b64>$<hash_b64>`, que permite migrar el algoritmo leyendo el prefijo. La comparación es de tiempo constante. Si el correo no existe, se ejecuta igual una derivación con una sal ficticia para que el tiempo de respuesta no revele qué correos existen. Una prueba verifica que `PBKDF2_ITERACIONES_SERVIDOR ≤ 100_000`.
- **Refresh tokens**: 32 bytes aleatorios (base64url). En D1 se guarda `token_hash = HMAC-SHA256(REFRESH_SECRET, token)` en hex. Es una función SHA-256 con clave: una fuga de la base no permite verificar tokens sin el secreto. Se indexa por `token_hash`.

## Consecuencias

- 100.000 iteraciones está por debajo de la recomendación actual de OWASP para PBKDF2-SHA256; lo compensan el bloqueo por cuenta (5 intentos / 15 min), el rate limiting y contraseñas de al menos 10 caracteres. Cuando Workers permita más, se sube y se rehace el hash en el siguiente login correcto (el formato lo permite).
- Rotar `REFRESH_SECRET` invalida todas las sesiones (todos deben volver a iniciar sesión).

## Cómo revertir

Cambiar el prefijo del formato y la función de verificación; los hashes antiguos se siguen verificando por su prefijo y se reemplazan en el siguiente login.
