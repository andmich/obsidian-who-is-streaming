import { requestUrl } from "obsidian";

interface PlexPinResponse {
  id: number;
  code: string;
  authToken?: string | null;
}

interface PlexGuid {
  id?: string;
}

export interface PlexItem {
  ratingKey?: string | number;
  guid?: string;
  Guid?: PlexGuid[];
  title?: string;
  year?: number;
  type?: string;
  viewCount?: number;
  viewedAt?: number;
  lastViewedAt?: number;
}

interface PlexLibrarySection {
  key?: string | number;
  type?: string;
}

export interface PlexAvailability {
  instanceName: string;
  available: boolean;
  itemId?: string;
  watched?: boolean;
}

export interface PlexInstance {
  name: string;
  uri: string;
  accessToken: string;
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

  private normalizeServerUri(serverUri: string): string {
    return serverUri.replace(/\/+$/, "");
  }

  private extractTmdbIdFromGuid(guid: string): string | null {
    const matches = guid.match(/themoviedb:\/\/(\d+)/i) || guid.match(/tmdb:\/\/(\d+)/i);
    return matches ? matches[1] : null;
  }

  private getTmdbIdFromItem(item: PlexItem): string | null {
    const guidCandidates: string[] = [];

    if (typeof item.guid === "string") {
      guidCandidates.push(item.guid);
    }

    if (Array.isArray(item.Guid)) {
      item.Guid.forEach((guid) => {
        if (typeof guid?.id === "string") {
          guidCandidates.push(guid.id);
        }
      });
    }

    for (const guid of guidCandidates) {
      const tmdbId = this.extractTmdbIdFromGuid(guid);
      if (tmdbId) {
        return tmdbId;
      }
    }

    return null;
  }

  private extractSections(response: unknown): PlexLibrarySection[] {
    const container = (response as { MediaContainer?: { Directory?: PlexLibrarySection[] } })?.MediaContainer;
    return Array.isArray(container?.Directory) ? container.Directory : [];
  }

  private extractItems(response: unknown): PlexItem[] {
    const container = (response as { MediaContainer?: { Metadata?: PlexItem[] } })?.MediaContainer;
    return Array.isArray(container?.Metadata) ? container.Metadata : [];
  }

  private normalizeTitle(title: string): string {
    return title.trim().toLowerCase();
  }

