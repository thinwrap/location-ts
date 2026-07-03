import { describe, it, expect } from 'vitest';
import type { LatLng } from '../types';
import {
  decodeFlexPolyline,
  decodePolyline,
  encodeEsriPaths,
  encodePolyline,
} from './polyline';

describe('encodePolyline + decodePolyline (Google precision-5)', () => {
  it('encodes Google docs canonical example to expected literal output', () => {
    const coords: LatLng[] = [
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ];
    expect(encodePolyline(coords)).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  });

  it('decodes Google docs canonical example within 5e-5 tolerance', () => {
    const encoded = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
    const expected: LatLng[] = [
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ];
    const decoded = decodePolyline(encoded);
    expect(decoded).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(Math.abs(decoded[i]!.lat - expected[i]!.lat)).toBeLessThan(5e-5);
      expect(Math.abs(decoded[i]!.lng - expected[i]!.lng)).toBeLessThan(5e-5);
    }
  });

  it('round-trips 100 deterministic points within 5e-5 tolerance', () => {
    const coords: LatLng[] = Array.from({ length: 100 }, (_, i) => ({
      lat: ((i * 0.7919) % 180) - 90,
      lng: ((i * 1.3271) % 360) - 180,
    }));
    const encoded = encodePolyline(coords);
    const decoded = decodePolyline(encoded);
    expect(decoded).toHaveLength(coords.length);
    for (let i = 0; i < coords.length; i++) {
      expect(Math.abs(decoded[i]!.lat - coords[i]!.lat)).toBeLessThan(5e-5);
      expect(Math.abs(decoded[i]!.lng - coords[i]!.lng)).toBeLessThan(5e-5);
    }
  });

  it('round-trips an empty array', () => {
    expect(encodePolyline([])).toBe('');
    expect(decodePolyline('')).toEqual([]);
  });

  it('round-trips a single zero point', () => {
    const coords: LatLng[] = [{ lat: 0, lng: 0 }];
    const encoded = encodePolyline(coords);
    expect(encoded).toBe('??');
    const decoded = decodePolyline(encoded);
    expect(decoded).toHaveLength(1);
    expect(Math.abs(decoded[0]!.lat - 0)).toBeLessThan(5e-5);
    expect(Math.abs(decoded[0]!.lng - 0)).toBeLessThan(5e-5);
  });

  it('round-trips antipodal extremes', () => {
    const coords: LatLng[] = [
      { lat: 90, lng: 180 },
      { lat: -90, lng: -180 },
    ];
    const encoded = encodePolyline(coords);
    const decoded = decodePolyline(encoded);
    expect(decoded).toHaveLength(2);
    for (let i = 0; i < coords.length; i++) {
      expect(Math.abs(decoded[i]!.lat - coords[i]!.lat)).toBeLessThan(5e-5);
      expect(Math.abs(decoded[i]!.lng - coords[i]!.lng)).toBeLessThan(5e-5);
    }
  });

  it('round-trips repeated identical points (zero deltas)', () => {
    const coords: LatLng[] = [
      { lat: 1, lng: 1 },
      { lat: 1, lng: 1 },
      { lat: 1, lng: 1 },
    ];
    const encoded = encodePolyline(coords);
    const decoded = decodePolyline(encoded);
    expect(decoded).toHaveLength(3);
    for (let i = 0; i < coords.length; i++) {
      expect(Math.abs(decoded[i]!.lat - coords[i]!.lat)).toBeLessThan(5e-5);
      expect(Math.abs(decoded[i]!.lng - coords[i]!.lng)).toBeLessThan(5e-5);
    }
  });
});

