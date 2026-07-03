import type { LatLng } from '../types';
import { ConnectorError } from '../types';

/**
 * ESRI-JSON `paths` geometry object — the canonical wire shape ArcGIS
 * services accept/return for polyline-style geometry.
 *
 * - `paths`: outer array is paths (parts of a multi-line), middle array is
 *   points within a path, inner is `[lng, lat]` (ESRI's lng-first convention;
 *   the opposite of GeoJSON's lat-first ordering).
 * - `spatialReference`: locked to `{ wkid: 4326 }` (WGS 84 — the only CRS
 *   used by location-ts).
 *
 * Co-located with `encodeEsriPaths` (its sole consumer); not in
 * `src/types/` because there is no cross-module reuse today.
 */
export type EsriPathsGeometry = {
  paths: number[][][];
  spatialReference: { wkid: 4326 };
};

/**
 * Encode an array of LatLng coordinates into a Google-format precision-5 polyline string.
 */
export function encodePolyline(coords: LatLng[]): string {
  let output = '';
  let prevLat = 0;
  let prevLng = 0;

  for (const coord of coords) {
    if (
      !Number.isFinite(coord.lat) ||
      !Number.isFinite(coord.lng)
    ) {
      throw new ConnectorError({
        message: 'Cannot encode polyline: coordinate lat/lng must be finite numbers',
        statusCode: null,
        providerCode: 'invalid_request',
      });
    }
    const lat = Math.round(coord.lat * 1e5);
    const lng = Math.round(coord.lng * 1e5);

    output += encodeSignedValue(lat - prevLat);
    output += encodeSignedValue(lng - prevLng);

    prevLat = lat;
    prevLng = lng;
  }

  return output;
}

/**
 * Decode a Google-format precision-5 polyline string into LatLng coordinates.
 */
export function decodePolyline(encoded: string): LatLng[] {
  const coords: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    const latResult = decodeSignedValue(encoded, index);
    lat += latResult.value;
    index = latResult.index;

    const lngResult = decodeSignedValue(encoded, index);
    lng += lngResult.value;
    index = lngResult.index;

    coords.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }

  return coords;
}

/**
 * Decode a HERE flex-polyline encoded string into LatLng coordinates.
 * Reference: https://github.com/heremaps/flexible-polyline
 */
export function decodeFlexPolyline(encoded: string): LatLng[] {
  const DECODING_TABLE = [
    62, -1, -1, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, -1, -1, -1, -1, -1, -1, -1,
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    22, 23, 24, 25, -1, -1, -1, -1, 63, -1, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
    36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51,
  ];

  // Unsigned varint decoder — used for the header values per the HERE spec.
  const decodeUnsigned = (idx: number): { value: number; index: number } => {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      if (idx >= encoded.length) {
        throw new ConnectorError({
          message: 'Malformed polyline',
          statusCode: null,
          providerCode: 'unknown',
        });
      }
      const decoded = DECODING_TABLE[encoded.charCodeAt(idx) - 45];
      if (decoded === undefined || decoded === -1) {
        throw new ConnectorError({
          message: 'Malformed polyline',
          statusCode: null,
          providerCode: 'unknown',
        });
      }
      b = decoded;
      idx++;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return { value: result, index: idx };
  };

  // Signed (ZigZag) varint decoder — used for the lat/lng/alt body deltas.
  const decode = (idx: number): { value: number; index: number } => {
    const r = decodeUnsigned(idx);
    return { value: r.value & 1 ? ~(r.value >> 1) : r.value >> 1, index: r.index };
  };

  // Header per https://github.com/heremaps/flexible-polyline:
  //   value 1 → format version (always 1 in v1)
  //   value 2 → (thirdDimType << 4) | precision
  //             plus a continuation/precision-3D byte encoded in the same varint.
  // Both header values are unsigned varints.
  let idx = 0;
  const headerVersion = decodeUnsigned(idx);
  idx = headerVersion.index;
  void headerVersion.value;

  const header2 = decodeUnsigned(idx);
  idx = header2.index;
  const precision = header2.value & 0x0f;
  const hasThirdDim = (header2.value >> 4) & 0x07;
  // thirdDimPrecision = (header2.value >> 7) & 0x0f — not surfaced; altitude is skipped.

  const factor = Math.pow(10, precision);
  const coords: LatLng[] = [];
  let lat = 0;
  let lng = 0;

  while (idx < encoded.length) {
    const latR = decode(idx);
    lat += latR.value;
    idx = latR.index;

    const lngR = decode(idx);
    lng += lngR.value;
    idx = lngR.index;

    if (hasThirdDim) {
      const altR = decode(idx);
      idx = altR.index;
      // We skip altitude
      void altR.value;
    }

    coords.push({ lat: lat / factor, lng: lng / factor });
  }

  return coords;
}

/**
 * Convert an array of LatLng-coordinate paths into an ESRI-JSON `paths` geometry object.
 *
 * Each inner `LatLng` becomes an ESRI `[lng, lat]` pair (ESRI's lng-first
 * convention; opposite of GeoJSON). The `spatialReference` is fixed at
 * `{ wkid: 4326 }` (WGS 84 — the only CRS used in location-ts).
 *
 * Use this when constructing ArcGIS-bound geometry payloads from
 * thinwrap-normalized `LatLng` coordinates.
 */
export function encodeEsriPaths(paths: LatLng[][]): EsriPathsGeometry {
  return {
    paths: paths.map((path) => path.map((point) => [point.lng, point.lat])),
    spatialReference: { wkid: 4326 },
  };
}

function encodeSignedValue(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let output = '';
  while (v >= 0x20) {
    output += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  output += String.fromCharCode(v + 63);
  return output;
}

function decodeSignedValue(
  encoded: string,
  index: number
): { value: number; index: number } {
  let result = 0;
  let shift = 0;
  let b: number;
  do {
    if (index >= encoded.length) {
      throw new ConnectorError({
        message: 'Malformed polyline',
        statusCode: null,
        providerCode: 'unknown',
      });
    }
    b = encoded.charCodeAt(index) - 63;
    if (b < 0) {
      throw new ConnectorError({
        message: 'Malformed polyline',
        statusCode: null,
        providerCode: 'unknown',
      });
    }
    index++;
    result |= (b & 0x1f) << shift;
    shift += 5;
  } while (b >= 0x20);
  return { value: result & 1 ? ~(result >> 1) : result >> 1, index };
}
