export interface OsrmRouteResponse {
  code: string;
  message?: string;
  routes: Array<{
    geometry: string;
    legs: Array<{
      distance: number;
      duration: number;
    }>;
    distance: number;
    duration: number;
  }>;
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