  private matchesTitle(item: PlexItem, title: string, year?: number): boolean {
    if (!item.title) {
      return false;
    }

    if (this.normalizeTitle(item.title) !== this.normalizeTitle(title)) {
      return false;
    }

    if (typeof year === "number") {
      if (typeof item.year !== "number") {
        return false;
      }
      if (item.year !== year) {
        return false;
      }
    }

    return true;
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

  async getLibraryItems(serverUri: string, sectionKey: string, accessToken: string, itemType?: "movie" | "show"): Promise<unknown> {
    if (!accessToken) {
      throw new Error("Missing Plex access token");
    }

    const cacheKey = `items:${serverUri}:${sectionKey}:${itemType ?? "all"}`;
    const cached = this.getCached<unknown>(cacheKey);
    if (cached) {
      return cached;
    }

    const url = new URL(`${serverUri}/library/sections/${sectionKey}/all`);
    url.searchParams.set("includeGuids", "1");
    if (itemType === "movie") {
      url.searchParams.set("type", "1");
    } else if (itemType === "show") {
      url.searchParams.set("type", "2");
    }

    const response = await requestUrl({
      url: url.toString(),
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

  async getLibraryItemsByTitleYear(serverUri: string, sectionKey: string, accessToken: string, title: string, year?: number, itemType?: "movie" | "show"): Promise<unknown> {
    if (!accessToken) {
      throw new Error("Missing Plex access token");
    }

    const cacheKey = `items:${serverUri}:${sectionKey}:${itemType ?? "all"}:${title}:${year ?? "any"}`;
    const cached = this.getCached<unknown>(cacheKey);
    if (cached) {

      console.log('cached');
      return cached;
    }

    const url = new URL(`${serverUri}/library/sections/${sectionKey}/all`);
    url.searchParams.set("title", title);
    if (typeof year === "number") {
      url.searchParams.set("year", year.toString());
    }
    if (itemType === "movie") {
      url.searchParams.set("type", "1");
    } else if (itemType === "show") {
      url.searchParams.set("type", "2");
    }

    const response = await requestUrl({
      url: url.toString(),
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

  async findByTitleAndYear(instance: PlexInstance, title: string, year: number | undefined, showType: "movie" | "series"): Promise<{ available: boolean; itemId?: string; watched?: boolean }> {
    try {
      const baseUrl = this.normalizeServerUri(instance.uri);
      const itemType = showType === "movie" ? "movie" : "show";

      const sectionsResponse = await this.getLibrarySections(baseUrl, instance.accessToken);
      const sections = this.extractSections(sectionsResponse).filter((section) => section.type === itemType);

      if (sections.length === 0) {
        return { available: false };
      }

      for (const section of sections) {
        if (!section.key) {
          continue;
        }
        
        const itemsResponse = await this.getLibraryItemsByTitleYear(
          baseUrl,
          section.key.toString(),
          instance.accessToken,
          title,
          year,
          itemType
        );

        console.log("Items Response: ", itemsResponse)

        const items = this.extractItems(itemsResponse);

        console.log("Items Extracted: ", items);
        const matchingItem = items.find((item) => this.matchesTitle(item, title, year));

        if (matchingItem) {
          const watched = (matchingItem.viewCount ?? 0) > 0 || Boolean(matchingItem.viewedAt || matchingItem.lastViewedAt);
          return {
            available: true,
            itemId: matchingItem.ratingKey?.toString(),
            watched,
          };
        }
      }

      return { available: false };
    } catch {
      return { available: false };
    }
  }

  async checkAvailabilityByTitle(instances: PlexInstance[], title: string, year: number | undefined, showType: "movie" | "series"): Promise<PlexAvailability[]> {
    const results = await Promise.all(
      instances.map(async (instance) => {
        const result = await this.findByTitleAndYear(instance, title, year, showType);
        return {
          instanceName: instance.name,
          available: result.available,
          itemId: result.itemId,
          watched: result.watched,
        };
      })
    );

    return results;
  }

  async isAvailableInPlex(instance: PlexInstance, tmdbId: number, showType: "movie" | "series"): Promise<{ available: boolean; itemId?: string; watched?: boolean }> {
    try {
      const baseUrl = this.normalizeServerUri(instance.uri);
      const itemType = showType === "movie" ? "movie" : "show";

      const sectionsResponse = await this.getLibrarySections(baseUrl, instance.accessToken);
      const sections = this.extractSections(sectionsResponse).filter((section) => section.type === itemType);

      if (sections.length === 0) {
        return { available: false };
      }

      const tmdbIdString = tmdbId.toString();

      for (const section of sections) {
        if (!section.key) {
          continue;
        }

        const itemsResponse = await this.getLibraryItems(
          baseUrl,
          section.key.toString(),
          instance.accessToken,
          itemType
        );

        console.log("Items: ", itemsResponse);

        const items = this.extractItems(itemsResponse);

        console.log("Items Extracted: ", items);
        
        const matchingItem = items.find((item) => this.getTmdbIdFromItem(item) === tmdbIdString);

        if (matchingItem) {
          const watched = (matchingItem.viewCount ?? 0) > 0 || Boolean(matchingItem.viewedAt || matchingItem.lastViewedAt);
          return {
            available: true,
            itemId: matchingItem.ratingKey?.toString(),
            watched,
          };
        }
      }

      return { available: false };
    } catch {
      return { available: false };
    }
  }

  async checkAvailability(instances: PlexInstance[], tmdbId: number, showType: "movie" | "series"): Promise<PlexAvailability[]> {
    const results = await Promise.all(
      instances.map(async (instance) => {
        const result = await this.isAvailableInPlex(instance, tmdbId, showType);

        console.log("Result: ", result);

        return {
          instanceName: instance.name,
          available: result.available,
          itemId: result.itemId,
          watched: result.watched,
        };
      })
    );

    return results;
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
