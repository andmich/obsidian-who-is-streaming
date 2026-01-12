import { requestUrl } from "obsidian";

interface PlexPinResponse {
  id: number;
  code: string;
  authToken?: string | null;
}

interface AuthUrlParams {
  clientIdentifier: string;
  pinCode: string;
  appName: string;
  forwardUrl?: string;
}

interface PollParams {
  pinId: number;
  pinCode: string;
  clientIdentifier: string;
  intervalMs?: number;
  timeoutMs?: number;
  shouldCancel?: () => boolean;
}

export default class PlexApiService {
  private cache: Map<string, { value: unknown; timestamp: number }> = new Map();
  private cacheExpiryMs: number = 5 * 60 * 1000;

  private getCached<T>(key: string): T | null {
    const cached = this.cache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.timestamp > this.cacheExpiryMs) {
      this.cache.delete(key);
      return null;
    }
    return cached.value as T;
  }

  private setCached<T>(key: string, value: T): void {
    this.cache.set(key, { value, timestamp: Date.now() });
  }

  clearCache(): void {
    this.cache.clear();
  }

  async getResources(appName: string, clientIdentifier: string, accessToken: string): Promise<unknown> {
    if (!accessToken) {
      throw new Error("Missing Plex access token");
    }

    const cacheKey = `resources:${clientIdentifier}`;
    const cached = this.getCached<unknown>(cacheKey);
    if (cached) {
      return cached;
    }

    const response = await requestUrl({
      url: "https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1",
      method: "GET",
      headers: {
        accept: "application/json",
        "X-Plex-Product": appName,
        "X-Plex-Client-Identifier": clientIdentifier,
        "X-Plex-Token": accessToken,
      },
    });

    if (response.status !== 200 || !response.json) {
      throw new Error("Failed to fetch Plex resources");
    }

    const data = response.json;
    if (typeof data === "string") {
      try {
        const parsed = JSON.parse(data);
        this.setCached(cacheKey, parsed);
        return parsed;
      } catch {
        this.setCached(cacheKey, data);
        return data;
      }
    }

    this.setCached(cacheKey, data);
    return data;
  }

  async validateToken(appName: string, clientIdentifier: string, accessToken: string): Promise<boolean> {
    if (!accessToken) {
      return false;
    }

    const body = new URLSearchParams({
      "X-Plex-Product": appName,
      "X-Plex-Client-Identifier": clientIdentifier,
      "X-Plex-Token": accessToken,
    }).toString();

    const response = await requestUrl({
      url: "https://plex.tv/api/v2/user",
      method: "GET",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });

    console.log(response);

    return response.status === 200;
  }

  async createPin(appName: string, clientIdentifier: string): Promise<PlexPinResponse> {
    const body = new URLSearchParams({
      strong: "true",
      "X-Plex-Product": appName,
      "X-Plex-Client-Identifier": clientIdentifier,
    }).toString();

    const response = await requestUrl({
      url: "https://plex.tv/api/v2/pins",
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (response.status !== 201 || !response.json) {
      throw new Error("Failed to create Plex PIN");
    }

    return response.json as PlexPinResponse;
  }

  async getLibrarySections(serverUri: string, accessToken: string): Promise<unknown> {
    if (!accessToken) {
      throw new Error("Missing Plex access token");
    }

    const cacheKey = `sections:${serverUri}`;
    const cached = this.getCached<unknown>(cacheKey);
    if (cached) {
      return cached;
    }

    const response = await requestUrl({
      url: `${serverUri}/library/sections`,
      method: "GET",
      headers: {
        accept: "application/json",
        "X-Plex-Token": accessToken,
      },
    });

    if (response.status !== 200 || !response.json) {
      throw new Error("Failed to fetch Plex library sections");
    }

    const data = response.json;
    this.setCached(cacheKey, data);
    return data;
  }

  async getLibraryItems(serverUri: string, sectionKey: string, accessToken: string): Promise<unknown> {
    if (!accessToken) {
      throw new Error("Missing Plex access token");
    }

    const cacheKey = `items:${serverUri}:${sectionKey}`;
    const cached = this.getCached<unknown>(cacheKey);
    if (cached) {
      return cached;
    }

    const response = await requestUrl({
      url: `${serverUri}/library/sections/${sectionKey}/all`,
      method: "GET",
      headers: {
        accept: "application/json",
        "X-Plex-Token": accessToken,
      },
    });

    if (response.status !== 200 || !response.json) {
      throw new Error("Failed to fetch Plex library items");
    }

    const data = response.json;
    this.setCached(cacheKey, data);
    return data;
  }

  buildAuthUrl({ clientIdentifier, pinCode, appName, forwardUrl }: AuthUrlParams): string {
    const params = new URLSearchParams({
      clientID: clientIdentifier,
      code: pinCode,
      "context[device][product]": appName,
    });

    if (forwardUrl) {
      params.set("forwardUrl", forwardUrl);
    }

    return `https://app.plex.tv/auth#?${params.toString()}`;
  }

  async checkPin(pinId: number, pinCode: string, clientIdentifier: string): Promise<PlexPinResponse> {
    const params = new URLSearchParams({
      code: pinCode,
      "X-Plex-Client-Identifier": clientIdentifier,
    });

    const response = await requestUrl({
      url: `https://plex.tv/api/v2/pins/${pinId}?${params.toString()}`,
      method: "GET",
      headers: {
        accept: "application/json",
      },
    });

    if (response.status !== 200 || !response.json) {
      throw new Error("Failed to check Plex PIN");
    }

    return response.json as PlexPinResponse;
  }

  async pollForToken({
    pinId,
    pinCode,
    clientIdentifier,
    intervalMs = 1000,
    timeoutMs = 5 * 60 * 1000,
    shouldCancel,
  }: PollParams): Promise<string | null> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (shouldCancel?.()) {
        return null;
      }

      const pin = await this.checkPin(pinId, pinCode, clientIdentifier);
      if (pin.authToken) {
        return pin.authToken;
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    return null;
  }
}
