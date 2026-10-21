import React from 'react';

import type { VehicleType } from '@/api';

export type VehicleCategory =
  | 'truck'
  | 'tanker'
  | 'pickup'
  | 'ambulance'
  | 'suv'
  | 'car'
  | 'van'
  | 'bus'
  | 'heli'
  | 'plane'
  | 'drone'
  | 'dozer'
  | 'moto';

/**
 * Maps each API VehicleType to an icon category.
 */
export function categoryOfVehicle(type: string | undefined): VehicleCategory {
  switch (type) {
    case 'tanker_forest':
    case 'tanker_urban':
    case 'tanker_large':
      return 'tanker';

    case 'light_firefighting_vehicle':
    case 'all_terrain_patrol':
    case 'operations_vehicle':
      return 'pickup';

    case 'ambulance':
    case 'advanced_medical_vehicle':
      return 'ambulance';

    case 'immediate_life_support_vehicle':
    case 'command_vehicle':
      return 'suv';

    case 'patrol_car':
    case 'traffic_unit':
      return 'car';

    case 'motorcycle':
      return 'moto';

    case 'command_comms_vehicle':
    case 'personnel_transport':
      return 'van';

    case 'bus':
      return 'bus';

    case 'helicopter':
      return 'heli';

    case 'airtanker':
      return 'plane';

    case 'drone':
      return 'drone';

    case 'bulldozer':
    case 'heavy_machinery':
    case 'tractor_plow':
      return 'dozer';

    case 'forest_firefighting_vehicle':
    case 'urban_firefighting_vehicle':
    case 'rescue_vehicle':
    default:
      return 'truck';
  }
}

/**
 * Pure SVG path definitions on a 24x24 viewBox.
 * Professional vector emergency vehicle icons (NO emojis).
 */
