import { describe, it, expect } from 'vitest';
import * as pkg from './index';

describe('public surface', () => {
  it('exports the 4 facades', () => {
    expect(typeof pkg.Routing).toBe('function');
    expect(typeof pkg.Matrix).toBe('function');
    expect(typeof pkg.Geocoding).toBe('function');
    expect(typeof pkg.Isochrone).toBe('function');
  });

  it('exports ConnectorError', () => {
    expect(typeof pkg.ConnectorError).toBe('function');
  });

  it('exports polyline utilities', () => {
    expect(typeof pkg.encodePolyline).toBe('function');
    expect(typeof pkg.decodePolyline).toBe('function');
    expect(typeof pkg.decodeFlexPolyline).toBe('function');
    expect(typeof pkg.encodeEsriPaths).toBe('function');
  });

  it('does not export BaseLocationConnector (deliberate deletion)', () => {
    expect((pkg as Record<string, unknown>).BaseLocationConnector).toBeUndefined();
  });

  it('does not export BaseConnector (internal extension contract per architecture line 1078)', () => {
    expect((pkg as Record<string, unknown>).BaseConnector).toBeUndefined();
  });

  it('exports per-provider connector classes', () => {
    expect(typeof pkg.GoogleRoutingConnector).toBe('function');
    expect(typeof pkg.MapboxRoutingConnector).toBe('function');
    expect(typeof pkg.HereIsochroneConnector).toBe('function');
    expect(typeof pkg.OsrmMatrixConnector).toBe('function');
    expect(typeof pkg.EsriGeocodingConnector).toBe('function');
    expect(typeof pkg.TomTomMatrixConnector).toBe('function');
  });
});
