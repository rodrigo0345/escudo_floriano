# Motor de propagação ELMFIRE (Eulerian Level set Model of FIRE spread, Lautenberger et al.): Rothermel + Van Wagner + level set + projeção de faíscas.
# Código-fonte: https://github.com/lautenberger/elmfire (licença Commons Clause: uso livre, proibida a venda do software).
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -y && apt-get install --no-install-recommends -y \
      build-essential gfortran libopenmpi-dev openmpi-bin ca-certificates git wget bzip2 bc csvkit jq pigz locales \
    && rm -rf /var/lib/apt/lists/*

# GDAL clássico (<3.11, o Fortran chama gdal_translate/gdalinfo por nome), rasterio e numpy numa só distribuição conda-forge
ENV MAMBA_ROOT_PREFIX=/opt/conda
COPY environment.yml /tmp/environment.yml
RUN wget -qO- https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xvj -C /usr/local/bin --strip-components=1 bin/micromamba \
 && micromamba create -y -n elmfire -f /tmp/environment.yml && micromamba clean --all --yes
ENV PATH=/opt/conda/envs/elmfire/bin:$PATH PROJ_DATA=/opt/conda/envs/elmfire/share/proj GDAL_DATA=/opt/conda/envs/elmfire/share/gdal

# versão fixada por commit (as etiquetas de 2025 ainda não têm LANDSCAPE_FILENAME nem os modelos de projeção de faíscas usados aqui)
ARG ELMFIRE_REF=5ea7460d514b24bf9a1cdda571c16f4f03de603f
RUN mkdir -p /elmfire/elmfire /scratch/elmfire && cd /elmfire/elmfire && git init -q && git remote add origin https://github.com/lautenberger/elmfire \
 && git fetch --depth 1 origin ${ELMFIRE_REF} && git checkout -q FETCH_HEAD

WORKDIR /elmfire/elmfire/build/linux
RUN ./make_gnu.sh

ENV ELMFIRE_BASE_DIR=/elmfire/elmfire ELMFIRE_SCRATCH_BASE=/scratch/elmfire ELMFIRE_INSTALL_DIR=/elmfire/elmfire/build/linux/bin
ENV PATH=$PATH:/elmfire/elmfire/build/linux/bin

COPY runner.py /app/runner.py
WORKDIR /app
EXPOSE 9000
CMD ["python", "/app/runner.py"]
