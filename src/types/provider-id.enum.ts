export const LocationProviderIdEnum = {
  GOOGLE: 'google',
  MAPBOX: 'mapbox',
  HERE: 'here',
  ESRI: 'esri',
  OSRM: 'osrm',
  TOMTOM: 'tomtom',
} as const;

export type LocationProviderId =
  (typeof LocationProviderIdEnum)[keyof typeof LocationProviderIdEnum];
