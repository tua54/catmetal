/**
 * Lee un Blob como ArrayBuffer.
 *
 * Usa `blob.arrayBuffer()` cuando existe (todos los navegadores soportados) y, si no, `FileReader`.
 * No usa `new Response(blob)`: con un Blob que no es el nativo del entorno (jsdom), `Response` lo
 * convierte en el texto "[object Blob]" en vez de leer sus bytes.
 */
export async function leerBlob(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise<ArrayBuffer>((resolver, rechazar) => {
    const lector = new FileReader();
    lector.onload = () => resolver(lector.result as ArrayBuffer);
    lector.onerror = () => rechazar(lector.error ?? new Error('No se pudo leer el archivo.'));
    lector.readAsArrayBuffer(blob);
  });
}
