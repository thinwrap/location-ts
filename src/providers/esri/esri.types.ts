export interface EsriRouteFeatureAttributes {
  /**
   * Total length in meters. Not emitted by the public World/Route service in
   * either driving or walking mode (verified live) — the distance attribute is
   * suffixed instead, e.g. `Total_Kilometers`. Read only as a fallback.
   */
  Total_Length?: number;
  /** Travel time in minutes. */
  Total_Time?: number;
  /** Driving-mode impedance: total travel time in minutes. */
  Total_TravelTime?: number;
  /** Walking-mode impedance: total walk time in minutes (WALK travel mode). */
  Total_WalkTime?: number;
  /** Legacy distance attribute, in miles; superseded by `Total_Length`. */
  Total_Miles?: number;
  /** Legacy distance attribute, in kilometers; superseded by `Total_Length`. */
  Total_Kilometers?: number;
}

/**
 * Attributes on each feature of the `stops` FeatureSet (returned when
 * `returnStops=true`). `Sequence` is the 1-based position of that stop in the
 * optimized route when `findBestSequence=true` was requested; the stop features
 * are returned in INPUT order.
 */
export interface EsriStopFeatureAttributes {
  Sequence?: number;
  Name?: string;
  ObjectID?: number;

  /**
   * Status of locating this stop on the network. `0` is OK; the documented
   * non-zero codes include `1` (Not Located), `5` (Not Reached) and `7` (Not
   * located on closest). A non-zero status means the `Cumul_*` values below may
   * be absent.
   */
  Status?: number;

  /**
   * Snap distance: metres between the requested coordinate and where it was located
   * on the network. Not read by any normalized field — a coordinate far from any
   * road still yields a well-formed route, so this is the only signal that it
   * happened. The acceptable threshold is application policy, so it is documented in
   * the connector README rather than enforced here.
   */
  DistanceToNetworkInMeters?: number;

  /**
   * Cumulative cost from the origin **to and including this stop**, one field per
   * accumulated attribute. The suffix is the attribute name, so the key is
   * impedance-dependent: `Cumul_TravelTime` driving, `Cumul_WalkTime` walking.
   */
  [cumulativeField: `Cumul_${string}`]: number | undefined;
}

export interface EsriRouteResponse {
  routes: {
    features: Array<{
      attributes: EsriRouteFeatureAttributes;
      geometry: {
        paths: number[][][]; // [[[lng,lat], ...]]
      };
    }>;
  };
  stops?: {
    features: Array<{
      attributes: EsriStopFeatureAttributes;
    }>;
  };
  error?: { message: string; code: number };
}

/**
 * ESRI OD Cost Matrix synchronous response.
 *
 * With `outputType=esriNAODOutputSparseMatrix` the `solveODCostMatrix` endpoint
 * returns `odCostMatrix` as a sparse object: a `costAttributeNames` array
 * naming the per-cell value order, plus one key per 1-based **origin OID**
 * mapping a 1-based **destination OID** to an array of cost values in
 * `costAttributeNames` order. With `impedanceAttributeName=TravelTime` +
 * `accumulateAttributeNames=Kilometers` each cell array is
 * `[TravelTime(minutes), Kilometers(km)]`.
 *
 * With `outputType=esriNAODOutputStraightLines` the service instead returns an
 * `odLines.features[]` FeatureSet whose attributes carry `OriginID` /
 * `DestinationID` (1-based) plus `Total_TravelTime` (minutes) and
 * `Total_Kilometers` (km). Retained as a fallback path.
 *
 * The connector normalizes minutes → seconds (×60) and kilometers → meters
 * (×1000).
 */
export interface EsriODMatrixResponse {
  /** Sparse-matrix response shape (`esriNAODOutputSparseMatrix`). */
  odCostMatrix?: EsriODCostMatrix;
  /** Straight-lines response shape (`esriNAODOutputStraightLines`) — fallback. */
  odLines?: {
    features: Array<{
      attributes: {
        OriginID: number;
        DestinationID: number;
        Total_TravelTime: number; // minutes
        Total_Kilometers: number; // kilometers
      };
    }>;
  };
  error?: { message: string; code: number };
}

/**
 * Sparse `odCostMatrix` payload. `costAttributeNames` names the order of the
 * numbers in each cell array; every **other** key is a 1-based origin OID
 * (string) whose value maps a 1-based destination OID (string) to the cell's
 * cost values.
 */
export interface EsriODCostMatrix {
  costAttributeNames?: string[];
  [originOID: string]: string[] | Record<string, number[]> | undefined;
}

export interface EsriGeocodeResponse {
  candidates: Array<{
    address: string;
    location: { x: number; y: number };
    /**
     * ESRI bounding box (Web Mercator extent) returned for forward-geocode
     * candidates when `outFields=*` is requested. Mapped to
     * the unified `viewport: { southwest, northeast }` shape.
     */
    extent?: {
      xmin: number;
      ymin: number;
      xmax: number;
      ymax: number;
    };
    attributes?: { UniqueID?: string } & Record<string, unknown>;
  }>;
  error?: { message: string; code: number };
}

export interface EsriReverseGeocodeResponse {
  /**
   * ESRI reverse-geocode surfaces the matched address as a free-form object
   * with both `LongLabel` (full formatted) and `Match_addr` (concise) keys.
   * Field availability varies by service version; prefers
   * `LongLabel` and falls back to `Match_addr`.
   */
  address?: {
    LongLabel?: string;
    Match_addr?: string;
  } & Record<string, unknown>;
  location?: { x: number; y: number };
  error?: { message: string; code: number };
}

export interface EsriSuggestResponse {
  suggestions: Array<{
    text: string;
    /**
     * ESRI's per-suggestion resolution token. Used as `placeId` in the
     * unified autocomplete prediction shape — the
     * "most stable per-result identifier" convention from the architecture.
     */
    magicKey: string;
    isCollection: boolean;
  }>;
  error?: { message: string; code: number };
}

export interface EsriServiceAreaResponse {
  saPolygons: {
    features: Array<{
      attributes: {
        FromBreak: number;
        ToBreak: number;
      };
      geometry: {
        rings: number[][][]; // [[[lng,lat], ...]]
      };
    }>;
  };
  error?: { message: string; code: number };
}
