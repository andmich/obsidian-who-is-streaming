import { Editor, MarkdownView, Notice, Plugin, TFile, requestUrl } from "obsidian";
import { getAPI, isPluginEnabled } from "obsidian-dataview";
import { match, P } from "ts-pattern";
import { ShowType, Show } from "streaming-availability";
import * as he from "he";
import { WhoIsStreamingSettingsTab } from "./WhoIsStreamingSettingsTab";
import { ShowSelectModal } from "./ShowSelectModal";
import { PreviewSyncModal } from "./PreviewSyncModal";
import { BulkSyncProgressModal } from "./BulkSyncProgressModal";
import StreamingAvailabilityApiService from "./StreamingAvailabilityApiService";
import JellyfinApiService, { JellyfinAvailability } from "./JellyfinApiService";

import PlexApiService from "./PlexApiService";
import { MoviesBasesView, MoviesViewType } from "./MoviesBasesView";
import { WhoIsStreamingSettings, DEFAULT_SETTINGS } from "./settings";

interface DataviewValue {
  path: string;
}

interface StreamingService {
  service: { id: string };
  type: string;
  expiresOn?: number;
  addon?: { name?: string; id?: string };
  link?: string;
}

interface Genre {
  name: string;
}

export default class WhoIsStreamingPlugin extends Plugin {
  settings: WhoIsStreamingSettings;
  streamingAvailabilityApi: StreamingAvailabilityApiService;
  jellyfinApiService: JellyfinApiService;

  plexApiService: PlexApiService;

  async onload() {
    await this.loadSettings();
    this.setupApiClient();
    this.jellyfinApiService = new JellyfinApiService();
    this.plexApiService = new PlexApiService();

    this.addSettingTab(new WhoIsStreamingSettingsTab(this.app, this));

    this.registerBasesView(MoviesViewType, {
      name: "Movies",
      icon: "film",
      factory: (controller, scrollEl) =>
        new MoviesBasesView(controller, scrollEl, this),
        options: MoviesBasesView.getViewOptions,
    });

    const ribbonCommand = this.addRibbonIcon("popcorn", "Who is streaming", async (evt: MouseEvent) => {
        ribbonCommand.setCssProps({ 'pointerEvents': 'none' });
        await this.syncActiveFile();
        ribbonCommand.setCssProps({ 'pointerEvents': '' });
    });
    this.addCommand({ id: "sync", name: "Sync", editorCallback: async (editor: Editor, view: MarkdownView) => {
        await this.syncActiveFile();
    }});
    this.addCommand({ id: "bulk-sync", name: "Bulk sync", callback: async () => {
        await this.syncAllFiles();
    }});

    if (this.settings.jellyfinInstances && this.settings.jellyfinInstances.length > 0) {
      this.addCommand({ id: "bulk-sync-jellyfin", name: "Bulk sync Jellyfin", callback: async () => {
          await this.syncJellyfinForAllFiles();
      }});
      this.addCommand({ id: "sync-jellyfin", name: "Sync Jellyfin", editorCallback: async (editor: Editor, view: MarkdownView) => {
          await this.syncJellyfinActiveFile();
      }});
    }

    const hasEnabledPlexServers = Array.isArray(this.settings.plex?.servers)
      && this.settings.plex.servers.some((server) => server.enabled);

    if (hasEnabledPlexServers) {
      this.addCommand({ id: "bulk-sync-plex", name: "Bulk sync Plex", callback: async () => {
          await this.syncPlexForAllFiles();
      }});
      this.addCommand({ id: "sync-plex", name: "Sync Plex", editorCallback: async (editor: Editor, view: MarkdownView) => {
          await this.syncPlexActiveFile();
      }});
    }
  }

  onunload() {
    this.jellyfinApiService.clearCache();
    this.plexApiService.clearCache();
  }

