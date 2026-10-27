# CAD Studio — starter

Base inicial de una aplicación CAD web modular. Esta versión es un **prototipo de interfaz y visualización**, no un motor CAD de precisión terminado.

## Requisitos

- Node.js 20.19+ o 22.12+
- npm

## Ejecutar

```bash
npm install
npm run dev
```

Abrí la URL local que indique Vite (normalmente `http://localhost:5173`).

## Scripts

```bash
npm run typecheck
npm run build
npm run preview
```

## Qué incluye esta primera base

- Interfaz de escritorio con panel de herramientas, escena 3D y propiedades.
- Escena Three.js con cuadrícula, cámara, luces y un cubo inicial.
- Estado del editor centralizado con Zustand.
- Modelo de datos inicial validado con Zod.
- Persistencia local preparada mediante IndexedDB (`idb`).
- Adaptadores separados para motor CAD y almacenamiento en la nube, todavía pendientes de implementación.

## Arquitectura

- `src/app`: composición de la aplicación.
- `src/features/editor`: estado y controles del editor.
- `src/features/viewport`: escena Three.js.
- `src/domain`: tipos y esquema del proyecto.
- `src/engines/cad`: frontera del motor geométrico; OpenCascade.js se integra en una fase posterior.
- `src/services/storage`: persistencia local.
- `src/services/sync`: futura sincronización Supabase.
- `src/styles`: estilos globales.

## Próximas tareas técnicas

1. Selección de objetos y transformaciones con gizmos.
2. Crear cubo, cilindro y esfera desde la barra lateral.
3. Unidades en milímetros y propiedades editables.
4. Guardado y apertura de documentos `.cadstudio.json`.
5. Historial de deshacer/rehacer.
6. Integrar y validar OpenCascade.js para operaciones booleanas reales.
7. Exportar STL/OBJ y después evaluar 3MF.
8. Añadir autenticación y sincronización con Supabase con control de conflictos.

## Decisiones importantes

- Three.js solo representa la escena; no sustituye a un kernel CAD.
- Los booleanos, roscas y sólidos precisos deben ejecutarse mediante un motor geométrico apropiado.
- La nube no se activa hasta configurar credenciales y definir reglas de seguridad. Nunca incluir claves secretas de servidor en el frontend.
- La exportación de un objeto visible no garantiza que sea una malla válida para impresión.
