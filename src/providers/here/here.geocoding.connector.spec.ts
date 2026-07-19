import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HereGeocodingConnector } from './here.geocoding.connector';
import type { HereConfig } from './here.config';
import { ConnectorError } from '../../types';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const defaultConfig: HereConfig = { apiKey: 'test-here-key' };

function buildGeocodeResponse() {
  return new Response(
    JSON.stringify({
      items: [
        {
          title: 'Berlin, Germany',
          address: { label: 'Berlin, Germany' },
          position: { lat: 52.52, lng: 13.405 },
          id: 'here:cm:namedplace:20187403',
          mapView: {
            south: 52.3382,
            west: 13.0884,
            north: 52.6755,
            east: 13.7611,
          },
        },
      ],
    }),
    { status: 200 },
  );
}

function buildAutosuggestResponse() {
  return new Response(
    JSON.stringify({
      items: [
        { title: 'Berlin', id: 'here:ac:1' },
        { title: 'Bern', id: 'here:ac:2' },
      ],
    }),
    { status: 200 },
  );
}

describe('HereGeocodingConnector', () => {
  let connector: HereGeocodingConnector;

  beforeEach(() => {
    connector = new HereGeocodingConnector(defaultConfig);
  });

  it('exposes providerId "here"', () => {
    expect(connector.providerId).toBe('here');
  });

  describe('geocode', () => {
    it('GETs /v1/geocode with q + apiKey', async () => {
      mockFetch.mockResolvedValueOnce(buildGeocodeResponse());

      await connector.geocode({ address: 'Berlin' });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url as string).toContain(
        'https://geocode.search.hereapi.com/v1/geocode',
      );
      expect(url as string).toContain('q=Berlin');
      expect(url as string).toContain('apiKey=test-here-key');
      expect(init?.method).toBe('GET');
    });

    it('normalizes title/position/id/mapView into the base candidate shape', async () => {
      mockFetch.mockResolvedValueOnce(buildGeocodeResponse());

      const result = await connector.geocode({ address: 'Berlin' });

      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]).toEqual({
        formattedAddress: 'Berlin, Germany',
        location: { lat: 52.52, lng: 13.405 },
        placeId: 'here:cm:namedplace:20187403',
        viewport: {
          southwest: { lat: 52.3382, lng: 13.0884 },
          northeast: { lat: 52.6755, lng: 13.7611 },
        },
      });
    });

    it('falls back to address.label when title is absent', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                title: '',
                address: { label: 'Paris, France' },
                position: { lat: 48.857, lng: 2.353 },
                id: 'here:pl:1',
              },
            ],
          }),
          { status: 200 },
        ),
      );

      const result = await connector.geocode({ address: 'Paris' });

      expect(result.candidates[0]!.formattedAddress).toBe('Paris, France');
    });

    describe('countryFilter alpha-2 → alpha-3 translation', () => {
      it('translates US → USA into in=countryCode:USA', async () => {
        mockFetch.mockResolvedValueOnce(buildGeocodeResponse());

        await connector.geocode({
          address: 'Springfield',
          countryFilter: ['US'],
        });

        const [url] = mockFetch.mock.calls[0]!;
        expect(url as string).toContain('in=countryCode%3AUSA');
      });

      it('translates GB → GBR into in=countryCode:GBR', async () => {
        mockFetch.mockResolvedValueOnce(buildGeocodeResponse());

        await connector.geocode({
          address: 'London',
          countryFilter: ['GB'],
        });

        const [url] = mockFetch.mock.calls[0]!;
        expect(url as string).toContain('in=countryCode%3AGBR');
      });

      it('joins multiple codes with comma (US,CA → USA,CAN)', async () => {
        mockFetch.mockResolvedValueOnce(buildGeocodeResponse());

        await connector.geocode({
          address: 'Springfield',
          countryFilter: ['US', 'CA'],
        });

        const [url] = mockFetch.mock.calls[0]!;
        expect(url as string).toContain('in=countryCode%3AUSA%2CCAN');
      });

      // The alpha-2→alpha-3 map now covers all ISO 3166-1 codes (loc-CR #141),
      // so only genuinely non-ISO codes (e.g. user-assigned 'XX') raise.
      it('raises invalid_request for non-ISO alpha-2 codes', async () => {
        await expect(
          connector.geocode({
            address: 'Nowhere',
            countryFilter: ['XX'],
          }),
        ).rejects.toMatchObject({
          name: 'ConnectorError',
          providerCode: 'invalid_request',
        });
        // Vendor was never called.
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('error message directs non-ISO consumers to _passthrough.query.in', async () => {
        const err = await connector
          .geocode({ address: 'x', countryFilter: ['XX'] })
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConnectorError);
        expect((err as ConnectorError).message).toContain(
          '_passthrough.query.in',
        );
      });
    });
  });

  describe('reverseGeocode', () => {
    it('GETs /v1/revgeocode with at param', async () => {
      mockFetch.mockResolvedValueOnce(buildGeocodeResponse());

      const result = await connector.reverseGeocode({
        location: { lat: 52.52, lng: 13.405 },
      });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url as string).toContain(
        'https://revgeocode.search.hereapi.com/v1/revgeocode',
      );
      expect(url as string).toContain('at=52.52%2C13.405');

      // reverse-geocode mirrors forward shape — `candidates[]`.
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]!.formattedAddress).toBe('Berlin, Germany');
      expect(result.candidates[0]!.viewport).toEqual({
        southwest: { lat: 52.3382, lng: 13.0884 },
        northeast: { lat: 52.6755, lng: 13.7611 },
      });
    });
  });

  describe('autocomplete', () => {
    it('GETs /v1/autosuggest with q + limit=10', async () => {
      mockFetch.mockResolvedValueOnce(buildAutosuggestResponse());

      const result = await connector.autocomplete({ input: 'Ber' });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url as string).toContain(
        'https://autosuggest.search.hereapi.com/v1/autosuggest',
      );
      expect(url as string).toContain('q=Ber');
      expect(url as string).toContain('limit=10');

      // title → description, id → placeId.
      expect(result.predictions).toHaveLength(2);
      expect(result.predictions[0]).toEqual({
        description: 'Berlin',
        placeId: 'here:ac:1',
      });
    });

    it('uses at= for proximity bias when only location is set', async () => {
      mockFetch.mockResolvedValueOnce(buildAutosuggestResponse());

      await connector.autocomplete({
        input: 'Ber',
        location: { lat: 52.52, lng: 13.405 },
      });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url as string).toContain('at=52.52%2C13.405');
      expect(url as string).not.toContain('circle');
    });

    it('uses in=circle:<lat>,<lng>;r=<radius> when both location and radius are set', async () => {
      mockFetch.mockResolvedValueOnce(buildAutosuggestResponse());

      await connector.autocomplete({
        input: 'Ber',
        location: { lat: 52.52, lng: 13.405 },
        radius: 5000,
      });

      const [url] = mockFetch.mock.calls[0]!;
      // URL-encoded: `circle:52.52,13.405;r=5000`
      expect(url as string).toContain(
        'in=circle%3A52.52%2C13.405%3Br%3D5000',
      );
      expect(url as string).not.toContain('at=');
    });

    it('passes language as lang query param', async () => {
      mockFetch.mockResolvedValueOnce(buildAutosuggestResponse());

      await connector.autocomplete({ input: 'Ber', language: 'de' });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url as string).toContain('lang=de');
    });
  });

  describe('mapVendorError', () => {
    it('401 → auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ title: 'Unauthorized' }), {
          status: 401,
        }),
      );

      const err = await connector
        .geocode({ address: 'x' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectorError);
      expect((err as ConnectorError).providerCode).toBe('auth_failed');
    });

    it('403 → auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ title: 'Forbidden' }), { status: 403 }),
      );

      const err = await connector
        .geocode({ address: 'x' })
        .catch((e: unknown) => e);
      expect((err as ConnectorError).providerCode).toBe('auth_failed');
    });

    it('400 → invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ title: 'Bad query' }), { status: 400 }),
      );

      const err = await connector
        .geocode({ address: 'x' })
        .catch((e: unknown) => e);
      expect((err as ConnectorError).providerCode).toBe('invalid_request');
    });

    it('429 → rate_limited and surfaces Retry-After in providerMessage + cause.retryAfter', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ title: 'Slow down' }), {
          status: 429,
          headers: { 'Retry-After': '42' },
        }),
      );

      const err = (await connector
        .geocode({ address: 'x' })
        .catch((e: unknown) => e)) as ConnectorError;

      expect(err.providerCode).toBe('rate_limited');
      expect(err.providerMessage).toContain('retry after 42 seconds');
      expect((err.cause as { retryAfter?: string }).retryAfter).toBe('42');
    });

    it('5xx → provider_unavailable', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ title: 'Bang' }), { status: 503 }),
      );

      const err = await connector
        .geocode({ address: 'x' })
        .catch((e: unknown) => e);
      expect((err as ConnectorError).providerCode).toBe(
        'provider_unavailable',
      );
    });
  });

  describe('reverseGeocode non-finite coordinate guard', () => {
    it('rejects a NaN location with ConnectorError invalid_request (no fetch)', async () => {
      await expect(
        connector.reverseGeocode({ location: { lat: Number.NaN, lng: 13.405 } }),
      ).rejects.toMatchObject({
        name: 'ConnectorError',
        providerCode: 'invalid_request',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