  async syncActiveFile() {

    if (!this.streamingAvailabilityApi.validateApiKey()) {
      return;
    }

    let loadingNotice: Notice | undefined;

    try {
      const activeFile = this.app.workspace.getActiveFile()!;
      const [tmdb_id, showType] = await this.getTmdbId(activeFile);
      if (tmdb_id && showType) {
        try {
          loadingNotice = new Notice("🔄 Looking up show by ID...", 0);
          const show = await this.streamingAvailabilityApi.getShowByTmdbId(
            showType,
            tmdb_id,
            false
          );

          loadingNotice?.hide();

          if (show) {
            await this.syncFileWithShow(activeFile, show);
            return;
          }
        } catch (error: unknown) {
          loadingNotice?.hide();
          const errorMessage = await this.streamingAvailabilityApi.handleApiError(error, false);
          new Notice(`❌ ${errorMessage || "Error fetching show"}`, 10000);
          return;
        }
      }

      loadingNotice = new Notice(`🔍 Searching for "${activeFile.basename}"...`, 0);
      const results = await this.streamingAvailabilityApi.searchForShowsByTitle(
        activeFile.basename
      );
      loadingNotice?.hide();

      if (results.length === 0) {
        new Notice(`❌ No shows found for "${activeFile.basename}"`, 5000);
        return;
      }

      if (results.length === 1) {
        await this.syncFileWithShow(activeFile, results[0]);
        return;
      }

      new ShowSelectModal(this.app, results, (selectedShow: Show) => {
        void this.syncFileWithShow(activeFile, selectedShow);
      }).open();
    } catch (error: unknown) {
      loadingNotice?.hide();
      new Notice("❌ Failed to sync show. Check console for details.", 5000);
      console.error('Sync failed:', error);
    }
  }

  async syncAllFiles() {
    if (!this.streamingAvailabilityApi.validateApiKey()) {
      return;
    }

    const files = await this.getFilesToSync();
    if (files.length === 0) {
      new Notice("❌ No files to sync");
      return;
    }

    const progressModal = new BulkSyncProgressModal(this.app, files.length);
    progressModal.open();

    for (const file of files) {
      if (progressModal.isCancelled()) {
        new Notice("⚠️ Bulk sync cancelled by user");
        break;
      }

      progressModal.updateProgress(file.basename);

      try {
        const [tmdb_id, showType] = await this.getTmdbId(file);

        if (!tmdb_id || !showType) {
          progressModal.recordFailure(file.basename, "No TMDB id found");
          continue;
        }

        const show = await this.streamingAvailabilityApi.getShowByTmdbId(showType, tmdb_id, false);

        const originalSetting = this.settings.showPreviewDialog;
        this.settings.showPreviewDialog = false;
        await this.syncFileWithShow(file, show, true);
        this.settings.showPreviewDialog = originalSetting;

        progressModal.recordSuccess();
      } catch (error: unknown) {
        const errorMessage = await this.streamingAvailabilityApi.handleApiError(error, false);
        progressModal.recordFailure(file.basename, errorMessage || "Unknown error");
      }
    }

    progressModal.complete();
  }