describe('decodeFlexPolyline (HERE flex)', () => {
  it("decodes HERE's canonical reference example to precision-5 lat/lng pairs", () => {
    // Sourced from https://github.com/heremaps/flexible-polyline/blob/master/test/round_half_even.txt
    // The canonical 'BFoz5xJ67i1B1B7PzIhaxL7Y' string encodes 4 precision-5
    // lat/lng pairs (the line in HERE's reference fixture lists exactly 4
    // points; precision-5, third-dimension type ABSENT).
    const encoded = 'BFoz5xJ67i1B1B7PzIhaxL7Y';
    const expected: LatLng[] = [
      { lat: 50.10228, lng: 8.69821 },
      { lat: 50.10201, lng: 8.69567 },
      { lat: 50.10063, lng: 8.6915 },
      { lat: 50.09878, lng: 8.68752 },
    ];
    const decoded = decodeFlexPolyline(encoded);
    expect(decoded).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(Math.abs(decoded[i]!.lat - expected[i]!.lat)).toBeLessThan(5e-5);
      expect(Math.abs(decoded[i]!.lng - expected[i]!.lng)).toBeLessThan(5e-5);
    }
  });

  it('silently drops altitude on a 3D HERE flex-polyline string', () => {
    // Build a 3D flex-polyline fixture locally using the published HERE
    // flexible-polyline encoding primitives, then assert that
    // `decodeFlexPolyline` returns only `{ lat, lng }` (altitude skipped).
    //
    // Header per spec:
    //   value 1 (unsigned varint): format version (must be 1)
    //   value 2 (unsigned varint): precision (low 4 bits)
    //                              | thirdDimType  ((value >> 4) & 0x07)
    //                              | thirdDimPrecision ((value >> 7) & 0x0f)
    // Body deltas use signed (ZigZag) varints.
    const ENCODING_TABLE =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const encodeUnsigned = (value: number): string => {
      let v = value;
      let out = '';
      while (v > 0x1f) {
        out += ENCODING_TABLE[(v & 0x1f) | 0x20]!;
        v >>>= 5;
      }
      out += ENCODING_TABLE[v]!;
      return out;
    };
    const encodeSignedFlex = (value: number): string => {
      const v = value < 0 ? ~(value << 1) >>> 0 : (value << 1) >>> 0;
      return encodeUnsigned(v);
    };

    const precision = 5;
    const thirdDimType = 2; // ALTITUDE
    const thirdDimPrecision = 0;
    const header =
      encodeUnsigned(1) + // format version
      encodeUnsigned(
        (precision & 0x0f) |
          ((thirdDimType & 0x07) << 4) |
          ((thirdDimPrecision & 0x0f) << 7),
      );

    const inputs: Array<[number, number, number]> = [
      [50.10228, 8.69821, 10],
      [50.10201, 8.69567, 20],
      [50.10063, 8.6915, 30],
      [50.09878, 8.68752, 40],
      [50.09745, 8.68526, 50],
    ];
    const factor = 1e5;
    let prevLat = 0;
    let prevLng = 0;
    let prevAlt = 0;
    let body = '';
    for (const [lat, lng, alt] of inputs) {
      const qLat = Math.round(lat * factor);
      const qLng = Math.round(lng * factor);
      const qAlt = Math.round(alt);
      body += encodeSignedFlex(qLat - prevLat);
      body += encodeSignedFlex(qLng - prevLng);
      body += encodeSignedFlex(qAlt - prevAlt);
      prevLat = qLat;
      prevLng = qLng;
      prevAlt = qAlt;
    }

    const encoded3d = header + body;
    const decoded = decodeFlexPolyline(encoded3d);

    expect(decoded).toHaveLength(inputs.length);
    for (let i = 0; i < inputs.length; i++) {
      expect(Math.abs(decoded[i]!.lat - inputs[i]![0])).toBeLessThan(5e-5);
      expect(Math.abs(decoded[i]!.lng - inputs[i]![1])).toBeLessThan(5e-5);
      // Verify the returned LatLng has no altitude leak — only `lat` and `lng`.
      expect(Object.keys(decoded[i]!).sort()).toEqual(['lat', 'lng']);
    }
  });

  it('decodes the smallest valid HERE flex-polyline (header-only, no points)', () => {
    // Header: precision=5, no third dim — same header as the canonical example
    // but with zero point pairs. Encoded as the two header bytes only.
    const encoded = 'BF';
    const decoded = decodeFlexPolyline(encoded);
    expect(decoded).toEqual([]);
  });
});

describe('encodeEsriPaths', () => {
  it('produces canonical ESRI paths geometry with WGS-84 spatial reference', () => {
    const result = encodeEsriPaths([
      [
        { lat: 40, lng: -74 },
        { lat: 41, lng: -73 },
      ],
    ]);
    expect(result).toEqual({
      paths: [
        [
          [-74, 40],
          [-73, 41],
        ],
      ],
      spatialReference: { wkid: 4326 },
    });
  });

  it('preserves multi-path structure and lng-first ordering for each path', () => {
    const result = encodeEsriPaths([
      [
        { lat: 1, lng: 2 },
        { lat: 3, lng: 4 },
      ],
      [
        { lat: 5, lng: 6 },
      ],
      [
        { lat: 7, lng: 8 },
        { lat: 9, lng: 10 },
        { lat: 11, lng: 12 },
      ],
    ]);
    expect(result.paths).toHaveLength(3);
    expect(result.paths[0]).toEqual([
      [2, 1],
      [4, 3],
    ]);
    expect(result.paths[1]).toEqual([[6, 5]]);
    expect(result.paths[2]).toEqual([
      [8, 7],
      [10, 9],
      [12, 11],
    ]);
    expect(result.spatialReference).toEqual({ wkid: 4326 });
  });

  it('returns empty paths array with WGS-84 spatial reference on empty input', () => {
    expect(encodeEsriPaths([])).toEqual({
      paths: [],
      spatialReference: { wkid: 4326 },
    });
  });

  it('preserves an empty inner path', () => {
    expect(encodeEsriPaths([[]])).toEqual({
      paths: [[]],
      spatialReference: { wkid: 4326 },
    });
  });
});

describe('performance gate', () => {
  it('encodes + decodes a 1000-point polyline in under 5ms', () => {
    // If this flakes on a slow CI runner, the 5ms gate is the contract —
    // investigate the regression rather than relaxing the test.
    const coords: LatLng[] = Array.from({ length: 1000 }, (_, i) => ({
      lat: i * 0.001 + 40,
      lng: i * 0.002 - 80,
    }));

    // Warm V8 JIT once to avoid cold-start variance on a single-shot timer.
    encodePolyline(coords.slice(0, 10));
    decodePolyline(encodePolyline(coords.slice(0, 10)));

    const start = performance.now();
    const encoded = encodePolyline(coords);
    const decoded = decodePolyline(encoded);
    const elapsed = performance.now() - start;

    expect(decoded).toHaveLength(coords.length);
    expect(elapsed).toBeLessThan(5);
  });
});
