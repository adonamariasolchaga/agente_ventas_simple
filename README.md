# Agente simple de ventas

Extraído de la sección **Agente simple de ventas** de `original.ipynb`.
Incluye `sales_data.db`, descargada desde el enlace del notebook.

Basado en <https://github.com/juananpe/agente-ventas>, con una interfaz web
añadida (ver [Versión web](#versión-web)).

## Puesta en marcha con el contenedor (recomendada)

Solo necesitas [Docker](https://www.docker.com/products/docker-desktop/) y
[Visual Studio Code](https://code.visualstudio.com/) con la extensión
**Dev Containers**. Da igual si usas Windows, macOS o Linux.

1. Clona o copia este repositorio.

2. Abre esa carpeta en VS Code y elige **Reopen in Container**
   (`F1` → `Dev Containers: Reopen in Container`).

VS Code construye el contenedor y deja el entorno listo: Python 3.13, las
dependencias y el runtime del SDK. La primera vez tarda un par de minutos; las
siguientes son instantáneas.

3. Abre `.env` y pega tu clave de OpenRouter. Es el único paso manual:

```
OPENROUTER_API_KEY=tu_clave
```

Puedes crear una clave en <https://openrouter.ai/keys>. El `.env` ya existe (el
contenedor lo crea a partir de `.env.example`) y está excluido de Git, así que
tu clave no se sube al repositorio.

4. Ejecuta el agente en la terminal de VS Code:

```sh
python agente_ventas.py
```

También admite una pregunta única:

```sh
python agente_ventas.py --pregunta "¿Cuál es el top 5 de tiendas por ventas totales?"
```

Dentro del contenedor `python` ya apunta al entorno correcto: no hay que activar
nada ni usar rutas con `.venv`.

## Puesta en marcha sin Docker

Si prefieres ejecutarlo directamente en tu equipo necesitas Python 3.11 o
posterior. Crea el entorno virtual:

```sh
python3 -m venv .venv
```

macOS y Linux:

```sh
./.venv/bin/python -m pip install -r requirements.txt
cp .env.example .env        # y pega tu clave en .env
./.venv/bin/python agente_ventas.py
```

Windows (PowerShell):

```powershell
.venv\Scripts\python -m pip install -r requirements.txt
copy .env.example .env
.venv\Scripts\python agente_ventas.py
```

## Versión web

Hay también una interfaz web: backend en Python (FastAPI, `servidor_web.py`) y
frontend en HTML + JavaScript sin dependencias (`static/`). Arráncala con:

```sh
python servidor_web.py
```

y abre <http://127.0.0.1:8000>. Admite `--puerto`, `--host` y `--modelo`.
Las respuestas llegan en streaming y cada mensaje muestra, plegadas, las
consultas SQL que ha ejecutado el agente. **Nueva conversación** empieza una
sesión limpia.

API:

- `GET /api/estado`: modelo configurado y si hay clave y base de datos.
- `POST /api/chat` con `{"message": "...", "session_id": "..."}`: devuelve un
  flujo SSE con los eventos `session`, `tool` (SQL ejecutada), `delta` (texto),
  `error` y `done`. Omite `session_id` en el primer mensaje.
- `DELETE /api/sesiones/{id}`: cierra una sesión.

## Detalles

Usa OpenRouter con el modelo `deepseek/deepseek-v4.1-flash`; puedes elegir otro
con `--modelo ID_DEL_MODELO`. En el modo interactivo, escribe `salir` para
terminar.

La clave se lee de `.env` al arrancar. Si `OPENROUTER_API_KEY` ya está definida
en el entorno, también la usa.

El SDK descarga su runtime nativo en el primer arranque (el contenedor de
desarrollo ya lo trae predescargado).

La base SQLite se abre en modo de solo lectura y se devuelven como máximo 100
filas por consulta.