  async syncJellyfinForAllFiles() {
    if (this.settings.jellyfinInstances.length === 0) {
      new Notice("❌ No Jellyfin instances configured");
      return;
    }
    const findingNotice = new Notice("🔄 Finding files with TMDB id...", 0);

    const allFiles = this.app.vault.getMarkdownFiles();
    const filesWithTmdbId: TFile[] = [];

    for (const file of allFiles) {
      const [tmdb_id] = await this.getTmdbId(file);
      if (tmdb_id) {
        filesWithTmdbId.push(file);
      }
    }

    findingNotice.hide();

    if (filesWithTmdbId.length === 0) {
      new Notice("❌ No files with TMDB id found");
      return;
    }

    const files = filesWithTmdbId;

    const progressModal = new BulkSyncProgressModal(this.app, files.length);
    progressModal.open();

    for (const file of files) {
      if (progressModal.isCancelled()) {
        new Notice("⚠️ Bulk Jellyfin sync cancelled by user");
        break;
      }

      progressModal.updateProgress(file.basename);

      try {
        const [tmdb_id, showType] = await this.getTmdbId(file);

        if (!tmdb_id || !showType) {
          progressModal.recordFailure(file.basename, "No TMDB id found");
          continue;
        }

        const jellyfinAvailability = await this.jellyfinApiService.checkAvailability(
          this.settings.jellyfinInstances,
          tmdb_id,
          showType === "movie" ? "movie" : "series"
        );

        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
          for (const availability of jellyfinAvailability) {
            if (availability.available) {
              frontmatter[availability.instanceName] = "Available";

              if (availability.itemId) {
                const instance = this.settings.jellyfinInstances.find(i => i.name === availability.instanceName);
                if (instance) {
                  const baseUrl = instance.url.replace(/\/+$/, '');
                  const link = `${baseUrl}/web/index.html#!/details?id=${availability.itemId}`;
                  frontmatter[`${availability.instanceName} Link`] = link;
                }
              }
            } else {
              frontmatter[availability.instanceName] = "Not available";
            }
          }

          const isWatched = jellyfinAvailability.some(availability => availability.watched === true);
          if (isWatched) {
            frontmatter["Watched"] = true;
          }
        });

        progressModal.recordSuccess();
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : "Jellyfin sync error";
        progressModal.recordFailure(file.basename, errorMessage);
      }
    }

    progressModal.complete();
  }

  async syncJellyfinActiveFile() {
    if (this.settings.jellyfinInstances.length === 0) {
      new Notice("Γ¥î No Jellyfin instances configured");
      return;
    }

    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice("Γ¥î No active file");
      return;
    }

    try {
      const [tmdb_id, showType] = await this.getTmdbId(activeFile);

      if (!tmdb_id || !showType) {
        new Notice("Γ¥î No TMDB id found in frontmatter");
        return;
      }

      new Notice("≡ƒöä Syncing with Jellyfin...");

      const jellyfinAvailability = await this.jellyfinApiService.checkAvailability(
        this.settings.jellyfinInstances,
        tmdb_id,
        showType === "movie" ? "movie" : "series"
      );

      await this.app.fileManager.processFrontMatter(activeFile, (frontmatter) => {
        for (const availability of jellyfinAvailability) {
          if (availability.available) {
            frontmatter[availability.instanceName] = "Available";

            if (availability.itemId) {
              const instance = this.settings.jellyfinInstances.find(i => i.name === availability.instanceName);
              if (instance) {
                const baseUrl = instance.url.replace(/\/+$/, '');
                const link = `${baseUrl}/web/index.html#!/details?id=${availability.itemId}`;
                frontmatter[`${availability.instanceName} Link`] = link;
              }
            }
          } else {
            frontmatter[availability.instanceName] = "Not available";
          }
        }

        const isWatched = jellyfinAvailability.some(availability => availability.watched === true);
        if (isWatched) {
          frontmatter["Watched"] = true;
        }
      });

      new Notice("Γ£à Jellyfin sync complete");
    } catch (error: unknown) {
      new Notice("Γ¥î Failed to sync with Jellyfin");
      console.error('Jellyfin sync failed:', error);
    }
  }


  async syncPlexForAllFiles() {
    new Notice("Plex sync is not implemented yet.");
  }

  async syncPlexActiveFile() {
    const plexServers = Array.isArray(this.settings.plex?.servers)
      ? this.settings.plex.servers.filter((server) => server.enabled)
      : [];

    if (plexServers.length === 0) {
      new Notice("No Plex servers configured");
      return;
    }

    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice("No active file");
      return;
    }

    try {
      const [, showType] = await this.getTmdbId(activeFile);

      if (!showType) {
        new Notice("No Type found in frontmatter");
        return;
      }

      const frontmatter = await this.getCurrentFrontmatter(activeFile);
      const rawTitleValue = typeof frontmatter["Title"] === "string"
        ? (frontmatter["Title"] as string)
        : typeof frontmatter["title"] === "string"
          ? (frontmatter["title"] as string)
          : activeFile.basename;

      const titleValue = rawTitleValue.replace(/\s*\(\d{4}\)\s*$/, "");

      const yearValue = frontmatter["Year"];
      let year: number | undefined = undefined;
      if (typeof yearValue === "number") {
        year = yearValue;
      } else if (typeof yearValue === "string") {
        const parsed = Number.parseInt(yearValue, 10);
        if (!Number.isNaN(parsed)) {
          year = parsed;
        }
      }

      new Notice("Syncing with Plex...");

      const instances = plexServers.map((server) => ({
        name: server.name,
        uri: server.uri,
        accessToken: server.accessToken,
      }));

      const plexAvailability = await this.plexApiService.checkAvailabilityByTitle(
        instances,
        titleValue,
        year,
        showType === "movie" ? "movie" : "series"
      );

      await this.app.fileManager.processFrontMatter(activeFile, (frontmatter) => {
        for (const availability of plexAvailability) {
          if (availability.available) {
            frontmatter[availability.instanceName] = "Available";

            if (availability.itemId) {
              const instance = plexServers.find((server) => server.name === availability.instanceName);
              if (instance) {
                const baseUrl = instance.uri.replace(/\/+$/, "");
                const key = encodeURIComponent(`/library/metadata/${availability.itemId}`);
                const link = `${baseUrl}/web/index.html#!/details?key=${key}`;
                frontmatter[`${availability.instanceName} Link`] = link;
              }
            }
          } else {
            frontmatter[availability.instanceName] = "Not available";
          }
        }

        const isWatched = plexAvailability.some((availability) => availability.watched === true);
        if (isWatched) {
          frontmatter["Watched"] = true;
        }
      });

      new Notice("Plex sync complete");
    } catch (error: unknown) {
      new Notice("Failed to sync with Plex");
      console.error("Plex sync failed:", error);
    }
  }
  async getFilesToSync(): Promise<TFile[]> {
    if (!isPluginEnabled(this.app) || this.settings.bulkSyncDataviewQuery.length === 0) {
      return this.app.vault.getMarkdownFiles();
    }

    const dataview = getAPI(this.app);
    let dataviewQuery = this.settings.bulkSyncDataviewQuery;
    if (!dataviewQuery.startsWith("LIST")) {
      dataviewQuery = "LIST \n" + dataviewQuery;
    }

    const results = await dataview.query(dataviewQuery);

    if (!results.successful) {
      new Notice("Could not execute query. Please check your Dataview query syntax.");
      return [];
    } else if (results.value.values.length === 0) {
      new Notice("No files matched the dataview query in settings");
      return [];
    }

    return results.value.values.map((value: DataviewValue) =>
      this.app.vault.getFileByPath(value.path)
    ).filter((file): file is TFile => file !== null);
  }

  async syncFileWithShow(file: TFile, selectedShow: Show, isBulkSync: boolean = false): Promise<void> {
    if (!this.settings.showPreviewDialog) {
      await this.performSync(file, selectedShow);
      if (!isBulkSync) {
        new Notice("✅ Successfully synced");
      }
      return;
    }

    const currentFrontmatter = await this.getCurrentFrontmatter(file);
    const result = await new Promise<{ confirmed: boolean; enabledFields?: string[] }>((resolve) => {
      new PreviewSyncModal(
        this.app,
        selectedShow,
        this.settings,
        currentFrontmatter,
        file.basename,
        (confirmed, enabledFields) => resolve({ confirmed, enabledFields })
      ).open();
    });

    if (result.confirmed) {
      await this.performSync(file, selectedShow, result.enabledFields);
      if (!isBulkSync) {
        new Notice("✅ Successfully synced");
      }
    }
  }

  async performSync(file: TFile, selectedShow: Show, enabledFields?: string[]): Promise<void> {
    if (this.settings.posterMode === "local" && (!enabledFields || enabledFields.includes("Poster"))) {
      await this.downloadPoster(selectedShow);
    }

    if (!enabledFields || enabledFields.includes("File Name")) {
      await this.syncFilename(file, selectedShow);
    }

    const tmdbId = selectedShow.tmdbId.split('/').pop() || selectedShow.tmdbId;
    const jellyfinAvailability = await this.jellyfinApiService.checkAvailability(
      this.settings.jellyfinInstances,
      parseInt(tmdbId),
      selectedShow.showType === "movie" ? "movie" : "series"
    );

    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      this.syncFrontMatter(frontmatter, selectedShow, jellyfinAvailability, enabledFields);
    });
  }

  async getCurrentFrontmatter(file: TFile): Promise<Record<string, unknown>> {
    let frontmatter: Record<string, unknown> = {};
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      frontmatter = { ...fm };
    });
    return frontmatter;
  }

  async syncFilename(file: TFile, show: Show): Promise<void> {
    const template = show.showType === "movie"
      ? this.settings.noteNameFormat
      : this.settings.noteNameFormatSeries;

    if (template.length === 0) return;

    const newName = this.applyTemplate(template, show);

    if (file.basename == newName) return;

    const newPath = `${file.parent?.path}/${newName}.md`;
    if (this.app.vault.getFileByPath(newPath) !== null) {
      new Notice(`⚠️ File already exists: ${newName}.md`);
      return;
    }

    await this.app.fileManager.renameFile(file, newPath);
  }

  applyTemplate(template: string, show: Show): string {
    return template
      .replace("${title}", show.title)
      .replace("${year}", (show.releaseYear || show.firstAirYear || "")?.toString())
      .replace("${firstAirYear}", (show.firstAirYear || "")?.toString())
      .replace("${lastAirYear}", (show.lastAirYear || "")?.toString())
      .replace("${tmdb_id}", show.tmdbId.toString())
      .replace("${rating}", show.rating?.toString() || "")
      .replace("${runtime}", show.runtime?.toString() || "")
      .replace(/[/\\?%*:|"<>]/g, "-");
  }

  syncFrontMatter(frontmatter: Record<string, unknown>, selectedShow: Show, jellyfinAvailability: JellyfinAvailability[] = [], enabledFields?: string[]) {
    const isFieldEnabled = (fieldName: string) => !enabledFields || enabledFields.includes(fieldName);

    const showsStreamingServices = (selectedShow.streamingOptions[this.settings.country] || []).filter((service: StreamingService) => {
      return (!service.addon?.id?.startsWith("tvs.sbd") && (service.type === "subscription" ||
          service.type === "addon")
      );
    });

    const tmdbId = selectedShow.tmdbId.split('/').pop() || selectedShow.tmdbId;

    const fieldValues: Record<string, unknown> = {
      "tmdb_id": parseInt(tmdbId),
      "Type": isFieldEnabled("Type") ? selectedShow.showType : undefined,
      "Year": isFieldEnabled("Year") ? (selectedShow.releaseYear || selectedShow.firstAirYear) : undefined,
      "Directors": isFieldEnabled("Directors") ? selectedShow.directors : undefined,
      "Cast": isFieldEnabled("Cast") ? selectedShow.cast : undefined,
      "Overview": isFieldEnabled("Overview") ? he.decode(selectedShow.overview) : undefined,
      "Genres": isFieldEnabled("Genres") ? selectedShow.genres.map((genre: Genre) => genre.name) : undefined,
    };

    if (selectedShow.runtime) {
      fieldValues["Runtime"] = isFieldEnabled("Runtime") ? `${selectedShow.runtime} min` : undefined;
    }
    if (selectedShow.rating) {
      fieldValues["Rating"] = isFieldEnabled("Rating") ? selectedShow.rating : undefined;
    }
    if (selectedShow.seasonCount) {
      fieldValues["Seasons"] = isFieldEnabled("Seasons") ? selectedShow.seasonCount : undefined;
    }
    if (selectedShow.episodeCount) {
      fieldValues["Episodes"] = isFieldEnabled("Episodes") ? selectedShow.episodeCount : undefined;
    }

    if (selectedShow.imageSet?.verticalPoster?.w480) {
      if (isFieldEnabled("Poster")) {
        if (this.settings.posterMode === "local") {
          const posterFilename = `${tmdbId}.jpg`;
          fieldValues["Poster"] = `![[${this.settings.posterFolder}/${posterFilename}]]`;
        } else if (this.settings.posterMode === "remote") {
          fieldValues["Poster"] = selectedShow.imageSet.verticalPoster.w480;
        }
      }
    }

    Object.entries(this.settings.streamingServicesToSync).forEach(([key, streamingServiceToSync]) => {
        const matchedService = showsStreamingServices.find(
          (showsService) => showsService.service.id === streamingServiceToSync.id
        );

        const description = matchedService === undefined
          ? "Not available"
          : match(matchedService)
              .with({ type: "subscription", expiresOn: P._ }, (service) => `Available until ${new Date(service.expiresOn * 1000).toLocaleDateString()}`)
              .with({ type: "subscription" }, () => `Available`)
              .with({ type: "addon" }, (service) => {
                return service.addon?.name ? `Available with ${service.addon.name}` : "Available with addon";
              })
              .otherwise(() => "Not available?" + JSON.stringify(matchedService));

        fieldValues[streamingServiceToSync.name] = isFieldEnabled(streamingServiceToSync.name) ? description : undefined;

        if (this.settings.addStreamingLinks && matchedService?.link) {
          fieldValues[`${streamingServiceToSync.name} Link`] = isFieldEnabled(streamingServiceToSync.name) ? matchedService.link : undefined;
        }
    });

    for (const availability of jellyfinAvailability) {
      const status = availability.available ? "Available" : "Not available";
      fieldValues[availability.instanceName] = isFieldEnabled(availability.instanceName) ? status : undefined;

      if (availability.available && availability.itemId) {
        const instance = this.settings.jellyfinInstances.find(i => i.name === availability.instanceName);
        if (instance && isFieldEnabled(availability.instanceName)) {
          const baseUrl = instance.url.replace(/\/+$/, '');
          const link = `${baseUrl}/web/index.html#!/details?id=${availability.itemId}`;
          fieldValues[`${availability.instanceName} Link`] = link;
        }
      }
    }

    const isWatched = jellyfinAvailability.some(availability => availability.watched === true);
    if (isWatched) {
      fieldValues["Watched"] = true;
    }

    fieldValues["Last Synced"] = new Date().toLocaleString();

    Object.entries(fieldValues).forEach(([key, value]) => {
      if (value !== null && value !== undefined) {
        frontmatter[key] = value;
      }
    });
  }

  async getTmdbId(activeFile: TFile): Promise<[number | undefined, ShowType | undefined]> {
    let tmdb_id: number | undefined = undefined;
    let showType: ShowType | undefined = undefined;

    await this.app.fileManager.processFrontMatter(activeFile, (frontmatter) => {
      if (frontmatter["tmdb_id"]) {
        tmdb_id = frontmatter["tmdb_id"];
      }
      if (frontmatter["Type"]) {
        showType = frontmatter["Type"];
      }
    });

    return [tmdb_id, showType];
  }

  async downloadPoster(show: Show): Promise<void> {
    if (!show.imageSet?.verticalPoster?.w480) {
      return;
    }

    try {
      const folderPath = this.settings.posterFolder;
      if (!await this.app.vault.adapter.exists(folderPath)) {
        await this.app.vault.createFolder(folderPath);
      }

      const tmdbId = show.tmdbId.split('/').pop() || show.tmdbId;
      const posterFilename = `${tmdbId}.jpg`;
      const posterPath = `${folderPath}/${posterFilename}`;

      if (await this.app.vault.adapter.exists(posterPath)) {
        return;
      }

      const response = await requestUrl({
        url: show.imageSet.verticalPoster.w480,
        method: "GET",
      });

      await this.app.vault.adapter.writeBinary(posterPath, response.arrayBuffer);
    } catch (error: unknown) {
      // Silently fail - poster download is optional and shouldn't block sync
      console.debug('Poster download failed:', error);
    }
  }

  setupApiClient() {
    this.streamingAvailabilityApi = new StreamingAvailabilityApiService(this.settings);
  }

  async loadSettings() {
    const loadedData = await this.loadData();
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loadedData,
      plex: {
        ...DEFAULT_SETTINGS.plex,
        ...(loadedData?.plex ?? {}),
      },
    };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
