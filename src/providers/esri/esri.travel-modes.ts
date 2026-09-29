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
 * Canonical ArcGIS World **"Walking Distance"** travel-mode object, for distance
 * isochrones.
 *
 * `solveServiceArea` reads `defaultBreaks` in the impedance's units, and a travel
 * mode overrides the request-level `impedanceAttributeName` — so a walking
 * distance isochrone needs a walking mode whose impedance is `Kilometers`, or its
 * kilometer breaks would be read as walk-time minutes. This is Esri's published
 * definition, verbatim (it differs from "Walking Time" in more than the
 * impedance: its own id, description and restriction usages).
 *
 * Source: ArcGIS REST API "Retrieve travel modes" reference.
 */
export const ESRI_WALKING_DISTANCE_TRAVEL_MODE = {
  attributeParameterValues: [
    {
      attributeName: 'Avoid Private Roads',
      parameterName: 'Restriction Usage',
      value: 'AVOID_MEDIUM',
    },
    {
      attributeName: 'Walking',
      parameterName: 'Restriction Usage',
      value: 'PROHIBITED',
    },
    {
      attributeName: 'Preferred for Pedestrians',
      parameterName: 'Restriction Usage',
      value: 'PREFER_LOW',
    },
    {
      attributeName: 'WalkTime',
      parameterName: 'Walking Speed (km/h)',
      value: 5,
    },
    {
      attributeName: 'Avoid Roads Unsuitable for Pedestrians',
      parameterName: 'Restriction Usage',
      value: 'AVOID_HIGH',
    },
  ],
  description:
    'Follows paths and roads that allow pedestrian traffic and finds solutions that optimize travel distance.',
  distanceAttributeName: 'Kilometers',
  id: 'yFuMFwIYblqKEefX',
  impedanceAttributeName: 'Kilometers',
  name: 'Walking Distance',
  restrictionAttributeNames: [
    'Avoid Private Roads',
    'Avoid Roads Unsuitable for Pedestrians',
    'Preferred for Pedestrians',
    'Walking',
  ],
  simplificationTolerance: 2,
  simplificationToleranceUnits: 'esriMeters',
  timeAttributeName: 'WalkTime',
  type: 'WALK',
  useHierarchy: false,
  uturnAtJunctions: 'esriNFSBAllowBacktrack',
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
  const travelMode = esriTravelModeObject(mode, op);
  return travelMode === undefined ? undefined : JSON.stringify(travelMode);
}

/**
 * The `travelMode` and `restrictionAttributeNames` form values for a request
 * carrying the normalized avoid flags as Esri restriction names.
 *
 * Where the request sends a travel mode, the restrictions must go INSIDE it:
 * Esri takes a travel mode's own `restrictionAttributeNames` wholesale and
 * silently ignores the request-level parameter beside it (live: walking +
 * `restrictionAttributeNames=Avoid Ferries` → Esri's warning lists only the
 * mode's "Avoid Private Roads"; the same name appended inside the mode is
 * honoured). The mode's own restrictions are kept — they are what makes it a
 * walking mode — and the result is deduplicated. On the service default
 * (driving, no travel mode sent) the request-level parameter is the one read.
 */
export function esriTravelModeForm(
  mode: 'driving' | 'walking' | 'cycling' | undefined,
  op: string,
  restrictions: readonly string[],
): { travelMode?: string; restrictionAttributeNames?: string } {
  const travelMode = esriTravelModeObject(mode, op);
  if (travelMode === undefined) {
    return restrictions.length > 0
      ? { restrictionAttributeNames: restrictions.join(',') }
      : {};
  }
  if (restrictions.length === 0) return { travelMode: JSON.stringify(travelMode) };
  const names = [...new Set([...travelMode.restrictionAttributeNames, ...restrictions])];
  return { travelMode: JSON.stringify({ ...travelMode, restrictionAttributeNames: names }) };
}

function esriTravelModeObject(
  mode: 'driving' | 'walking' | 'cycling' | undefined,
  op: string,
): typeof ESRI_WALKING_TRAVEL_MODE | undefined {
  switch (mode) {
    case 'walking':
      return ESRI_WALKING_TRAVEL_MODE;
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

/**
 * The time attribute to accumulate so the response carries `Cumul_<attr>` per stop.
 *
 * The cumulative field name is suffixed with the ATTRIBUTE name, and the attribute
 * follows the travel mode's impedance — so driving yields `Cumul_TravelTime` and
 * walking `Cumul_WalkTime` (both verified live). Requesting the wrong one produces
 * no cumulative field at all rather than an error, which is why this mirrors
 * {@link mapEsriTravelMode} exactly: any mode that sends the walking travel-mode
 * JSON must accumulate `WalkTime`, and anything on the service default accumulates
 * `TravelTime`.
 *
 * Keep this in step with `mapEsriTravelMode`. If a truck mode is ever added, its
 * impedance is `TruckTravelTime`.
 */
export function esriTimeAttributeFor(
  mode: 'driving' | 'walking' | 'cycling' | undefined,
): string {
  return mode === 'walking' ? 'WalkTime' : 'TravelTime';
}
