export interface Passthrough {
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}
