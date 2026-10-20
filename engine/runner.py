#!/usr/bin/env python
"""
Serviço HTTP mínimo à volta do ELMFIRE. A API .NET escreve uma pasta de trabalho em /jobs/<id> e chama POST /run {"job": "<id>"}.

Entrada (em /jobs/<id>):
  meta.json        {"w","h","cell_m","tstop_s","dt_met_s","ign":[ix,iy],"members":["rep","m0",...], opcional "foliar_pct"}
  landscape.i16    8 bandas (dem m, slp °, asp °, fbfm40, cc %, ch 10·m, cbh 10·m, cbd 100·kg/m³), Int16 LE, band-sequential, linha 0 = norte
  adj.f32          fator de ajuste da velocidade de propagação (1 = sem efeito; <1 = descontinuidade, ex.: estradas); adj_<m>.f32 = o de um membro
  wind_<m>.f32     opcional (meta "wind": cols, rows, cell_m): vento por bloco, ws (km/h) e wd (°) [2][intervalo][linha][coluna], em vez do uniforme
  wx_<m>.csv       ws(km/h a 10 m, já com a rajada média),wd(° de onde sopra),m1,m10,m100 (%),lh,lw (%), uma linha por dt_met_s

Saída (em /jobs/<id>/<m>/): toa.i16 (minutos até a ignição, -1 = não ardeu), flin.u16 (kW/m), crown.u8 (0/1/2), log.txt

Desempenho: o transporte de faíscas usa o modelo de acumulação EULERIANO. O modelo LAGRANGIANO do ELMFIRE faz, em cada passo,
uma alocação e cópia integral de `SPOTTING_STATS` — 10 000 000 de elementos — dentro de `CLEAR_USED_EMBER`, o que domina o
tempo de parede (~99.5% num caso de 280×280/3 h, independentemente do número de faíscas). O EULERIANO resolve a mesma física
num campo de fluxo e dá o mesmo mapa de chegada (diferença < 0.1% na área ardida medida).
"""
import glob
import json
import math
import os
import shutil
import subprocess
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import rasterio
from rasterio.transform import from_origin

JOBS = os.environ.get("JOBS_DIR", "/jobs")
CRS = "EPSG:32629"  # georreferência nominal: o ELMFIRE só precisa de metros, a grelha local é cartesiana
WORKERS = int(os.environ.get("WORKERS", os.cpu_count() or 2))
# Tempo: `TARGET_CFL` é o passo de integração do level set (menor = mais passos, mais lento); 0.4 é o valor de referência
# do ELMFIRE para máxima precisão. `SIMULATION_DT` é só o passo inicial (cresce até `SIMULATION_DTMAX`, que fica no valor do
# ELMFIRE, 600 s). Os dois podem ser afinados por ambiente sem mexer no código.
TARGET_CFL = float(os.environ.get("ELMFIRE_TARGET_CFL", "0.4"))
SIMULATION_DT = float(os.environ.get("ELMFIRE_SIMULATION_DT", "1.0"))
FOLIAR_MOISTURE_PCT = float(os.environ.get("ELMFIRE_FOLIAR_MOISTURE_PCT", "90"))
ELMFIRE = os.path.join(os.environ.get("ELMFIRE_INSTALL_DIR", "/elmfire/elmfire/build/linux/bin"), "elmfire")
FUEL_TABLE = os.path.join(os.environ.get("ELMFIRE_BASE_DIR", "/elmfire/elmfire"), "build/source/fuel_models.csv")

