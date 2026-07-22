export interface EsriRouteFeatureAttributes {
  /** Length in meters when `directionsLengthUnits=esriNAUMeters`. */
  Total_Length?: number;
  /** Travel time in minutes. */
  Total_Time?: number;
  /** Driving-mode impedance: total travel time in minutes. */
  Total_TravelTime?: number;
  /** Walking-mode impedance: total walk time in minutes (WALK travel mode). */
  Total_WalkTime?: number;
  /** Legacy field: brownfield responses report Total_Miles. */
  Total_Miles?: number;
  /** Legacy field: brownfield responses report Total_Kilometers (kilometers). */
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
    /**
     * Route-level totals. Travel-mode-independent: `totalLength` is in meters
     * when `directionsLengthUnits=esriNAUMeters`, `totalTime` is in minutes.
     * Preferred over the `Total_*` route attributes, whose names vary by the
     * active impedance (TravelTime vs WalkTime).
     */
    summary?: {
      totalLength?: number;
      totalTime?: number;
      totalDriveTime?: number;
    };
  }>;
  // Returned when `returnStops=true`; features are in INPUT order, each with a
  // 1-based `Sequence` = its position in the optimized route.
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
