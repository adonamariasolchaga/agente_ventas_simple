#!/usr/bin/env bash
# Prepara el entorno dentro del contenedor de desarrollo.
# Lo ejecuta VS Code una vez, al crear el contenedor (postCreateCommand).
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Instalando dependencias de Python"
python -m pip install -r requirements.txt

echo "==> Descargando el runtime nativo del SDK de Copilot"
python -m copilot download-runtime \
  || echo "    Aviso: no se pudo predescargar; el SDK lo hará en el primer arranque."

if [ -f .env ]; then
  echo "==> .env ya existe, no se toca"
else
  echo "==> Creando .env a partir de .env.example"
  cp .env.example .env
fi

echo
echo "==> Entorno listo."
echo "    Abre .env y pega tu OPENROUTER_API_KEY (es el único paso manual)."
echo "    Después: python agente_ventas.py"