NAMELIST = """&INPUTS
FUELS_AND_TOPOGRAPHY_DIRECTORY = './inputs'
LANDSCAPE_FILENAME             = 'landscape'
ADJ_FILENAME                   = 'adj'
PHI_FILENAME                   = 'phi'
DT_METEOROLOGY                 = {dt_met}
WEATHER_DIRECTORY              = './inputs'
WS_FILENAME                    = 'ws'
WD_FILENAME                    = 'wd'
M1_FILENAME                    = 'm1'
M10_FILENAME                   = 'm10'
M100_FILENAME                  = 'm100'
USE_CONSTANT_LH                = .FALSE.
MLH_FILENAME                   = 'lh'
USE_CONSTANT_LW                = .FALSE.
MLW_FILENAME                   = 'lw'
WS_AT_10M                      = .TRUE.
WS_IN_KPH                      = .TRUE.
USE_CONSTANT_FMC               = .TRUE.
FOLIAR_MOISTURE_CONTENT        = {foliar}
/

&OUTPUTS
OUTPUTS_DIRECTORY    = './outputs'
DTDUMP               = {tstop}
DUMP_FLIN            = .TRUE.
DUMP_SPREAD_RATE     = .TRUE.
DUMP_TIME_OF_ARRIVAL = .TRUE.
DUMP_CROWN_FIRE      = .TRUE.
CONVERT_TO_GEOTIFF   = .FALSE.
/

&TIME_CONTROL
SIMULATION_DT    = {dt}
TARGET_CFL       = {cfl}
SIMULATION_TSTOP = {tstop}
/

&MONTE_CARLO
NUM_METEOROLOGY_TIMES = {nbands}
/

&SIMULATOR
NUM_IGNITIONS = {n_ign}
{ignitions}
/

&SPOTTING
CRITICAL_SPOTTING_FIRELINE_INTENSITY(:)   = {sp[critical_intensity_kwm]}
MIN_SPOTTING_DISTANCE                     = {sp[min_spotting_distance_m]}
MAX_SPOTTING_DISTANCE                     = {sp[max_spotting_distance_m]}
EMBER_GR                                  = {sp[ember_gr]}
ENABLE_SPOTTING                           = {spotting}
PIGN                                      = {sp[pign]}
PIGN_MAX                                  = {sp[pign_max]}
PIGN_MIN                                  = {sp[pign_min]}
TAU_EMBERGEN                              = {sp[tau_embergen]}
GENERATION_MODEL                          = 'PER-AREA'
SPOTTING_DISTANCE_MODEL                   = 'EMPIRICAL'
ACCUMULATION_MODEL                        = 'EULERIAN'
IGNITION_MODEL                            = 'SIMPLE'
P_EPS                                     = 0.001
EMBER_SAMPLING_FACTOR                     = {sp[ember_sampling_factor]}
GLOBAL_SURFACE_FIRE_SPOTTING_PERCENT_MAX  = {sp[surface_pct_max]}
GLOBAL_SURFACE_FIRE_SPOTTING_PERCENT_MIN  = {sp[surface_pct_min]}
USE_SUPERSEDED_SPOTTING                   = .FALSE.
STOCHASTIC_SPOTTING                       = .TRUE.
/

&MISCELLANEOUS
PATH_TO_GDAL = 'auto'
SCRATCH      = './scratch'
/
"""


def write_tif(path, arr, transform, dtype, nodata):
    arr = np.asarray(arr, dtype=dtype)
    if arr.ndim == 2:
        arr = arr[None]
    with rasterio.open(path, "w", driver="GTiff", height=arr.shape[1], width=arr.shape[2], count=arr.shape[0], dtype=dtype,
                       crs=CRS, transform=transform, nodata=nodata, compress="deflate") as dst:
        dst.write(arr)


