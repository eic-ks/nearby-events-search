export type PlaceRef = {
  label: string;
  venue?: string;
  address?: string;
  locality?: string;
  region?: string;
  country?: string;
  lat?: number;
  lng?: number;
  source?: string;
};

export declare function mapsSearchUrl(place: PlaceRef): string | null;
export declare function mapsDirectionsUrl(
  destination: PlaceRef,
  options?: { origin?: { lat: number; lng: number }; travelmode?: string },
): string | null;
export declare function mountMap(
  container: HTMLElement,
  options: Record<string, unknown>,
  onUnavailable: () => void,
): { selectPlace?: (index: number) => void; remove?: () => void } | null;
