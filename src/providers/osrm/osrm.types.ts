export interface OsrmRoute {
  geometry: string;
  legs: Array<{
    distance: number;
    duration: number;
  }>;
  distance: number;
  duration: number;
}

export interface OsrmRouteResponse {
  code: string;
  message?: string;
  routes?: OsrmRoute[];
  // The `/trip/v1` service returns its route objects under `trips`, not `routes`.
  trips?: OsrmRoute[];
  waypoints?: Array<{
    waypoint_index: number;
    trips_index?: number;
  }>;
}

export interface OsrmTableResponse {
  code: string;
  durations: (number | null)[][];
  distances?: (number | null)[][];
}
