/**
 * Geometry helpers for drawing, never for analysis: every distance GeoNerva *states* comes from
 * the read models, computed server-side on the WGS84 spheroid. These only draw a ring on a map.
 */

const EARTH_RADIUS_KM = 6371.0088;

/** A closed ring of `steps` points at `radiusKm` around a point, as GeoJSON [lon, lat] pairs. */
export function circleRing(
  lat: number,
  lon: number,
  radiusKm: number,
  steps = 64,
): [number, number][] {
  const angular = radiusKm / EARTH_RADIUS_KM;
  const phi1 = (lat * Math.PI) / 180;
  const lambda1 = (lon * Math.PI) / 180;
  const ring: [number, number][] = [];
  for (let index = 0; index <= steps; index += 1) {
    const bearing = ((index % steps) / steps) * 2 * Math.PI;
    const phi2 = Math.asin(
      Math.sin(phi1) * Math.cos(angular) + Math.cos(phi1) * Math.sin(angular) * Math.cos(bearing),
    );
    const lambda2 =
      lambda1 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angular) * Math.cos(phi1),
        Math.cos(angular) - Math.sin(phi1) * Math.sin(phi2),
      );
    const lonDeg = (((((lambda2 * 180) / Math.PI + 540) % 360) + 360) % 360) - 180;
    ring.push([Number(lonDeg.toFixed(5)), Number(((phi2 * 180) / Math.PI).toFixed(5))]);
  }
  return ring;
}
