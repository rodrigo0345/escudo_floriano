import type * as THREE from 'three';
import type { Facility, Location, Place, RoadCollection, VegetationInfo, WaterPoint } from '@/api';
import type { Georef } from '@/domain/georef';

import { AftermathLayer } from './layers/aftermathLayer';
import { AssetLayer } from './layers/assetLayer';
import { FireLayer } from './layers/fireLayer';
import { burnStyles, burnStyleTexture } from './burnShader';
import { FlameLayer } from './layers/flameLayer';
import { FleetLayer } from './layers/fleetLayer';
import { PhotorealLayer, type CitySource } from './layers/photorealLayer';
import { PlanLayer } from './layers/planLayer';
import { UnitLayer } from './layers/unitLayer';
import { RoadLayer } from './layers/roadLayer';
import { WaterLayer } from './layers/waterLayer';
import { WindLayer } from './layers/windLayer';
import { RainLayer } from './layers/rainLayer';
import { CloudLayer } from './layers/cloudLayer';
import type { Pickable } from './picking';
import type { SceneEngine } from './sceneEngine';
import { SmokeSystem } from './smokeSystem';
import { TerrainMesh } from './terrainMesh';

export interface WorldInput {
  location: Location;
  geo: Georef;
  vegetation: VegetationInfo;
  roads: RoadCollection;
  facilities: Facility[];
  places: Place[];
  waterPoints: WaterPoint[];
  /** Land-cover class per grid cell: how each place chars once burned. */
  landcover: Uint8Array;
}

/**
 * Everything drawn for one loaded location: terrain, roads, assets, water, fire overlays,
 * agents' plan, wind field and smoke, all added to the engine's scene. Dependency direction is one-way —
 * `World` knows about `SceneEngine`, never the reverse — and React code only ever calls `World`'s methods,
 * never pokes at individual three.js objects.
 */
export class World {
  readonly terrain: TerrainMesh;
  readonly roads: RoadLayer;
  readonly assets: AssetLayer;
  readonly water: WaterLayer;
  /** The agents' plan drawn on the terrain (empty until a plan is shown). */
  readonly plan: PlanLayer;
  readonly wind: WindLayer;
  readonly fire: FireLayer;
  readonly units: UnitLayer;
  readonly smoke: SmokeSystem;
  /** The photoreal 3D city from local tiles (off by default; see `PhotorealLayer`). */
  readonly city: PhotorealLayer;
  /** The flames, in 3D, where the fire is burning at the minute shown. */
  readonly flames: FlameLayer;
  /** After the flames: smoke wisps, embers, ash or smoke columns by what burned, fading over the following hour or so. */
  readonly aftermath: AftermathLayer;
  /** Every registered vehicle not in a replayed operation: parked at its station, or where the API says it is. */
  readonly fleet: FleetLayer;
  readonly rain: RainLayer;
  readonly clouds: CloudLayer;

  constructor(
    private readonly engine: SceneEngine,
    readonly input: WorldInput,
  ) {
    const { geo, location, vegetation, roads, facilities, places, waterPoints, landcover } = input;
    this.terrain = new TerrainMesh(geo, location.layers ?? [], vegetation.classes);
    this.roads = new RoadLayer(geo, roads);
    this.assets = new AssetLayer(geo);
    this.assets.setFacilities(facilities);
    this.assets.setPlaces(places);
    this.water = new WaterLayer(geo, waterPoints);
    this.plan = new PlanLayer(geo);
    this.wind = new WindLayer(geo);
    this.fire = new FireLayer(geo);
    this.units = new UnitLayer(geo);
    this.smoke = new SmokeSystem(geo);
    const styles = burnStyles(landcover, vegetation.classes);
    this.terrain.setBurnStyle(burnStyleTexture(styles, geo.gridWidth, geo.gridHeight));
    this.city = new PhotorealLayer(geo, location.id as string, this.terrain.burn);
    this.flames = new FlameLayer(geo);
    this.fleet = new FleetLayer(geo);
    this.flames.setStyles(styles);
    this.aftermath = new AftermathLayer(geo);
    this.aftermath.setStyles(styles);
    // while the city draws, the terrain sinks just under it (it fills any gap) and the overlays get their own pass, so buildings and trees never hide them
    this.city.onVisibleChange = (visible) => {
      this.terrain.setCityMode(visible);
      this.engine.setOverlayPass(visible ? { overlays: this.overlays, depthProxy: this.terrain.depthProxy } : null);
    };
    this.rain = new RainLayer();
    this.clouds = new CloudLayer();

    const scene = engine.scene;
    scene.add(
      this.city.group,
      this.terrain.mesh,
      this.terrain.depthProxy,
      this.flames.mesh,
      this.aftermath.points,
      this.fleet.group,
      this.roads.mesh,
      this.assets.group,
      this.water.group,
      this.plan.group,
      this.wind.group,
      this.fire.group,
      this.units.group,
      this.smoke.points,
      this.rain.group,
      this.clouds.group,
    );
  }

  get geo(): Georef {
    return this.input.geo;
  }

  /** What the operator reads the map with: drawn over the 3D city in their own pass (hidden by hills, never by buildings or trees). */
  private get overlays(): THREE.Object3D[] {
    // the flames too: they are the burning trees, so the photographed canopy must not swallow them
    return [this.roads.mesh, this.assets.group, this.water.group, this.plan.group, this.fire.group, this.units.group, this.fleet.group, this.flames.mesh];
  }

  /** Objects that react to hover (facilities, places, water points, the plan's actions). */
  get pickables(): Pickable[] {
    return [...this.units.pickables, ...this.fleet.pickables, ...this.assets.pickables, ...this.water.pickables, ...this.plan.pickables];
  }

  /** Shows or hides the 3D city. Close-up navigation (a nearer camera plane and zoom limit) comes with it. */
  setCity(on: boolean, source: CitySource = 'local', apiKey = ''): boolean {
    const started = this.city.setEnabled(on, this.engine.camera, this.engine.renderer, source, apiKey);
    this.engine.setCloseUp(on && started);
    return started;
  }

  /** Per frame, before drawing. */
  updateCity(): void {
    this.city.update(this.engine.camera, this.engine.renderer, this.engine.controls.target);
  }

  focusOnLatLon(lat: number, lon: number): void {
    const [x, y, z] = this.geo.world(lat, lon, 0);
    this.engine.focusOn(x, y, z);
  }

  dispose(): void {
    const scene = this.engine.scene;
    scene.remove(
      this.city.group,
      this.terrain.mesh,
      this.terrain.depthProxy,
      this.flames.mesh,
      this.aftermath.points,
      this.fleet.group,
      this.roads.mesh,
      this.assets.group,
      this.water.group,
      this.plan.group,
      this.wind.group,
      this.fire.group,
      this.units.group,
      this.smoke.points,
      this.rain.group,
      this.clouds.group,
    );
    this.plan.dispose();
    this.wind.dispose();
    this.clouds.dispose();
    this.units.clear();
    this.engine.setOverlayPass(null);
    this.city.dispose();
    this.flames.dispose();
    this.aftermath.dispose();
    this.fleet.clear();
    this.terrain.dispose();
    this.roads.mesh.geometry.dispose();
    this.smoke.points.geometry.dispose();
  }
}