export const VEHICLE_SVG_PATHS: Record<VehicleCategory, string> = {
  // Fire Truck: Cab, crew box, emergency light, wheel wells
  truck:
    'M2 17h2.1a2.9 2.9 0 0 0 5.8 0H14a2.9 2.9 0 0 0 5.8 0H22v-6l-3-4h-5V5h-2v2H2v10zm3-8h7v4H5V9zm9 0h3.5l2 2.7V13H14V9zM7 17a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm10 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z',

  // Water Tanker: Cab + large water cistern tank with nozzle
  tanker:
    'M2 17h2.1a2.9 2.9 0 0 0 5.8 0H14a2.9 2.9 0 0 0 5.8 0H22v-5l-2.5-3.5H15V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11zm15-6.5l1.8 2.5H15v-2.5zm-5-4.5v7H4V6h8zm-5 14a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm10 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z',

  // 4x4 Pickup / Light Attack Vehicle
  pickup:
    'M2 16h2.1a2.9 2.9 0 0 0 5.8 0H14a2.9 2.9 0 0 0 5.8 0H22v-4l-3-4h-6l-1.5 2H2v6zm9-6h3.5l1.8 2.5H11V10zM7 16a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm10 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z',

  // Ambulance: Van shape with emergency cross
  ambulance:
    'M2 17h2.1a2.9 2.9 0 0 0 5.8 0H14a2.9 2.9 0 0 0 5.8 0H22v-6l-2.5-3.5H14V6H2v11zm13-7h3.2l1.4 2H15v-2zm-8-2h2v1.5H10.5V11H9V9.5H7.5V8zm-0.5 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm10 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z',

  // Command SUV / VMER: 4x4 SUV profile with emergency lightbar
  suv:
    'M2 16h2.1a2.9 2.9 0 0 0 5.8 0H14a2.9 2.9 0 0 0 5.8 0H22v-3.5L18.5 8H13V6h-2v2H5.5L2 12.5V16zm4.5-6h4.5v2.5H6.5V10zm6.5 0h4.5l1.8 2.5H13V10zM7 16a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm10 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z',

  // Patrol Car / Police / GNR Cruiser
  car:
    'M3 16h2.1a2.9 2.9 0 0 0 5.8 0H13a2.9 2.9 0 0 0 5.8 0H21v-3l-2.5-3.5h-4.5V8h-2v1.5H8L4.5 13H3v3zm4.5-5h3v2H7.5V11zm5 0h3.5l1.4 2H12.5V11zM8 16a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm8 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z',

  // Van / Logistics / Command Van
  van:
    'M2 17h2.1a2.9 2.9 0 0 0 5.8 0H14a2.9 2.9 0 0 0 5.8 0H22v-6.5l-2.5-3.5H14V6H2v11zm13-7.5h3.2l1.4 2.2H15V9.5zM7 17a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm10 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z',

  // Personnel Bus
  bus:
    'M3 18h2.1a2.9 2.9 0 0 0 5.8 0H13a2.9 2.9 0 0 0 5.8 0H21v-12a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12zm2-11h3v4H5V7zm5 0h4v4h-4V7zm6 0h3v4h-3V7zm-10 11a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm8 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z',

  // Helicopter: Rotor blades, cockpit, skids, tail rotor
  heli:
    'M3 5h18v2H14v2h2a5 5 0 0 1 5 5v1h-3.1a3 3 0 0 1-5.8 0H8.5l-5 1.5V13l4.5-1.5V9H10V7H3V5zm5 9a1.5 1.5 0 0 0 3 0H8zm-3 5h14v1.5H5V19z',

  // Airtanker / Firefighting Plane
  plane:
    'M12 2l2 8h7l-3 3 5 3-1 2-7-2-2 4 2 2v1l-3-1-3 1v-1l2-2-2-4-7 2-1-2 5-3-3-3h7l2-8z',

  // Drone / Quadcopter
  drone:
    'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm-7-5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm14 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM5 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm14 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM6.5 7.5l3.8 3M17.5 7.5l-3.8 3M6.5 16.5l3.8-3M17.5 16.5l-3.8-3',

  // Bulldozer / Heavy Earthmoving
  dozer:
    'M2 17a3 3 0 0 0 6 0h5a3 3 0 0 0 6 0h3v-6h-3V7h-7v4H4v6H2zm8-8h4v2h-4V9zm-5 8a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm11 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z',

  // Motorcycle
  moto:
    'M4 17a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm16 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-8.5-5l1.5-4h3l1 2h2v-1.5h-1.3l-1-2H12l-2 5H7.2a4.9 4.9 0 0 0-3.2-1.2v2a3 3 0 0 1 2 .8l3.5 3.4h4l1.5-3h-3.7z',
};

export interface VehicleIconProps {
  type?: VehicleType | string;
  size?: number;
  color?: string;
  style?: React.CSSProperties;
  className?: string;
  title?: string;
}

/**
 * Reusable clean SVG vector icon for any vehicle type.
 */
export function VehicleIcon({
  type,
  size = 20,
  color = 'currentColor',
  style,
  className,
  title,
}: VehicleIconProps) {
  const cat = categoryOfVehicle(type);
  const path = VEHICLE_SVG_PATHS[cat] ?? VEHICLE_SVG_PATHS.truck;

  return React.createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: color,
      className,
      style: {
        display: 'inline-block',
        verticalAlign: 'middle',
        flexShrink: 0,
        ...style,
      },
      'aria-label': title ?? type,
      role: 'img',
    },
    title ? React.createElement('title', null, title) : null,
    React.createElement('path', { d: path }),
  );
}

/**
 * Draws the vector vehicle icon directly onto an HTML Canvas 2D context
 * using native Path2D for crisp 3D map sprite textures.
 */
export function drawVehicleIconOnCanvas(
  ctx: CanvasRenderingContext2D,
  type: string | undefined,
  x: number,
  y: number,
  size: number,
  color = '#ffffff',
): void {
  const cat = categoryOfVehicle(type);
  const pathStr = VEHICLE_SVG_PATHS[cat] ?? VEHICLE_SVG_PATHS.truck;
  const path2d = new Path2D(pathStr);

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.fillStyle = color;
  ctx.fill(path2d);
  ctx.restore();
}