def run_member(job_dir, meta, name):
    t0 = time.time()
    w, h, cell = meta["w"], meta["h"], float(meta["cell_m"])
    mdir = os.path.join(job_dir, name)
    for sub in ("inputs", "outputs", "scratch"):
        os.makedirs(os.path.join(mdir, sub), exist_ok=True)
    inputs = os.path.join(mdir, "inputs")
    # grelha cartesiana centrada em (0, 0), como nos tutoriais do ELMFIRE
    x0, ytop = -w * cell / 2, h * cell / 2
    tr = from_origin(x0, ytop, cell, cell)

    land = np.fromfile(os.path.join(job_dir, "landscape.i16"), dtype="<i2").reshape(8, h, w)
    write_tif(os.path.join(inputs, "landscape.tif"), land, tr, "int16", -9999)
    adj_path = os.path.join(job_dir, f"adj_{name}.f32")  # propagação própria do membro (barreiras galgadas); senão a comum
    write_tif(os.path.join(inputs, "adj.tif"), np.fromfile(adj_path if os.path.exists(adj_path) else os.path.join(job_dir, "adj.f32"), dtype="<f4").reshape(h, w), tr, "float32", -9999)
    # nível inicial (phi): 1 = por arder; -1 = já ardido (perímetro inicial opcional, `phi0.u8`: 1 = ardido)
    phi = np.ones((h, w), dtype="float32")
    burned0 = None
    phi0_path = os.path.join(job_dir, "phi0.u8")
    if os.path.exists(phi0_path):
        burned0 = np.fromfile(phi0_path, dtype="u1").reshape(h, w) > 0
        phi[burned0] = -1.0
    write_tif(os.path.join(inputs, "phi.tif"), phi, tr, "float32", -9999)
    shutil.copy(FUEL_TABLE, os.path.join(inputs, "fuel_models.csv"))

    # tempo variável, espacialmente uniforme: um raster grosseiro (300 m) por variável, uma banda por intervalo meteorológico
    rows = np.loadtxt(os.path.join(job_dir, f"wx_{name}.csv"), delimiter=",", skiprows=1, ndmin=2)
    wc, wr = max(2, math.ceil(w * cell / 300)), max(2, math.ceil(h * cell / 300))
    wtr = from_origin(x0, ytop, 300.0, 300.0)
    for col, key in enumerate(("ws", "wd", "m1", "m10", "m100", "lh", "lw")):
        write_tif(os.path.join(inputs, f"{key}.tif"), np.broadcast_to(rows[:, col][:, None, None], (rows.shape[0], wr, wc)), wtr, "float32", -9999)
    # vento já alterado pelo fogo (convecção): um valor por bloco e por intervalo, em vez de um só para o local
    wind_path, wind = os.path.join(job_dir, f"wind_{name}.f32"), meta.get("wind")
    if wind and os.path.exists(wind_path):
        field = np.fromfile(wind_path, dtype="<f4").reshape(2, rows.shape[0], wind["rows"], wind["cols"])
        ftr = from_origin(x0, ytop, float(wind["cell_m"]), float(wind["cell_m"]))
        for key, band in (("ws", field[0]), ("wd", field[1])):
            write_tif(os.path.join(inputs, f"{key}.tif"), band, ftr, "float32", -9999)

    ignitions = meta.get("ignitions") or [[meta["ign"][0], meta["ign"][1], 0]]  # [coluna, linha, segundos desde o início]
    ign_lines = "\n".join(
        f"X_IGN({k + 1}) = {x0 + (ix + 0.5) * cell}\nY_IGN({k + 1}) = {ytop - (iy + 0.5) * cell}\nT_IGN({k + 1}) = {float(t0)}"
        for k, (ix, iy, t0) in enumerate(ignitions))
    # parâmetros das faíscas (meta "spotting_params", escritos pela API a partir de FireTrace:Engine:Spotting); os valores antigos servem para trabalhos sem eles
    sp = {"critical_intensity_kwm": 0.0, "pign": 20.0, "pign_min": 10.0, "pign_max": 30.0, "ember_gr": 1.0, "tau_embergen": 10.0, "ember_sampling_factor": 50.0, "surface_pct_min": 0.0, "surface_pct_max": 0.0,
          "min_spotting_distance_m": 0.0, "max_spotting_distance_m": 0.0}  # 0 = sem tecto no ELMFIRE: valores antigos (sem isto no meta.json) continuam sem limite
    sp.update({k: float(v) for k, v in (meta.get("spotting_params") or {}).items()})
    nl = NAMELIST.format(dt_met=meta["dt_met_s"], tstop=float(meta["tstop_s"]), nbands=rows.shape[0], n_ign=len(ignitions), ignitions=ign_lines, sp=sp,
                         dt=SIMULATION_DT, cfl=TARGET_CFL, foliar=float(meta.get("foliar_pct", FOLIAR_MOISTURE_PCT)),
                         spotting=".TRUE." if meta.get("spotting", os.environ.get("SPOTTING", "1") == "1") else ".FALSE.")
    with open(os.path.join(inputs, "elmfire.data"), "w") as f:
        f.write(nl)

    log = open(os.path.join(mdir, "log.txt"), "w")
    p = subprocess.run([ELMFIRE, "./inputs/elmfire.data"], cwd=mdir, stdout=log, stderr=subprocess.STDOUT)
    log.close()
    toa_files = sorted(glob.glob(os.path.join(mdir, "outputs", "time_of_arrival_*.bil")))
    if p.returncode != 0 or not toa_files:
        tail = open(os.path.join(mdir, "log.txt"), errors="ignore").read()[-1500:]
        return {"error": f"ELMFIRE falhou (código {p.returncode}): {tail}"}

    def read(prefix):
        fs = sorted(glob.glob(os.path.join(mdir, "outputs", f"{prefix}_*.bil")))
        if not fs:
            return None
        with rasterio.open(fs[-1]) as src:
            return src.read(1).astype("float64"), src.nodata

    toa, nd = read("time_of_arrival")
    burned = (toa >= 0) & (toa != (nd if nd is not None else -9999))
    if burned0 is not None:
        burned = burned | burned0
        toa = np.where(burned0, 0.0, toa)
    toa_min = np.where(burned, np.minimum(np.rint(toa / 60.0), 32000), -1).astype("<i2")
    toa_min.tofile(os.path.join(mdir, "toa.i16"))
    fl = read("flin")
    flin = np.zeros((h, w), dtype="<u2")
    if fl is not None:
        flin = np.where(burned & (fl[0] > 0), np.clip(fl[0], 0, 65535), 0).astype("<u2")
    flin.tofile(os.path.join(mdir, "flin.u16"))
    cf = read("crown_fire")
    crown = np.zeros((h, w), dtype="u1")
    if cf is not None:
        crown = np.where(burned & (cf[0] > 0), np.clip(cf[0], 0, 255), 0).astype("u1")
    crown.tofile(os.path.join(mdir, "crown.u8"))
    shutil.rmtree(os.path.join(mdir, "inputs"), ignore_errors=True)  # só os resultados ficam em disco
    secs = round(time.time() - t0, 1)
    print(f"[engine] membro {name}: {secs} s, {int(burned.sum())} células", flush=True)
    return {"error": None, "seconds": secs, "burned_cells": int(burned.sum())}


