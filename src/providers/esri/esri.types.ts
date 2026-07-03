export interface EsriRouteFeatureAttributes {
  /** Length in meters when `directionsLengthUnits=esriNAUMeters`. */
  Total_Length?: number;
  /** Travel time in minutes. */
  Total_Time?: number;
  /** Legacy field: brownfield responses report Total_TravelTime in minutes. */
  Total_TravelTime?: number;
  /** Legacy field: brownfield responses report Total_Miles. */
  Total_Miles?: number;
  /** Legacy field: brownfield responses report Total_Kilometers (kilometers). */
  Total_Kilometers?: number;
  /**
   * Reordered input-stop indices when `findBestSequence=true` is requested.
   * Comma-separated list of original waypoint indices (0-based) in the new
   * traversal order. Surface depends on ESRI service version; see
   * `waypointOrder`.
   */
  Stops?: string;
}

export interface EsriDirectionStepAttributes {
  /** Length in meters when `directionsLengthUnits=esriNAUMeters`. */
  length: number;
  /** Time in minutes. */
  time: number;
  /**
   * Maneuver classification. Leg boundaries are delimited by
   * `esriDMTStop` steps.
   */
  maneuverType?: string;
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
  directions?: Array<{
    features: Array<{
      attributes: EsriDirectionStepAttributes;
    }>;
  }>;
  error?: { message: string; code: number };
}

/**
 * ESRI OD Cost Matrix synchronous response.
 *
 * The modern synchronous `solveODCostMatrix` endpoint returns the cost matrix
 * via `odCostMatrix.costMatrix.values` as a 2-D array (rows = origins,
 * cols = destinations). Each cell carries either a single scalar (when only
 * one cost attribute is requested) or a `[Total_Time, Total_Distance]` tuple
 * when both are requested via `outputType=esriNAODOutputSparseMatrix` and
 * `attributeParameterValues` covers both `Total_Time` and `Total_Distance`.
 *
 * `Total_Time` is reported in minutes, `Total_Distance` in meters when
 * `defaultBreaksUnits=esriNAUMinutes`/`outputGeometryPrecision=...` are set
 * with `outSR=4326` — we normalize to seconds + meters in the connector.
 *
 * Legacy synchronous responses (older NAServer revisions) emit a flat
 * `odLines.features[]` FeatureSet; we retain that shape as a fallback to
 * preserve brownfield parity.
 */
export interface EsriODMatrixResponse {
  /** Modern (post-2020) synchronous response shape. */
  odCostMatrix?: {
    costAttributeNames?: string[];
    /**
     * 2-D matrix of cost values. Each cell is either a number (single
     * cost attribute) or a `[time, distance]` tuple (both requested).
     */
    costMatrix: {
      values: Array<Array<number | [number, number]>>;
    };
  };
  /** Legacy synchronous response shape (kept for brownfield parity). */
  odLines?: {
    features: Array<{
      attributes: {
        OriginOID: number;
        DestinationOID: number;
        Total_Time: number; // minutes
        Total_Distance: number; // meters when meters-units requested
      };
    }>;
  };
  error?: { message: string; code: number };
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
