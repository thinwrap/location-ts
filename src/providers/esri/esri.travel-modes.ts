import { ConnectorError } from '../../types';

/**
 * Canonical ArcGIS World **"Walking Time"** travel-mode object.
 *
 * ArcGIS Network Analyst REST services (`Route/solve`,
 * `ServiceArea/solveServiceArea`, `OriginDestinationCostMatrix/solveODCostMatrix`)
 * require the `travelMode` parameter to be a **full JSON object**, not a name
 * string. Passing a bare `"Walking"` does not select the walking network mode —
 * the service keeps its default (driving) impedance. This is the published World
 * "Walking Time" definition; the wrapper embeds it so a consumer only ever writes
 * the normalized `travelMode: 'walking'`.
 *
 * Setting this object makes the service override its impedance to `WalkTime`, so
 * downstream cost fields come back travel-mode-specific (route summary carries
 * `Total_WalkTime`; the OD matrix reports `costAttributeNames: ['WalkTime', …]`).
 * The per-connector normalizers read those travel-mode-independently.
 *
 * Verified live against `route-api.arcgis.com` on 2026-07-21 for all three
 * operations. Source: ArcGIS REST API Route service `travelMode` reference.
 */
export const ESRI_WALKING_TRAVEL_MODE = {
  attributeParameterValues: [
    {
      parameterName: 'Restriction Usage',
      attributeName: 'Walking',
      value: 'PROHIBITED',
    },
    {
      parameterName: 'Restriction Usage',
      attributeName: 'Preferred for Pedestrians',
      value: 'PREFER_LOW',
    },
    {
      parameterName: 'Walking Speed (km/h)',
      attributeName: 'WalkTime',
      value: 5,
    },
  ],
  description:
    'Follows paths and roads that allow pedestrian traffic and finds solutions that optimize travel time. The walking speed is set to 5 kilometers per hour.',
  impedanceAttributeName: 'WalkTime',
  simplificationToleranceUnits: 'esriMeters',
  uturnAtJunctions: 'esriNFSBAllowBacktrack',
  restrictionAttributeNames: [
    'Avoid Private Roads',
    'Avoid Roads Unsuitable for Pedestrians',
    'Preferred for Pedestrians',
    'Walking',
  ],
  useHierarchy: false,
  simplificationTolerance: 2,
  timeAttributeName: 'WalkTime',
  distanceAttributeName: 'Kilometers',
  type: 'WALK',
  id: 'caFAgoThrvUpkFBW',
  name: 'Walking Time',
} as const;

/**
 * Time-impedance attribute names ESRI reports for the travel modes this wrapper
 * can request. The OD Cost Matrix names its cost columns after the active
 * impedance (`TravelTime` for driving, `WalkTime` for walking), so the matrix
 * decoder locates the time column by trying these in order rather than assuming
 * `'TravelTime'`.
 */
export const ESRI_TIME_ATTRIBUTE_NAMES = ['TravelTime', 'WalkTime'] as const;

/**
 * Translate the normalized `travelMode` to the ESRI wire `travelMode` form value
 * — a JSON-encoded {@link ESRI_WALKING_TRAVEL_MODE} object for `'walking'`, or
 * `undefined` for `'driving'` / unset (the services default to "Driving Time").
 *
 * `'cycling'` throws `unsupported_travel_mode`: ArcGIS World network services
 * ship no public cycling mode, so the wrapper fails fast rather than silently
 * degrading to driving. `op` names the operation for the error message.
 */
export function mapEsriTravelMode(
  mode: 'driving' | 'walking' | 'cycling' | undefined,
  op: string,
): string | undefined {
  switch (mode) {
    case 'walking':
      return JSON.stringify(ESRI_WALKING_TRAVEL_MODE);
    case 'cycling':
      throw new ConnectorError({
        message: `ESRI ${op} does not support travelMode "cycling"`,
        statusCode: null,
        providerCode: 'unsupported_travel_mode',
        providerMessage: `ESRI ${op} does not support travelMode "cycling"`,
      });
    default:
      return undefined;
  }
}