def run_job(job_id):
    job_dir = os.path.join(JOBS, job_id)
    with open(os.path.join(job_dir, "meta.json")) as f:
        meta = json.load(f)
    results = {}
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {m: ex.submit(run_member, job_dir, meta, m) for m in meta["members"]}
        for m, fut in futs.items():
            try:
                results[m] = fut.result()
            except Exception as e:  # noqa: BLE001
                results[m] = {"error": f"{e}\n{traceback.format_exc()[-800:]}"}
    return results


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/progress/"):  # quantos membros do trabalho já têm resultado
            job = self.path.split("/")[2]
            if not job.replace("-", "").isalnum():
                return self._send(400, {"error": "id inválido"})
            try:
                with open(os.path.join(JOBS, job, "meta.json")) as f:
                    members = json.load(f)["members"]
                return self._send(200, {"done": sum(os.path.exists(os.path.join(JOBS, job, m, "toa.i16")) for m in members), "total": len(members)})
            except OSError:
                return self._send(404, {"error": "trabalho desconhecido"})
        if self.path == "/health":
            self._send(200, {"status": "ok", "elmfire": os.path.exists(ELMFIRE), "workers": WORKERS})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/run":
            return self._send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            job = json.loads(self.rfile.read(n))["job"]
            if not job.replace("-", "").isalnum():
                return self._send(400, {"error": "id inválido"})
            self._send(200, {"members": run_job(job)})
        except Exception as e:  # noqa: BLE001
            self._send(500, {"error": str(e), "trace": traceback.format_exc()[-1200:]})

    def log_message(self, fmt, *args):
        sys.stderr.write("[engine] " + fmt % args + "\n")


if __name__ == "__main__":
    os.makedirs(JOBS, exist_ok=True)
    print(f"ELMFIRE runner em :9000 (binário {ELMFIRE}, {WORKERS} trabalhadores)", flush=True)
    ThreadingHTTPServer(("0.0.0.0", 9000), Handler).serve_forever()
