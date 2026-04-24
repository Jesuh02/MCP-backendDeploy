// Adapter compuesto: prueba resolvers en orden hasta que alguno responda.
// OCP: para añadir un nuevo origen (p. ej. CSV, BD de supervisión docente)
// basta con implementar { resolve(q) } y añadirlo a la lista.

export function createAnswerKeyChain(resolvers) {
  return {
    async resolve(q) {
      for (const r of resolvers) {
        const hit = await r.resolve(q)
        if (hit) return hit
      }
      return null
    },
  }
}
