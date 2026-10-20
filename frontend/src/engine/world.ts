import type { Facility, Location, Place, RoadCollection, VegetationInfo, WaterPoint } from '@/api';
import type { Georef } from '@/domain/georef';

import { AssetLayer } from './layers/assetLayer';
import { FireLayer } from './layers/fireLayer';
import { PhotorealLayer, type CitySource } from './layers/photorealLayer';
import { PlanLayer } from './layers/planLayer';
import { UnitLayer } from './layers/unitLayer';
import { RoadLayer } from './layers/roadLayer';
import { WaterLayer } from './layers/waterLayer';
import { WindLayer } from './layers/windLayer';
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

  constructor(
    private readonly engine: SceneEngine,
    readonly input: WorldInput,
  ) {
    const { geo, location, vegetation, roads, facilities, places, waterPoints } = input;
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
    this.city = new PhotorealLayer(geo, location.id as string);
    // while the city draws, the terrain's imagery steps aside and only the fire stays on top of it
    this.city.onVisibleChange = (visible) => this.terrain.setOverlay(visible);

    const scene = engine.scene;
    scene.add(
      this.city.group,
      this.terrain.mesh,
      this.roads.mesh,
      this.assets.group,
      this.water.group,
      this.plan.group,
      this.wind.group,
      this.fire.group,
      this.units.group,
      this.smoke.points,
    );
  }

  get geo(): Georef {
    return this.input.geo;
  }

  /** Objects that react to hover (facilities, places, water points, the plan's actions). */
  get pickables(): Pickable[] {
    return [...this.units.pickables, ...this.assets.pickables, ...this.water.pickables, ...this.plan.pickables];
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
      this.roads.mesh,
      this.assets.group,
      this.water.group,
      this.plan.group,
      this.wind.group,
      this.fire.group,
      this.units.group,
      this.smoke.points,
    );
    this.plan.dispose();
    this.wind.dispose();
    this.units.clear();
    this.city.dispose();
    this.terrain.dispose();
    this.roads.mesh.geometry.dispose();
    this.smoke.points.geometry.dispose();
  }
}
